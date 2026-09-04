// Realtime Edge (issue 09): fanout with cursor resume, heartbeats, and
// backpressure; chat with wallet-signed identity and moderation; playback
// health with stream-timecode mapping.
//
// Transport-agnostic on purpose: `Connection` is any sink with send/close, so
// the same core serves WebSocket, SSE, or an in-process test double.

export class RealtimeEdge {
  /**
   * @param options.coordinator LiveRoomCoordinator (source of frames)
   * @param options.config      { heartbeatMs, maxQueue, retention }
   */
  constructor({ coordinator, config }) {
    this.coordinator = coordinator;
    this.config = config;
    this.connections = new Set();
    this.privateChannels = new Map(); // address -> Set(connection)
  }

  /** Attaches a connection, replaying from `since` or sending a resync. */
  attach(connection, { since = null, address = null } = {}) {
    connection.queue = [];
    connection.backlog = 0;
    connection.dropped = 0;
    this.connections.add(connection);
    if (address) {
      const existing = this.privateChannels.get(address) ?? new Set();
      existing.add(connection);
      this.privateChannels.set(address, existing);
    }

    try {
      this._sendHello(connection);
    } catch {
      this.detach(connection);
      return connection;
    }
    return this._replay(connection, since);
  }

  _sendHello(connection) {
    this._send(connection, {
      type: "hello",
      room: this.coordinator.roomId,
      seq: this.coordinator.roomSeq,
      retention_floor: this.coordinator.frames.length > 0 ? this.coordinator.frames[0].seq - 1 : this.coordinator.roomSeq,
      heartbeat_ms: this.config.heartbeatMs,
      presentation_only: true,
    });
  }

  _replay(connection, since) {
    if (since === null) return connection;
    try {
      const result = this.coordinator.framesSince(since);
      if (result.resync) {
        this._send(connection, { type: "resync", snapshot: result.snapshot, presentation_only: true });
      } else {
        for (const frame of result.frames) this._send(connection, frame);
      }
    } catch {
      this.detach(connection);
    }
    return connection;
  }

  detach(connection) {
    this.connections.delete(connection);
    for (const [address, set] of this.privateChannels) {
      set.delete(connection);
      if (set.size === 0) this.privateChannels.delete(address);
    }
  }

  /**
   * Broadcast sink for the coordinator's publishTo.
   *
   * A socket destroyed between a write and its 'close' event throws rather than
   * returning false. Left uncaught that escaped into `coordinator.tick()`, so
   * one bad connection blanked every connection after it in the set and turned
   * the indexing poll into a failed sync. A sink that throws is simply gone.
   */
  broadcast(frame) {
    for (const connection of [...this.connections]) {
      try {
        this._send(connection, frame);
      } catch {
        this.detach(connection);
        try {
          connection.close?.();
        } catch {
          // Already destroyed; nothing further to do.
        }
      }
    }
  }

  /**
   * Private channel: scoped to one address, carrying only public chain data.
   *
   * A sink that throws is detached rather than allowed to escape, exactly as in
   * `broadcast` — otherwise one socket destroyed mid-write skips every
   * remaining reader on that address and leaks the dead connection into the
   * channel map.
   */
  sendPrivate(address, frame) {
    const set = this.privateChannels.get(address);
    if (!set) return 0;
    let delivered = 0;
    for (const connection of [...set]) {
      try {
        this._send(connection, frame);
        delivered += 1;
      } catch {
        this.detach(connection);
        try {
          connection.close?.();
        } catch {
          // Already destroyed; nothing further to do.
        }
      }
    }
    return delivered;
  }

  _send(connection, frame) {
    // Backpressure, measured by whether the sink actually accepted the write.
    //
    // The previous version pushed onto `queue` and popped in the next
    // statement, so `queue.length` was always zero when the cap was checked and
    // the cap never fired. A reader that opened the stream and stopped reading
    // accumulated every frame in Node's socket buffer for the process lifetime,
    // and `resync_required` was unreachable. `response.write` returns false
    // when the socket is full; that is the signal to count against.
    // `?? 256` accepts 0, and `backlog >= 0` is always true — so a cap of zero
    // delivered nothing at all, including the `hello`, while the connection
    // reported itself healthy. A nonsensical cap falls back to the default.
    const configured = Number(this.config.maxQueue);
    const cap = Number.isFinite(configured) && configured > 0 ? configured : 256;
    const backlog = connection.backlog ?? 0;

    if (backlog >= cap) {
      // Over the cap, the frame is dropped — but the socket is still probed, so
      // the stream can recover. Returning early skipped the very send() whose
      // result was the only thing that could clear the backlog, which left a
      // viewer whose socket filled for one moment blanked for the life of the
      // connection while the connection still looked healthy.
      connection.dropped = (connection.dropped ?? 0) + 1;
      // Probe periodically rather than on every dropped frame: writing a notice
      // per frame to a socket that is not draining is no better than writing
      // the frame. The probe doubles as the recovery path — its return value is
      // what clears the backlog once the socket drains.
      if (connection.dropped % cap === 1 || cap === 1) {
        const accepted = connection.send({
          type: "resync_required",
          dropped: connection.dropped,
          presentation_only: true,
        });
        if (accepted !== false) connection.backlog = 0;
      }
      return false;
    }

    const accepted = connection.send(frame);
    // A sink that reports nothing is treated as having accepted, which is the
    // behaviour every in-process test double relies on.
    connection.backlog = accepted === false ? backlog + 1 : 0;
    return true;
  }
}

