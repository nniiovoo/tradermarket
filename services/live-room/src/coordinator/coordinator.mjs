// Live Room Coordinator (issue 07). Composes room state, sequences the Room
// Program, and publishes gap-free Room Sequence deltas.
//
// It holds NO chain key, accepts NO order, and asserts NO state the chain does
// not already support: every slot state is derived from indexer rows plus
// source status. Anything it publishes may be wrong, late, or missing without
// changing a settlement outcome.
//
// Provenance is mandatory: every frame carries `chain`, `source_seq`, or an
// explicit presentation-only label. A frame with none of the three is a bug
// and is refused at publish time.

export const PRESENTATION_ONLY_TYPES = new Set([
  "hello",
  "heartbeat",
  "resync",
  "error",
  "stream.health_changed",
  "viewers.updated",
  "chat.message",
  "chat.deleted",
  "chat.pinned",
]);

export class LiveRoomCoordinator {
  /**
   * @param options.roomId
   * @param options.store        ProjectionStore (read-only here)
   * @param options.eventLog     EventStore port for source status (read-only)
   * @param options.publishTo    fanout sink: (frame) => void
   * @param options.config       { freshnessThresholdMs, heartbeatMs, retention, maxOpenSlots }
   * @param options.publisherApi optional: { requestSlot(candidate) } — a REQUEST
   *                             to the Program Publisher, never a publication.
   */
  constructor({ roomId, store, eventLog, publishTo, config, publisherApi = null }) {
    this.roomId = roomId;
    this.store = store;
    this.eventLog = eventLog;
    this.publishTo = publishTo;
    this.config = config;
    this.publisherApi = publisherApi;
    this.roomSeq = 0;
    this.frames = [];
    this.lastSnapshot = null;
    // "unavailable" is a measurement: it says the stream was checked and is
    // down. Nothing here checks until a PlaybackService reports, so the initial
    // value asserted an outage that may not exist.
    this.streamHealth = "unknown";
    // null, not 0: nothing in this system counts viewers unless something
    // reports them. A zero would be a measurement claim ("nobody is watching")
    // where the truth is "we do not count".
    this.viewers = null;
    this.focusSlotIndex = null;
    this.pendingRequests = new Set();
    // The chain head, when something that can see it reports one.
    this.chainHead = null;
    this.chainHeadAt = null;
    // The event log's tip, refreshed once per indexing pass via
    // observeEventLogTip() rather than read live: the store's own port is
    // async (it may be PostgreSQL), and snapshot()/tick() are called
    // synchronously from HTTP handlers and SSE fanout throughout this
    // process. Caching what the last pass observed — exactly how chainHead
    // already works — keeps every synchronous reader correct without
    // threading await through the whole request path.
    this.eventLogTip = null;
  }

  /** Records the event log's tip as of the last indexing pass. */
  observeEventLogTip(tip) {
    this.eventLogTip = tip;
  }

  /** Records the chain head, so indexer health can be measured against it. */
  /**
   * Records a successful reading of the chain head, and WHEN it was read.
   *
   * The time matters as much as the number. The indexing pass reads the head
   * first, so an RPC that is down throws before anything is observed — and a
   * coordinator that kept comparing its cursor against the last head it saw
   * reported the indexer "current", because the cursor had long since caught up
   * to that stale number. The one signal that says "these figures are behind the
   * chain" turned green at the moment the chain became unreachable.
   */
  observeChainHead(block, atMs = Date.now()) {
    const head = Number(block);
    if (!Number.isFinite(head)) return;
    this.chainHead = head;
    this.chainHeadAt = atMs;
  }

  // ------------------------------------------------------------- publishing

