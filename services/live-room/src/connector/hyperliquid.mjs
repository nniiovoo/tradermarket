// Hyperliquid testnet source adapter (ADR 0023). Reads PUBLIC address data
// only — the connector never holds a Participant's exchange credentials.
//
// Frozen Source Policy for the first Competition Template:
// - A Performance Record fact is one fill from the `userFills` info endpoint /
//   `userFills` WebSocket subscription for the Participant's linked address.
// - The immutable fill identifier is `tid` (trade id); dedupe key is
//   `${address}:${tid}`.
// - realized_pnl_usd = closedPnl - fee, computed exactly (scale-6 decimal).
//   Both operands are archived raw, so any third party re-derives the fact.
// - The baseline is the account's `marginSummary.accountValue` from
//   `clearinghouseState`, captured once at session start.
// - Every raw_query is a CLOSED window: {type, user, startTime, endTime}.

import { addDecimal } from "../domain/decimal.mjs";

export const HYPERLIQUID_TESTNET_INFO_URL = "https://api.hyperliquid-testnet.xyz/info";

/**
 * The most fills `userFillsByTime` answers in one call. A response of exactly
 * this length is a truncated window, not a complete one — the difference
 * between paging and skipping.
 */
export const HYPERLIQUID_PAGE_LIMIT = 2000;

function negate(value) {
  const text = typeof value === "number" ? String(value) : value;
  return text.startsWith("-") ? text.slice(1) : "-" + text;
}

/** One fill -> one normalized draft. Pure; identical in connector and resolver. */
export function normalizeFill(participantKey, address, fill) {
  return {
    source_event_id: `${address.toLowerCase()}:${fill.tid}`,
    participant: participantKey,
    observed_at: new Date(fill.time).toISOString(),
    kind: "trade_closed",
    facts: {
      realized_pnl_usd: addDecimal(String(fill.closedPnl), negate(String(fill.fee ?? "0"))),
      closed_pnl_usd: String(fill.closedPnl),
      fee_usd: String(fill.fee ?? "0"),
      coin: fill.coin,
      side: fill.side,
      price: String(fill.px),
      size: String(fill.sz),
      tid: fill.tid,
      order_id: fill.oid ?? null,
      tx_hash: fill.hash ?? null,
    },
  };
}

/** userFills response -> drafts, sorted by (time, tid) for determinism. */
export function normalizeFillsResponse(participantKey, address, fills) {
  return [...fills]
    .sort((a, b) => (a.time - b.time !== 0 ? a.time - b.time : String(a.tid).localeCompare(String(b.tid))))
    .map((fill) => normalizeFill(participantKey, address, fill));
}

/** clearinghouseState response -> one baseline draft. */
export function normalizeBaseline(participantKey, address, state, observedAtMs) {
  return {
    source_event_id: `baseline:${address.toLowerCase()}`,
    participant: participantKey,
    observed_at: new Date(observedAtMs).toISOString(),
    kind: "baseline",
    facts: { account_value_usd: String(state.marginSummary.accountValue) },
  };
}

/**
 * Live poller against the info endpoint. Reconnect-safe: each poll is a closed
 * [cursor, now] window reconciled through the same dedupe as the WS path, so
 * missed data backfills without gaps. (The WS subscription is an optimization;
 * the info endpoint is the recovery and reconciliation path.)
 */
export class HyperliquidPoller {
  /**
   * @param options.cursors            optional durable key-value store. Without
   *        one a restart re-polls from the beginning of time: the dedupe keeps
   *        that correct, but it re-fetches an entire session to learn nothing.
   * @param options.reconcileLookbackMs how far back a reconciliation sweep
   *        looks for restatements of fills the incremental window has passed.
   */
  constructor({
    connector,
    participants,
    infoUrl = HYPERLIQUID_TESTNET_INFO_URL,
    fetchImpl = fetch,
    now = () => Date.now(),
    cursors = null,
    reconcileLookbackMs = 15 * 60_000,
    pageLimit = HYPERLIQUID_PAGE_LIMIT,
    maxPagesPerWindow = 64,
  }) {
    this.connector = connector;
    this.participants = participants; // [{ key, address }]
    this.infoUrl = infoUrl;
    this.fetch = fetchImpl;
    this.now = now;
    this.cursors = cursors;
    this.reconcileLookbackMs = reconcileLookbackMs;
    this.pageLimit = pageLimit;
    this.maxPagesPerWindow = maxPagesPerWindow;
    this.cursorMs = new Map();
    // Restored on first use, not here: the store is async and a constructor
    // cannot await. An empty map is what a poller with no saved cursor
    // legitimately starts from, so a poller constructed and never polled is in
    // the same state either way.
    this._cursorsLoaded = false;
  }

  /**
   * Restores each participant's cursor before the first read.
   *
   * Skipping this would make a restarted poller re-fetch the whole session from
   * the beginning — which the dedupe would mostly absorb, quietly, while doing
   * an unbounded amount of provider traffic to learn nothing.
   */
  async _ensureCursors() {
    if (this._cursorsLoaded) return;
    this._cursorsLoaded = true;
    if (!this.cursors) return;
    for (const { address } of this.participants) {
      const saved = await this.cursors.get(`poller:cursor:${address.toLowerCase()}`, null);
      if (saved !== null) this.cursorMs.set(address, Number(saved));
    }
  }

  async _setCursor(address, at) {
    this.cursorMs.set(address, at);
    await this.cursors?.set(`poller:cursor:${address.toLowerCase()}`, at);
  }