/** How long a signed chat claim stays valid, and the clock skew allowed. */
const CLAIM_LIFETIME_MS = 5 * 60_000;
const CLAIM_SKEW_MS = 60_000;

/**
 * The in-memory chat store.
 *
 * The default, and honestly the wrong one for anything left running: a restart
 * erases the conversation, the moderation record and every active timeout —
 * a mute lifted by nothing more than a deploy. `SqliteChatStore` is the durable
 * form, wired whenever the service is given a data directory.
 */
export class MemoryChatStore {
  constructor() {
    this.messages = [];
    this.deleted = new Set();
    this.timeouts = new Map();
    this.audits = [];
    this.nextId = 1;
  }

  append({ author, label = null, text, at }) {
    const message = { id: this.nextId++, author, label, text, at, presentation_only: true };
    this.messages.push(message);
    return message;
  }

  history(sinceId = 0) {
    return this.messages.filter((message) => message.id > sinceId && !this.deleted.has(message.id));
  }

  find(id) {
    return this.messages.find((message) => message.id === id) ?? null;
  }

  delete(id) {
    this.deleted.add(id);
  }

  setTimeout(account, untilMs) {
    this.timeouts.set(String(account).toLowerCase(), untilMs);
  }

  timeoutFor(account) {
    return this.timeouts.get(String(account).toLowerCase()) ?? 0;
  }

  audit(entry) {
    this.audits.push(entry);
  }

  auditLog() {
    return [...this.audits];
  }

  prune({ nowMs, maxMessages }) {
    for (const [key, until] of this.timeouts) {
      if (until <= nowMs) this.timeouts.delete(key);
    }
    if (this.messages.length > maxMessages) {
      const dropped = this.messages.splice(0, this.messages.length - maxMessages);
      for (const message of dropped) this.deleted.delete(message.id);
    }
  }
}

/** Chat: off-chain, non-authoritative, never evidence. */
export class ChatService {
  /**
   * @param options.verifySignature (address, message, signature) => Promise<boolean>
   * @param options.config { rateLimitPerMinute, slowModeMs, labels: Map address->label }
   */
  /**
   * @param options.store optional durable store. Without one, the conversation,
   *        its moderation and its audit trail live in memory and a restart
   *        erases the only copy — including a moderator's active timeout, which
   *        would be lifted by nothing more than a deploy.
   */
  constructor({ verifySignature, config, store = null }) {
    this.verify = verifySignature;
    this.config = config;
    this.store = store ?? new MemoryChatStore();
    this.recent = new Map();
    this.usedClaims = new Map(); // claim -> when, so a claim is used once
    this.maxMessages = config?.maxMessages ?? 500;
    this.pinned = {
      id: 0,
      author: null,
      text: "Chat is commentary. It cannot change a result: markets settle from the approved source only.",
      pinned: true,
      presentation_only: true,
    };
  }

  /**
   * The exact string a chat post is signed over.
   *
   * Signing the bare message text binds nothing: the same signature posts in
   * any room, on any deployment, forever, and any signature the reader ever
   * produced over a plain string elsewhere posts as them here. Naming the
   * purpose, the room, the author and the moment fixes all three.
   */
  claimFor({ roomId, address, text, issuedAt }) {
    return [
      "tradermarket-chat-v1",
      roomId ?? this.config.roomId ?? "",
      String(address).toLowerCase(),
      String(issuedAt),
      text,
    ].join("\n");
  }

