// HTTP surface for the Live Room Coordinator (spec: "HTTP surface").
// Read, social, and evidence archival only. There is NO trading endpoint, because there is no
// trading path through this tier: a Forecaster's transaction goes from their
// own wallet to the market contract.
//
// Transport: JSON over HTTP plus Server-Sent Events for the room stream.
// SSE is the fallback the spec names and is native in browsers; the same
// RealtimeEdge core serves a WebSocket upgrade when one is added.

import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { renderMetrics, PROMETHEUS_CONTENT_TYPE } from "../observability/exporter.mjs";
import { foldMetrics } from "../domain/conditions.mjs";

// The website sends `x-tm-address` so the API can apply the allowlist. That is
// a non-simple header, so every such request is preceded by a preflight — and a
// preflight that does not name the header is a refusal. Anonymous reads would
// keep working while every personalised surface failed with a bare network
// error, which is the worst possible way for this to break.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-tm-address, x-tm-oracle-token, range",
  "access-control-max-age": "600",
};

const JSON_HEADERS = { "content-type": "application/json", ...CORS_HEADERS };

/** Nothing this API accepts is large. A cap keeps an open POST from growing the heap. */
const MAX_BODY_BYTES = 64 * 1024;

function serialize(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

export class RoomApiServer {
  /**
   * @param options.coordinator LiveRoomCoordinator
   * @param options.edge        RealtimeEdge
   * @param options.chat        ChatService
   * @param options.playback    PlaybackService
   * @param options.store       ProjectionStore
   * @param options.eventLog    EventStore (Session Event Log)
   * @param options.settlement  SettlementService (issue 11)
   * @param options.allowlist   Allowlist (issue 17) or null
   */
  constructor({
    coordinator,
    edge,
    chat,
    playback,
    store,
    eventLog,
    settlement = null,
    allowlist = null,
    capabilities = null,
    entry = null,
    help = null,
    activity = null,
    schedule = null,
    leaderboard = null,
    portfolio = null,
    growth = null,
    configWarning = () => null,
    // One runtime per room this process serves. The single-room form is the
    // same thing with one entry.
    rooms = null,
    // A snapshot of this process's real state, for the metrics endpoint.
    metricsSnapshot = null,
    // What the separate authority processes have reported about themselves.
    operators = null,
    // Whether this replica currently leads anything, so a standby is
    // distinguishable from a leader without reading /metrics.
    leading = null,
    // Evidence storage only. It has no wallet and cannot decide a result.
    oracle = null,
    oracleToken = null,
    oracleChallengeVerifier = null,
  }) {
    this.coordinator = coordinator;
    this.edge = edge;
    this.chat = chat;
    this.playback = playback;
    this.store = store;
    this.eventLog = eventLog;
    this.settlement = settlement;
    this.operators = operators;
    this.leading = leading;
    this.oracle = oracle;
    this.oracleToken = oracleToken;
    this.oracleChallengeVerifier = oracleChallengeVerifier;
    this.allowlist = allowlist;
    this.capabilities = capabilities;
    this.entry = entry;
    this.help = help;
    this.activity = activity;
    this.schedule = schedule;
    this.leaderboard = leaderboard;
    this.portfolio = portfolio;
    this.growth = growth;
    this.configWarning = configWarning;
    this.rooms = rooms ?? new Map([[coordinator?.roomId, { coordinator, edge, chat, playback }]]);
    this.metricsSnapshot = metricsSnapshot;
    // The callback discards the returned promise, so anything that throws
    // inside `handle` becomes an unhandled rejection — and Node terminates the
    // process on one of those. A single malformed POST from any web page must
    // not be able to take the Coordinator down.
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error) => this._fail(response, error));
    });
  }

  listen(port = 0) {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", () => resolve(this.server.address())));
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  async handle(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "OPTIONS") return this._send(response, 204, "", CORS_HEADERS);

    // These stay reachable without an allowlisted address: a person who cannot
    // enter must still be able to read why, what this software is, and the help
    // and legal pages that explain it. Gating the explanation of the gate would
    // leave someone stuck with no way to understand their own situation.
    if (path === "/v1/health") return this._json(response, 200, await this._health());
    // Unauthenticated on purpose: everything here is operational shape — block
    // numbers, health states, counts — and none of it is anyone's data. An
    // operator can still put it behind their own ingress.
    if (path === "/metrics" && this.metricsSnapshot) {
      return this._send(response, 200, renderMetrics(await this.metricsSnapshot()), {
        "content-type": PROMETHEUS_CONTENT_TYPE,
        ...CORS_HEADERS,
      });
    }
    if (path === "/v1/capabilities") {
      return this._json(response, 200, this.capabilities ? this.capabilities.publicSnapshot() : { capabilities: {} });
    }
    if (path === "/v1/entry/terms" && this.entry) return this._json(response, 200, this.entry.terms());
    if (path === "/v1/entry/status" && this.entry) {
      return this._json(response, 200, await this.entry.status(url.searchParams.get("address")));
    }
    if (path === "/v1/entry/accept" && this.entry && request.method === "POST") {
      const body = await this._body(request);
      const result = await this.entry.accept(body);
      return this._json(response, result.accepted ? 200 : 400, result);
    }
    if (path === "/v1/help" && this.help) {
      const query = url.searchParams.get("q");
      return this._json(response, 200, query ? this.help.search(query) : this.help.list());
    }
    const helpArticle = /^\/v1\/help\/([a-z0-9-]+)$/.exec(path);
    if (helpArticle && this.help) {
      const article = this.help.article(helpArticle[1]);
      return article
        ? this._json(response, 200, article)
        : this._json(response, 404, { error: "no such article" });
    }

    // Livestream resolution evidence is public by design. A Forecaster must be
    // able to inspect the exact clip and canonical bundle before deciding
    // whether to challenge, even when the rest of this interface is gated.
    // Creating evidence is operator-only, but still does not submit anything
    // on chain: two independent resolver wallets do that in the browser.
    if (path === "/v1/oracle/proofs" && request.method === "POST") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      if (!this.oracleToken) {
        return this._json(response, 503, { error: "livestream evidence operator authentication is not configured" });
      }
      if (!this._oracleAuthorized(request)) return this._json(response, 401, { error: "invalid oracle operator token" });
      const proof = await this.oracle.record({
        body: request,
        metadata: {
          market: url.searchParams.get("market"),
          outcome: url.searchParams.get("outcome"),
          sourceSequence: url.searchParams.get("source_sequence"),
          streamUrl: url.searchParams.get("stream_url"),
          occurredAt: url.searchParams.get("occurred_at"),
          clipStartMs: url.searchParams.get("clip_start_ms"),
          clipEndMs: url.searchParams.get("clip_end_ms"),
          rule: url.searchParams.get("rule"),
          rationale: url.searchParams.get("rationale"),
          contentType: request.headers["content-type"],
        },
      });
      return this._json(response, 201, proof);
    }
    if (path === "/v1/oracle/challenges" && request.method === "POST") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      if (!this.oracleChallengeVerifier) {
        return this._json(response, 503, { error: "on-chain challenge verification is not configured" });
      }
      const body = await this._body(request);
      const verification = await this.oracleChallengeVerifier({
        market: body.market,
        evidenceHash: body.evidence_hash,
        transactionHash: body.transaction_hash,
      });
      if (!verification?.verified) {
        return this._json(response, 400, { error: verification?.reason ?? "transaction is not a confirmed challenge" });
      }
      const challenge = await this.oracle.registerChallenge({
        market: body.market,
        evidence: body.evidence,
        evidenceHash: body.evidence_hash,
        transactionHash: body.transaction_hash,
        challenger: verification.challenger,
      });
      return this._json(response, 201, challenge);
    }
    const oracleChallenge = /^\/v1\/oracle\/markets\/(0x[0-9a-fA-F]{40})\/challenge$/.exec(path);
    if (oracleChallenge && request.method === "GET") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      // 200 with nothing, not 404. "Does this market have registered counter-
      // evidence?" is a valid question about a real market and "no" is a
      // complete answer; 404 would mean this build cannot answer at all. The
      // difference is not pedantry: the interface polls this for every market
      // for its whole pre-resolution life, and a 404 put a console error in
      // every browser on every cycle, which is precisely where a real oracle
      // failure would have had to stand out.
      const challenge = await this.oracle.challengeForMarket(oracleChallenge[1]);
      return this._json(response, 200, challenge ?? null);
    }
    const oracleMarket = /^\/v1\/oracle\/markets\/(0x[0-9a-fA-F]{40})$/.exec(path);
    if (oracleMarket && request.method === "GET") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      // Same reasoning as the challenge route above: no evidence yet is an
      // answer, not an absence of resource.
      const proof = await this.oracle.latestForMarket(oracleMarket[1]);
      return this._json(response, 200, proof ?? null);
    }
    const oracleEvidence = /^\/v1\/oracle\/evidence\/(0x[0-9a-fA-F]{64})$/.exec(path);
    if (oracleEvidence && request.method === "GET") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      const proof = await this.oracle.byEvidenceHash(oracleEvidence[1]);
      return proof ? this._json(response, 200, proof) : this._json(response, 404, { error: "unknown evidence hash" });
    }
    const oracleVideo = /^\/v1\/oracle\/proofs\/([0-9a-f-]+)\/video$/.exec(path);
    if (oracleVideo && request.method === "GET") {
      if (!this.oracle) return this._json(response, 503, { error: "livestream evidence storage is not configured" });
      const video = await this.oracle.video(oracleVideo[1]);
      return video ? this._video(response, request, video) : this._json(response, 404, { error: "unknown proof clip" });
    }

    if (this.allowlist) {
      const address = request.headers["x-tm-address"] ?? url.searchParams.get("address");
      const verdict = await this.allowlist.check(address);
      if (!verdict.allowed) return this._json(response, 403, verdict);
    }

    try {
      if (path === "/v1/activity" && this.activity) {
        return this._json(response, 200, {
          resolutions: this.activity.recentResolutions(),
          credits: this.activity.recentCredits(),
        });
      }
      const activityDetail = /^\/v1\/activity\/([^/]+)$/.exec(path);
      if (activityDetail && this.activity) {
        const market = activityDetail[1];
        const row = this.store.getMarket(market);
        if (!row) return this._json(response, 404, { error: "unknown market" });
        return this._json(response, 200, {
          market,
          timeline: this.activity.timeline(market),
          settlement: await this.activity.record(market),
          claims: this.store.listClaims().filter((claim) => String(claim.market_address).toLowerCase() === market.toLowerCase()),
          attestations: this.store.listAttestations(market),
        });
      }
      if (path === "/v1/schedule" && this.schedule) {
        return this._json(response, 200, this.schedule.list());
      }
      if (path === "/v1/leaderboard" && this.leaderboard) {
        return this._json(response, 200, this.leaderboard.top());
      }
      // Growth surfaces. Each answers with its own availability, so a
      // deployment that has configured none of them still gets a truthful
      // response instead of a 404 the website has to guess about.
      if (path === "/v1/social-proof" && this.growth) {
        return this._json(response, 200, this.growth.socialProof());
      }
      if (path === "/v1/community" && this.growth) {
        return this._json(response, 200, this.growth.community());
      }
      if (path === "/v1/account-options" && this.growth) {
        return this._json(response, 200, this.growth.accountOptions());
      }
      const referralMatch = /^\/v1\/referrals\/([^/]+)$/.exec(path);
      if (referralMatch && this.growth && request.method === "GET") {
        return this._json(response, 200, await this.growth.referrals(referralMatch[1]));
      }
      // Binding is signed by the person being referred: anyone can post anyone's
      // address, so an unsigned binding would let a stranger claim credit for
      // somebody who never heard of them. The block comes from this process's
      // own view of the chain, never from the caller.
      if (path === "/v1/referrals/bind" && this.growth && request.method === "POST") {
        const body = await this._body(request);
        const result = await this.growth.bindReferral({ ...body, atBlock: this.store.cursorBlock });
        return this._json(response, result.ok ? 200 : 400, result);
      }
      // One address's own history: positions, settlements, transactions and
      // payouts. Read-only, like every route here.
      const portfolioMatch = /^\/v1\/portfolio\/([^/]+)$/.exec(path);
      if (portfolioMatch && this.portfolio) {
        return this._json(response, 200, await this.portfolio.of(portfolioMatch[1]));
      }
      const profileMatch = /^\/v1\/profiles\/([^/]+)$/.exec(path);
      if (profileMatch && this.leaderboard) {
        return this._json(response, 200, this.leaderboard.profile(profileMatch[1]));
      }

      if (path === "/v1/rooms" && request.method === "GET") {
        const state = url.searchParams.get("state");
        // The rooms this process serves, with their indexed state where it has
        // one. A room it serves but has not indexed yet is listed with a null
        // state rather than omitted — the website needs to be able to link to
        // it — and never with a state invented to fill the gap.
        const indexed = new Map(this.store.listRooms().map((room) => [room.room_id, room]));
        const rooms = [...this.rooms.keys()]
          .filter(Boolean)
          .map((roomId) => {
            const room = indexed.get(roomId) ?? null;
            return {
              room_id: roomId,
              state: room?.state ?? null,
              live_room_address: room?.live_room_address ?? this.rooms.get(roomId)?.address ?? null,
              block: room?.block_number ?? null,
              indexed: Boolean(room),
            };
          })
          .filter((room) => (state ? room.state === state : true));
        return this._json(response, 200, { rooms });
      }

      const roomMatch = /^\/v1\/rooms\/([^/]+)(\/.*)?$/.exec(path);
      if (roomMatch) {
        const [, roomId, rest = ""] = roomMatch;
        // Each room has its own coordinator, edge and chat: a request names a
        // room, and everything below answers from that room's runtime rather
        // than from whichever one happened to be first.
        const runtime = this.rooms.get(roomId);
        if (!runtime) return this._json(response, 404, { error: "unknown room" });
        const { coordinator, edge, chat, eventLog } = {
          coordinator: runtime.coordinator ?? this.coordinator,
          edge: runtime.edge ?? this.edge,
          chat: runtime.chat ?? this.chat,
          eventLog: runtime.eventLog ?? this.eventLog,
        };

        if (rest === "" || rest === "/") return this._json(response, 200, coordinator.snapshot());
        if (rest === "/program") {
          return this._json(response, 200, { slots: coordinator.snapshot().program.slots });
        }
        if (rest === "/events") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return this._json(response, 200, coordinator.framesSince(since));
        }
        if (rest === "/scores") {
          // The standing is served folded, not left as arithmetic for the
          // caller: a provider's restatement appears in the log twice, and a
          // client that sums the events would count the withdrawn figure and
          // its replacement. The events stay, so the fold can be checked.
          const events = (await eventLog.all()).filter((event) => event.kind !== "heartbeat");
          const standing = [...foldMetrics(events)].map(([participant, state]) => ({
            participant,
            realized_pnl_usd: state.cumRealizedPnlUsd,
            baseline_account_value_usd: state.baseline,
          }));
          return this._json(response, 200, { standing, events });
        }
        // Chat is a capability, not an assumption. A deployment that has not
        // enabled it serves no chat surface at all: the report and the API must
        // agree, or the website shows a conversation the operator never ran.
        if (rest === "/chat" || rest === "/chat/moderate") {
          const chat = this.capabilities?.get("chat");
          if (chat && !chat.available) {
            return this._json(response, 503, { ok: false, reason: chat.reason, pinned: null, messages: [] });
          }
        }
        if (rest === "/chat" && request.method === "GET") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return this._json(response, 200, { pinned: chat.pinned, messages: await chat.history(since) });
        }
        if (rest === "/chat" && request.method === "POST") {
          const body = await this._body(request);
          // The room comes from the path and the clock comes from this process.
          // A claim signed for another room cannot be posted by asserting a
          // different one in the body, and every control the claim adds —
          // expiry, single use, rate limits, timeouts — is measured against a
          // clock the caller does not get to choose.
          const result = await chat.post({ ...body, roomId, nowMs: Date.now() });
          return this._json(response, result.ok ? 200 : 400, result);
        }
        // Moderation removes a message from the room's presentation layer only.
        // It cannot touch a position, a payout, or a result, and the audit line
        // it writes names the moderator who acted.
        if (rest === "/chat/moderate" && request.method === "POST") {
          const body = await this._body(request);
          const result = await chat.moderate({ ...body, roomId, nowMs: Date.now() });
          if (result.ok) return this._json(response, 200, result);
          return this._json(response, result.reason === "not a moderator" ? 403 : 400, result);
        }
        if (rest === "/stream") {
          return this._sse(request, response, Number(url.searchParams.get("since") ?? 0), edge, coordinator);
        }
        const slotMatch = /^\/slots\/(\d+)$/.exec(rest);
        if (slotMatch) {
          const slot = coordinator.snapshot().program.slots.find(
            (entry) => entry.slot_index === Number(slotMatch[1])
          );
          return slot ? this._json(response, 200, slot) : this._json(response, 404, { error: "unknown slot" });
        }
      }

      const marketMatch = /^\/v1\/markets\/([^/]+)(\/settlement)?$/.exec(path);
      if (marketMatch) {
        const [, market, settlement] = marketMatch;
        if (settlement) {
          if (!this.settlement) return this._json(response, 501, { error: "settlement service not configured" });
          const record = await this.settlement.record(market);
          return record ? this._json(response, 200, record) : this._json(response, 404, { error: "unknown market" });
        }
        const row = this.store.getMarket(market);
        return row ? this._json(response, 200, row) : this._json(response, 404, { error: "unknown market" });
      }

      const accountMatch = /^\/v1\/accounts\/([^/]+)\/(portfolio|history)$/.exec(path);
      if (accountMatch) {
        const [, account, kind] = accountMatch;
        if (kind === "portfolio") {
          return this._json(response, 200, {
            holdings: this.store.listAccountHoldings(account),
            pending: this.store.listAccountActions(account).filter((action) => action.status === 0),
            claims: this.settlement ? this.settlement.claimsFor(account) : [],
          });
        }
        return this._json(response, 200, { actions: this.store.listAccountActions(account) });
      }

      return this._json(response, 404, { error: "not found" });
    } catch (error) {
      // One place decides how an error becomes a response. Handling it inline
      // here discarded the status `_body` sets — so a malformed body on a gated
      // route answered 500 rather than 400 — and returned the raw message,
      // which is exactly what `_fail` suppresses for an unexpected failure.
      return this._fail(response, error);
    }
  }

  async _health() {
    // A configuration mismatch the operator has not noticed yet is reported
    // here as well, so it is visible without reading the process log.
    const snapshot = this.coordinator.snapshot();
    return {
      // Three independent signals, never merged.
      stream: this.playback?.health ?? "unknown",
      source: snapshot.health.source,
      indexer: snapshot.health.indexer,
      room_seq: snapshot.seq,
      block: this.store.cursorBlock,
      source_seq: snapshot.source.last_seq,
      // Null unless this process is misconfigured in a way it can detect.
      config_warning: this.configWarning() ?? null,
      // What the authority processes reported about themselves. They run
      // separately and swallow their own errors, so this is where a gate that
      // cannot reach the chain becomes visible — and it is where the alert
      // rules send an operator to find the reason.
      operators: this.operators ? await this.operators() : [],
      // Whether this replica is indexing at all. A standby serves state
      // `draft`, zero slots and block 0 — plausible-looking and empty rather
      // than an error — so without this a load balancer has nothing to drain
      // on and sends half its viewers to a room that never updates.
      leading: this.leading ? await this.leading() : null,
    };
  }

  _sse(request, response, since, edge = this.edge, coordinator = this.coordinator) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      // Without this nginx buffers the response by default, which defeats the
      // entire point of an event stream: frames arrive in blocks, or not until
      // the buffer fills.
      "x-accel-buffering": "no",
    });
    // How long a dropped client should wait before reconnecting. Advertised
    // rather than left to the browser's default, so a reconnect storm after a
    // deploy is bounded.
    response.write(`retry: 3000\n\n`);
    const connection = {
      // `id:` so a reconnecting browser can resume with Last-Event-ID. The
      // cursor-resume machinery already existed on the server; the transport
      // simply never offered it.
      send: (frame) =>
        response.write(
          (frame?.seq === undefined ? "" : `id: ${frame.seq}\n`) + `data: ${serialize(frame)}\n\n`
        ),
      close: () => response.end(),
    };
    edge.attach(connection, { since });
    request.on("close", () => edge.detach(connection));
  }

  _oracleAuthorized(request) {
    const received = Buffer.from(String(request.headers["x-tm-oracle-token"] ?? ""));
    const expected = Buffer.from(String(this.oracleToken ?? ""));
    return received.length > 0 && received.length === expected.length && timingSafeEqual(received, expected);
  }

  async _video(response, request, video) {
    const details = await stat(video.path);
    const size = Number(details.size);
    const range = String(request.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    let status = 200;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        return this._send(response, 416, "", { "content-range": `bytes */${size}`, ...CORS_HEADERS });
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          return this._send(response, 416, "", { "content-range": `bytes */${size}`, ...CORS_HEADERS });
        }
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        return this._send(response, 416, "", { "content-range": `bytes */${size}`, ...CORS_HEADERS });
      }
      end = Math.min(end, size - 1);
      status = 206;
    }

    const headers = {
      "content-type": video.mimeType,
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${video.etag}"`,
      ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      ...CORS_HEADERS,
    };
    response.writeHead(status, headers);
    const stream = createReadStream(video.path, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  /**
   * Reads a JSON body, bounded and without throwing past the caller.
   *
   * Unbounded buffering is a heap vector from any unauthenticated POST, and a
   * parse failure must be a 400 rather than something that escapes the handler.
   */
  /**
   * Reads a JSON body, bounded, well-formed, and always an object.
   *
   * `JSON.parse("null")` is valid JSON and yields `null`, which then explodes
   * on the first destructure — one client input the single error path still
   * turned into a 500.
   */
  async _body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString());
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        const error = new Error("request body must be a JSON object");
        error.status = 400;
        throw error;
      }
      return parsed;
    } catch (caught) {
      if (caught.status) throw caught;
      const error = new Error("request body is not valid JSON");
      error.status = 400;
      throw error;
    }
  }

  /** Turns any escaped error into a response, and never leaks internals. */
  _fail(response, error) {
    const status = Number(error?.status) || 500;
    if (response.headersSent || response.writableEnded) return;
    this._json(response, status, {
      error: status === 500 ? "internal error" : error.message,
    });
  }

  _json(response, status, payload) {
    this._send(response, status, serialize(payload), JSON_HEADERS);
  }

  _send(response, status, body, headers = JSON_HEADERS) {
    response.writeHead(status, headers);
    response.end(body);
  }
}