  async captureBaselines() {
    await this._ensureCursors();
    for (const { key, address } of this.participants) {
      const body = { type: "clearinghouseState", user: address };
      const observed = this.now();
      const response = await this._post(body);
      await this.connector.ingestBatch({
        rawBytes: response.rawBytes,
        rawQuery: { endpoint: "info", ...body, at: observed },
        drafts: [normalizeBaseline(key, address, response.json, observed)],
      });
      await this._setCursor(address, observed);
    }
  }

  /**
   * Reads one closed window to exhaustion.
   *
   * A full page means the provider had more to say and ran out of room. Taking
   * it as the whole window and moving the cursor past `endTime` discards every
   * fill that did not fit — silently, permanently, from a log a market settles
   * on. So a full page is followed by another window starting at the last fill
   * it contained; the boundary fill repeats and the dedupe absorbs it, which is
   * the safe direction to be wrong in.
   */
  async _readWindow({ key, address, startTime, endTime, sweep = null }) {
    const appended = [];
    let from = startTime;
    for (let page = 0; page < this.maxPagesPerWindow; page++) {
      const body = { type: "userFillsByTime", user: address, startTime: from, endTime };
      const response = await this._post(body);
      const fills = response.json ?? [];
      appended.push(
        ...(await this.connector.ingestBatch({
          rawBytes: response.rawBytes,
          rawQuery: { endpoint: "info", ...body, ...(sweep ? { sweep } : {}) },
          drafts: normalizeFillsResponse(key, address, fills),
        }))
      );
      if (fills.length < this.pageLimit) return appended;

      const last = Math.max(...fills.map((entry) => entry.time));
      if (last <= from) {
        // A full page inside a single millisecond: no time window can step over
        // it. There is no correct answer, but there is a correct failure —
        // stop, and let the source go stale, rather than carry on with a total
        // that is missing trades nobody would ever know about.
        throw new Error(
          `hyperliquid window saturated at ${from} for ${address}: ${fills.length} fills share one timestamp`
        );
      }
      from = last;
    }
    throw new Error(`hyperliquid window ${startTime}..${endTime} for ${address} did not drain in ${this.maxPagesPerWindow} pages`);
  }

  async pollOnce() {
    await this._ensureCursors();
    const appended = [];
    for (const { key, address } of this.participants) {
      const startTime = this.cursorMs.get(address) ?? 0;
      const endTime = this.now();
      appended.push(...(await this._readWindow({ key, address, startTime, endTime })));
      // Overlap the next window by 2s: dedupe absorbs the overlap, a gap would not heal itself.
      await this._setCursor(address, Math.max(startTime, endTime - 2_000));
    }
    if (appended.length === 0) await this.connector.heartbeat(new Date(this.now()).toISOString());
    return appended;
  }

  /**
   * A reconciliation sweep over a longer lookback.
   *
   * The incremental window only moves forward, so a provider that restates a
   * fill from earlier in the session — a corrected figure once a fee settles,
   * a reversal — would never be asked for it again, and the market would settle
   * on a number the provider has since withdrawn. This re-asks for the recent
   * past; the connector's dedupe drops what has not changed and appends what
   * has, as a correction.
   *
   * It does not move the cursor: this is a second look at ground already
   * covered, not progress.
   */
  async reconcile(nowMs = this.now()) {
    await this._ensureCursors();
    const appended = [];
    for (const { key, address } of this.participants) {
      const startTime = Math.max(0, nowMs - this.reconcileLookbackMs);
      appended.push(
        ...(await this._readWindow({ key, address, startTime, endTime: nowMs, sweep: "reconcile" }))
      );
    }
    return appended;
  }

  async _post(body) {
    const response = await this.fetch(this.infoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`hyperliquid info ${response.status}`);
    const rawBytes = await response.text();
    return { rawBytes, json: JSON.parse(rawBytes) };
  }
}

/**
 * Deterministic file/fixture replay source: a scripted session of provider
 * batches, so an entire Live Session replays without the live provider.
 * Batch shape: { at_ms, address, participant, kind: 'fills'|'baseline', payload }
 */
export class ReplaySource {
  constructor({ connector, batches, now }) {
    this.connector = connector;
    this.batches = [...batches].sort((a, b) => a.at_ms - b.at_ms);
    this.cursor = 0;
    this.now = now;
  }

  get done() {
    return this.cursor >= this.batches.length;
  }

  /** Ingests every batch due at or before nowMs; returns appended events. */
  async advanceTo(nowMs) {
    const appended = [];
    while (this.cursor < this.batches.length && this.batches[this.cursor].at_ms <= nowMs) {
      const batch = this.batches[this.cursor++];
      const rawBytes = JSON.stringify(batch.payload);
      if (batch.kind === "baseline") {
        appended.push(
          ...(await this.connector.ingestBatch({
            rawBytes,
            rawQuery: { endpoint: "info", type: "clearinghouseState", user: batch.address, at: batch.at_ms },
            drafts: [normalizeBaseline(batch.participant, batch.address, batch.payload, batch.at_ms)],
          }))
        );
      } else {
        appended.push(
          ...(await this.connector.ingestBatch({
            rawBytes,
            rawQuery: {
              endpoint: "info",
              type: "userFillsByTime",
              user: batch.address,
              startTime: batch.window_start_ms ?? 0,
              endTime: batch.at_ms,
            },
            drafts: normalizeFillsResponse(batch.participant, batch.address, batch.payload),
          }))
        );
      }
    }
    return appended;
  }
}