  async post({ address, text, signature, claim = null, roomId = null, issuedAt = null, nowMs = Date.now() }) {
    if (!address || !signature) return { ok: false, reason: "unauthenticated" };
    // JSON bodies can carry any shape. An author that is an array or an object
    // would be served to every reader of the room as if it were an address.
    if (typeof address !== "string" || typeof text !== "string") {
      return { ok: false, reason: "address and text must be strings" };
    }
    // Every per-author record is keyed on the lowercased address. Ethereum
    // address case is a checksum, and signature recovery compares
    // case-insensitively, so keying on the submitted string lets a timed-out
    // author post again by flipping one hex letter — and gives each of the
    // 2^40 case variants its own fresh rate limit.
    const key = String(address).toLowerCase();
    const timeoutUntil = await this.store.timeoutFor(key);
    if (nowMs < timeoutUntil) return { ok: false, reason: "timed out" };
    // The claim is required, not optional. Accepting a bare-text signature
    // when none is supplied would hand the bypass to anyone who wants it: omit
    // the field, and every property the claim exists to guarantee — the room,
    // the expiry, the single use — is gone.
    if (!claim) return { ok: false, reason: "a signed claim is required: this client is out of date" };
    const signed = claim;
    {
      const parts = String(claim).split("\n");
      const [domain, claimRoom, claimAddress, claimIssuedAt] = parts;
      const claimText = parts.slice(4).join("\n");
      if (domain !== "tradermarket-chat-v1") return { ok: false, reason: "unrecognised claim" };
      if (claimAddress !== String(address).toLowerCase()) return { ok: false, reason: "claim is for another address" };
      if (claimText !== text) return { ok: false, reason: "claim does not match the message" };
      // An empty room segment must fail rather than skip the check: a claim
      // that names no room would otherwise be valid in every room.
      const room = roomId ?? this.config.roomId ?? "";
      if (claimRoom !== room) return { ok: false, reason: "claim is for another room" };
      const age = nowMs - Number(claimIssuedAt);
      if (!Number.isFinite(age) || age > CLAIM_LIFETIME_MS || age < -CLAIM_SKEW_MS) {
        return { ok: false, reason: "claim expired" };
      }
      // Keyed on the claim, not the signature. ECDSA signatures are malleable,
      // so a re-signed variant of the same claim would otherwise pass.
      //
      // Reserved here, before yielding. Checking here and recording after the
      // `await` below is check-then-act: every concurrent request passes the
      // check before any of them records, so one signed claim posted as many
      // times as it was sent. The reservation is released if the request then
      // fails, so a rejected attempt does not burn a claim that is still valid.
      if (this.usedClaims.has(claim)) return { ok: false, reason: "replay: this claim was already used" };
      this.usedClaims.set(claim, Number(String(claim).split("\n")[3]) || nowMs);
    }
    const release = () => { if (claim) this.usedClaims.delete(claim); };
    if (!(await this.verify(address, signed, signature))) {
      release();
      return { ok: false, reason: "bad signature" };
    }

    const history = (this.recent.get(key) ?? []).filter((at) => nowMs - at < 60_000);
    if (history.length >= (this.config.rateLimitPerMinute ?? 10)) {
      release();
      return { ok: false, reason: "rate limited" };
    }
    if (history.length > 0 && nowMs - history.at(-1) < (this.config.slowModeMs ?? 0)) {
      release();
      return { ok: false, reason: "slow mode" };
    }
    history.push(nowMs);
    this.recent.set(key, history);
    // Consumed only once the post is actually accepted. Recording it before the
    // rate-limit check meant every rejected request retained a caller-chosen
    // string that nothing released — a free, unbounded heap vector for anyone
    // able to sign, which is everyone.
    await this._prune(nowMs);

    // Ids come from the store's own sequence, so they keep climbing across a
    // restart: a moderation signed over message 5 cannot be replayed onto a
    // different message 5 tomorrow.
    const message = await this.store.append({
      author: address,
      label: this.config.labels?.get(key) ?? null,
      text,
      at: new Date(nowMs).toISOString(),
    });
    return { ok: true, message };
  }

  /**
   * Moderation, which needs the same proof as speaking.
   *
   * The moderator's address is public: anyone who has seen a moderation knows
   * it. Accepting a claimed address alone would let anybody delete anything, so
   * the caller signs the action and the signature is verified exactly as a
   * message is. Address case is a checksum and never an identity, so both sides
   * are compared lowercased.
   */
  /** The exact string a moderation is signed over. */
  moderationClaimFor({ roomId, moderator, messageId, action, untilMs = 0, issuedAt }) {
    return [
      "tradermarket-moderation-v1",
      roomId ?? this.config.roomId ?? "",
      String(moderator).toLowerCase(),
      action,
      String(messageId),
      String(untilMs),
      String(issuedAt),
    ].join("\n");
  }