  publish(type, payload, { chain = null, sourceSeq = null } = {}) {
    const presentationOnly = PRESENTATION_ONLY_TYPES.has(type);
    if (!presentationOnly && chain === null && sourceSeq === null) {
      throw new Error(`frame ${type} has no provenance: chain, source_seq, or presentation-only required`);
    }
    const frame = {
      room: this.roomId,
      seq: ++this.roomSeq,
      type,
      at: new Date().toISOString(),
      ...(sourceSeq !== null ? { source_seq: sourceSeq } : {}),
      ...(chain !== null ? { chain } : {}),
      ...(presentationOnly && chain === null && sourceSeq === null ? { presentation_only: true } : {}),
      payload,
    };
    this.frames.push(frame);
    const retention = this.config.retention ?? 600;
    if (this.frames.length > retention) this.frames.splice(0, this.frames.length - retention);
    this.publishTo(frame);
    return frame;
  }

  /** Frames after `sinceSeq`, or a resync instruction when below the floor. */
  framesSince(sinceSeq) {
    // An uninterpretable cursor resyncs. Every comparison against NaN is false,
    // so a non-numeric `since` used to answer "you are fully caught up" — and an
    // SSE reader attached with it got `hello` and then nothing, forever.
    if (!Number.isFinite(sinceSeq)) return { resync: true, snapshot: this.snapshot() };
    const floor = this.frames.length > 0 ? this.frames[0].seq - 1 : this.roomSeq;
    if (sinceSeq < floor) return { resync: true, snapshot: this.snapshot() };
    return { resync: false, frames: this.frames.filter((frame) => frame.seq > sinceSeq) };
  }

  // -------------------------------------------------------------- snapshot

  /** Complete published state at the current Room Sequence. */
  snapshot(nowMs = Date.now()) {
    const room = this.store.getRoom(this.roomId);
    const slots = this.store.listSlots(this.roomId).map((slot) => this._slotView(slot));
    const tip = this.eventLogTip;
    const sourceAge = tip ? nowMs - Date.parse(tip.observed_at) : null;
    return {
      room: this.roomId,
      seq: this.roomSeq,
      state: room?.state ?? "draft",
      chain: { block: this.store.cursorBlock },
      program: {
        slots,
        focus: this.focusSlotIndex,
        open_count: slots.filter((slot) => slot.state === "open" || slot.state === "awaiting-liquidity").length,
        max_open: room?.max_open_slots ?? this.config.maxOpenSlots ?? null,
      },
      source: {
        last_seq: tip ? tip.seq : 0,
        observed_at: tip ? tip.observed_at : null,
        age_ms: sourceAge,
        fresh: sourceAge !== null && sourceAge <= this.config.freshnessThresholdMs,
      },
      stream: { health: this.streamHealth, presentation_only: true },
      viewers: { count: this.viewers, measured: this.viewers !== null, presentation_only: true },
      health: this._health(nowMs),
    };
  }

  _slotView(slot) {
    const market = slot.market_address ? this.store.getMarket(slot.market_address) : null;
    const pressure = slot.market_address ? this.store.pendingPressure(slot.market_address) : null;
    return {
      slot_index: slot.slot_index,
      state: slot.state,
      shape: slot.shape,
      question: slot.question,
      market: slot.market_address,
      // Presentation metadata comes from MarketCreated, not from the slot's
      // off-chain draft. Keeping the indexed value makes rebuilds deterministic
      // and lets the audience open the exact stream the contract committed to.
      stream_url: market?.stream_url ?? null,
      condition_hash: slot.condition_hash,
      // From the market row, which the indexer fills from the contract's own
      // getter. `SlotPublished` does not carry the rate and the off-chain slot
      // metadata is empty in production, so reading it only from the slot left
      // every surface quoting a rate with nothing real to quote. Zero is a real
      // rate, so `??` rather than `||`.
      winner_reward_bps: market?.winner_reward_bps ?? slot.winner_reward_bps ?? null,
      opens_at: slot.opens_at,
      published_seq: slot.published_seq === undefined ? null : String(slot.published_seq ?? ""),
      closed_seq: slot.closed_seq === undefined || slot.closed_seq === null ? null : String(slot.closed_seq),
      // The CLEARED price and its block. Never pending-adjusted.
      // Guarded on the field, not the row: a market row exists as soon as
      // MarketCreated is indexed, while the price only arrives with the next
      // state read. Guarding on the row alone served `String(undefined)`, which
      // the app rendered as NaN¢ and a probability bar of width NaN%.
      // Guarded on liquidity as well as on the field. `MarketMath.spotPriceA`
      // returns a hardcoded 500_000 when both reserves are zero, so an unfunded
      // market reports a perfect 50/50 — a market price for a market nobody has
      // made a market in, rendered as a real bar at a named chain block.
      price:
        market &&
        market.implied_prob_a !== undefined &&
        market.implied_prob_a !== null &&
        BigInt(market.total_lp_shares ?? 0n) > 0n
          ? { implied_prob_a: String(market.implied_prob_a), block: market.block_number }
          : null,
      liquidity:
        market && market.total_lp_shares !== undefined && market.total_lp_shares !== null
          ? { total_lp_shares: String(market.total_lp_shares), block: market.block_number }
          : null,
      pending_pressure: pressure
        ? { count: pressure.count, buy_a: String(pressure.buyA), buy_b: String(pressure.buyB), liquidity: String(pressure.liquidity) }
        : null,
    };
  }