  async moderate({
    moderator,
    messageId,
    action,
    untilMs = 0,
    signature = null,
    claim = null,
    roomId = null,
    nowMs = Date.now(),
  }) {
    const key = String(moderator ?? "").toLowerCase();
    if (!this.config.moderators?.has(key)) return { ok: false, reason: "not a moderator" };
    if (!signature) return { ok: false, reason: "not a moderator" };
    // Message ids restart at 1 on a fresh process, so an unbound moderation
    // signature deletes whatever message #5 happens to be next time — on this
    // deployment or any other sharing that moderator.
    if (!claim) return { ok: false, reason: "not a moderator" };
    const signed = claim;
    {
      const [domain, claimRoom, claimModerator, claimAction, claimMessageId, claimUntil, claimIssuedAt] =
        String(claim).split("\n");
      if (domain !== "tradermarket-moderation-v1") return { ok: false, reason: "unrecognised claim" };
      if (claimModerator !== key) return { ok: false, reason: "claim is for another moderator" };
      if (claimAction !== action || claimMessageId !== String(messageId) || claimUntil !== String(untilMs)) {
        return { ok: false, reason: "claim does not match the action" };
      }
      const room = roomId ?? this.config.roomId ?? "";
      if (claimRoom !== room) return { ok: false, reason: "claim is for another room" };
      const age = nowMs - Number(claimIssuedAt);
      if (!Number.isFinite(age) || age > CLAIM_LIFETIME_MS || age < -CLAIM_SKEW_MS) {
        return { ok: false, reason: "claim expired" };
      }
      // Keyed on the claim, not the signature. ECDSA signatures are malleable,
      // so a re-signed variant of the same claim would otherwise pass.
      // Reserved before yielding, as in post().
      if (this.usedClaims.has(claim)) return { ok: false, reason: "replay: this claim was already used" };
      this.usedClaims.set(claim, Number(String(claim).split("\n")[6]) || nowMs);
    }
    if (!(await this.verify(moderator, signed, signature))) {
      if (claim) this.usedClaims.delete(claim);
      return { ok: false, reason: "not a moderator" };
    }
    // Prune here as well: on a deployment where moderation is the only traffic,
    // pruning solely on a successful post never runs.
    await this._prune(nowMs);
    const message = await this.store.find(messageId);
    if (!message) return { ok: false, reason: "no such message" };
    if (action === "delete") {
      await this.store.delete(messageId);
      await this.audit(moderator, "delete", messageId);
      return { ok: true, deleted: messageId };
    }
    if (action === "timeout") {
      await this.store.setTimeout(message.author, untilMs);
      await this.audit(moderator, "timeout", messageId);
      return { ok: true, timedOut: message.author, until: untilMs };
    }
    return { ok: false, reason: "unknown action" };
  }

  /** Bounds in-memory state: rate-limit windows, expired timeouts, history. */
  async _prune(nowMs) {
    for (const [key, stamps] of this.recent) {
      const live = stamps.filter((at) => nowMs - at < 60_000);
      if (live.length === 0) this.recent.delete(key);
      else this.recent.set(key, live);
    }
    for (const [used, issuedAt] of this.usedClaims) {
      // Released only once the claim can no longer be accepted at all.
      if (nowMs - issuedAt > CLAIM_LIFETIME_MS + CLAIM_SKEW_MS) this.usedClaims.delete(used);
    }
    await this.store.prune({ nowMs, maxMessages: this.maxMessages });
  }

  async audit(moderator, action, messageId) {
    await this.store.audit({ moderator, action, messageId, at: new Date().toISOString() });
  }

  /** The moderation record, for an operator reviewing what was done. */
  async auditLog() {
    return this.store.auditLog();
  }

  async history(sinceId = 0) {
    return this.store.history(sinceId);
  }
}

/** Playback: health polling and the stream-timecode -> source-sequence map. */
export class PlaybackService {
  constructor({ config }) {
    this.config = config;
    // "unavailable" is a measurement: it says the stream was checked and is
    // down. Until something observes it, that is a claim about a check nobody
    // ran — and /v1/health published it as the stream signal.
    this.health = "unknown";
    this.timecodes = []; // { source_seq, stream_offset_s }
    this.startedAtMs = null;
  }

  /** Health has three values; it is never an input to the Market Gate. */
  observe({ ok, lastSegmentAgeMs, nowMs = Date.now() }) {
    const previous = this.health;
    if (!ok) this.health = "unavailable";
    else if (lastSegmentAgeMs > (this.config.degradedAfterMs ?? 10_000)) this.health = "degraded";
    else {
      this.health = "live";
      this.startedAtMs ??= nowMs;
    }
    return { changed: previous !== this.health, health: this.health };
  }

  /** Maps a source sequence to the stream offset where it was visible. */
  mark(sourceSeq, observedAtMs) {
    if (this.startedAtMs === null) return null;
    const offset = Math.max(0, Math.round((observedAtMs - this.startedAtMs) / 1000) - (this.config.disclosedDelayS ?? 0));
    const entry = { source_seq: sourceSeq, stream_offset_s: offset };
    this.timecodes.push(entry);
    return entry;
  }

  offsetFor(sourceSeq) {
    let best = null;
    for (const entry of this.timecodes) {
      if (entry.source_seq <= sourceSeq) best = entry;
      else break;
    }
    return best ? best.stream_offset_s : null;
  }
}