  /** Three independent signals — never merged into one indicator. */
  _health(nowMs) {
    const tip = this.eventLogTip;
    const sourceAge = tip ? nowMs - Date.parse(tip.observed_at) : null;
    return {
      stream: this.streamHealth,
      source: sourceAge === null ? "unknown" : sourceAge <= this.config.freshnessThresholdMs ? "fresh" : "stale",
      // Against the chain head, not against itself. `staleness(cursorBlock)`
      // compared the cursor with the cursor — a constant "current" that could
      // never report the one thing this signal exists to report. Without a head
      // to compare against, the answer is "unknown", never "current".
      // A reading nobody has taken recently is not a reading. Without a fresh
      // head there is nothing to compare the cursor against, and the honest
      // answer is that we do not know — never "current".
      indexer: this._indexerHealth(nowMs),
    };
  }

  _indexerHealth(nowMs) {
    if (this.chainHead === null) return "unknown";
    const maxAgeMs = this.config.chainHeadMaxAgeMs ?? 60_000;
    if (this.chainHeadAt === null || nowMs - this.chainHeadAt > maxAgeMs) return "unknown";
    return this.store.staleness(this.chainHead).stale ? "delayed" : "current";
  }

  // ------------------------------------------------------------------ tick

  /**
   * Recomputes derived state and emits deltas for what changed. Purely a
   * projection step: it never writes to chain and never asserts a state the
   * indexer does not already show.
   */
  tick(nowMs = Date.now()) {
    const snapshot = this.snapshot(nowMs);
    const previous = this.lastSnapshot;
    this.lastSnapshot = snapshot;
    if (!previous) {
      this.publish("room.state_changed", { state: snapshot.state }, { chain: { block: this.store.cursorBlock } });
      this._advanceFocus(snapshot);
      return snapshot;
    }

    if (previous.state !== snapshot.state) {
      this.publish("room.state_changed", { state: snapshot.state }, { chain: { block: this.store.cursorBlock } });
    }
    if (previous.source.last_seq !== snapshot.source.last_seq || previous.source.fresh !== snapshot.source.fresh) {
      this.publish(
        "source.freshness_changed",
        { fresh: snapshot.source.fresh, age_ms: snapshot.source.age_ms },
        { sourceSeq: snapshot.source.last_seq }
      );
    }

    const previousSlots = new Map(previous.program.slots.map((slot) => [slot.slot_index, slot]));
    for (const slot of snapshot.program.slots) {
      const before = previousSlots.get(slot.slot_index);
      if (!before) {
        this.publish("slot.published", slot, { chain: { block: this.store.cursorBlock } });
        continue;
      }
      if (before.state !== slot.state) {
        this.publish(
          this._slotEventFor(slot.state),
          { slot_index: slot.slot_index, state: slot.state },
          { chain: { block: this.store.cursorBlock } }
        );
      }
      if (before.price?.implied_prob_a !== slot.price?.implied_prob_a) {
        this.publish("slot.price_changed", { slot_index: slot.slot_index, price: slot.price }, { chain: { block: this.store.cursorBlock } });
      }
      if (before.liquidity?.total_lp_shares !== slot.liquidity?.total_lp_shares) {
        this.publish(
          "slot.liquidity_changed",
          { slot_index: slot.slot_index, liquidity: slot.liquidity },
          { chain: { block: this.store.cursorBlock } }
        );
      }
    }

    this._advanceFocus(snapshot);
    return snapshot;
  }

  _slotEventFor(state) {
    switch (state) {
      case "open":
        return "slot.opened";
      case "suspended":
        return "slot.gate_changed";
      case "closed":
        return "slot.closed";
      case "provisional":
        return "slot.provisional";
      case "challenged":
        return "slot.challenged";
      case "final":
        return "slot.final";
      case "invalid":
        return "slot.invalid";
      default:
        return "slot.gate_changed";
    }
  }

  /** Focus advances to the newest tradable micro slot, else the headline. */
  _advanceFocus(snapshot) {
    const tradable = snapshot.program.slots.filter(
      (slot) => slot.state === "open" || slot.state === "awaiting-liquidity"
    );
    const micro = tradable.filter((slot) => slot.slot_index > 0);
    const next = micro.length > 0 ? micro.at(-1).slot_index : tradable.length > 0 ? tradable[0].slot_index : null;
    if (next !== this.focusSlotIndex) {
      this.focusSlotIndex = next;
      this.publish("room.focus_changed", { slot_index: next }, { chain: { block: this.store.cursorBlock } });
    }
  }

  // ---------------------------------------------------- program sequencing

  /**
   * Asks the Program Publisher to publish a candidate slot when the program's
   * opening rules allow it. The Coordinator can only REQUEST: it holds no key,
   * and the gate must still sign a Publication Permit for the request to reach
   * the chain at all.
   */
  async maybeRequestSlot(candidate, nowMs = Date.now()) {
    if (!this.publisherApi) return { requested: false, reason: "no publisher configured" };
    const snapshot = this.snapshot(nowMs);
    if (snapshot.state !== "live" && snapshot.state !== "armed") {
      return { requested: false, reason: `room ${snapshot.state}` };
    }
    if (snapshot.program.open_count >= (snapshot.program.max_open ?? Infinity)) {
      return { requested: false, reason: "concurrency cap" };
    }
    const headline = snapshot.program.slots.find((slot) => slot.slot_index === 0);
    if (!headline || headline.state === "awaiting-liquidity") {
      return { requested: false, reason: "headline unbacked" };
    }
    if (!snapshot.source.fresh) return { requested: false, reason: "source stale" };
    const key = candidate.templateParamsKey;
    if (this.pendingRequests.has(key)) return { requested: false, reason: "already requested" };
    this.pendingRequests.add(key);
    try {
      const result = await this.publisherApi.requestSlot(candidate);
      return { requested: true, result };
    } finally {
      // Released whatever happened. A rejected call left the key in place
      // forever, so one transient publisher failure permanently blocked that
      // candidate from ever being requested again.
      this.pendingRequests.delete(key);
    }
  }

  // ------------------------------------------------- presentation channels

  setStreamHealth(health) {
    if (health === this.streamHealth) return;
    this.streamHealth = health;
    this.publish("stream.health_changed", { health });
  }

  setViewers(count) {
    this.viewers = count;
    this.publish("viewers.updated", { count });
  }

  heartbeat(nowMs = Date.now()) {
    const snapshot = this.snapshot(nowMs);
    this.publish("heartbeat", {
      room_seq: this.roomSeq,
      source_seq: snapshot.source.last_seq,
      source_age_ms: snapshot.source.age_ms,
      health: snapshot.health,
    });
  }
}
