// Chain Indexer (issue 06): the ONLY writer of chain-derived read models.
//
// It projects the REAL events emitted by LiveMarketFactory, LiveRoom, and
// LivePredictionMarket. Two shapes matter and were originally got wrong:
//
//  - `RoomCreated` is a FACTORY event carrying the room address as an argument.
//    Treating `log.address` as the room recorded the factory instead.
//  - `SlotsClosed` carries a COUNT, not a markets array, so which markets closed
//    must come from each market's own `ForecastingClosed`.
//
// And one thing no log can carry: there is no market-state event. Reserves,
// price, LP shares, and outcome are read from the market's public getters at a
// known block. That read is a projection input like any other, and every row
// records the block it came from.

export const GATE_STATE = { open: 0, suspended: 1, closed: 2 };

/**
 * Room ids are short ASCII on the service side and `bytes32` on chain. The
 * projection keys rooms by the DECODED id so both sides agree; the raw bytes32
 * is kept alongside for chain calls. Without this the read models are keyed by
 * something no service ever asks for, and every room lookup silently misses.
 */
export function decodeRoomId(value) {
  if (typeof value !== "string" || !value.startsWith("0x")) return value;
  const bytes = Buffer.from(value.slice(2), "hex");
  const end = bytes.indexOf(0);
  const body = end === -1 ? bytes : bytes.subarray(0, end);
  if (body.length === 0) return value;
  // Trailing bytes after the first NUL must all be padding, and the body must
  // be printable ASCII, or this is not a text id.
  const padding = end === -1 ? Buffer.alloc(0) : bytes.subarray(end);
  if (padding.some((byte) => byte !== 0)) return value;
  const text = body.toString("utf8");
  return /^[\x20-\x7e]+$/.test(text) ? text : value;
}

const SLOT_TERMINAL = new Set(["final", "invalid"]);
const SLOT_RESOLVING = new Set(["provisional", "challenged"]);

/**
 * How many recent block hashes are retained for reorg comparison.
 *
 * Deeper than any reorg Polygon PoS produces in ordinary operation. A fork older
 * than this cannot be located, and is reported as such rather than guessed at.
 */
export const REORG_WINDOW = 128;

/** How many recent clear latencies are kept. A live signal, not a history. */
export const CLEAR_SAMPLE_WINDOW = 64;

export class ChainIndexer {
  /**
   * @param options.store   ProjectionStore
   * @param options.logs    LogSource port: { getLogs({fromBlock,toBlock}) }
   * @param options.reader  optional MarketReader: { readMarketState(address) }
   *                        Without one, market rows carry only what logs prove.
   * @param options.slotMeta optional Map market -> { question, shape, params,
   *                        openingCondition, closingCondition } — off-chain
   *                        program metadata the chain does not store.
   */
  constructor({ store, logs, reader = null, slotMeta = new Map() }) {
    this.store = store;
    this.logs = logs;
    this.reader = reader;
    this.slotMeta = slotMeta;
    this.cursorBlock = 0;
    this.touchedMarkets = new Set();
    // Log identities already applied, so a re-swept range is idempotent.
    this.appliedLogs = new Set();
    // Recent (block -> hash), newest last. This is the entire basis for noticing
    // a reorg: the head NUMBER can stay put while the history under it is
    // replaced, so a cursor-vs-head comparison cannot see one at all.
    //
    // Bounded because it is a ring, not a history. REORG_WINDOW blocks is far
    // deeper than any reorg Polygon PoS produces in practice; a reorg deeper
    // than this is reported as beyond retained history rather than guessed at.
    this.recentHashes = new Map();
    // Recent (submitted -> executed) durations in seconds. The tail is what
    // matters: past maxPendingTime an uncleared action refunds instead of
    // executing, so the slowest recent clear is the number an operator has to
    // see and a mean would bury it.
    this.clearSamples = [];
    // Actions seen submitted but not yet executed, by market:actionId. Held so
    // the execution can be subtracted from the submission whenever it lands.
    this.pendingClears = new Map();
  }

  /**
   * Indexes forward to the chain head, then refreshes touched market state.
   *
   * The range is swept repeatedly until it stops revealing new addresses. Room
   * and market contracts are discovered from the factory's own logs, so a first
   * sweep of a range can only ask for logs from the addresses it already knew
   * about — and every trade, claim and attestation a market emitted in that
   * same range would be skipped, permanently, because the cursor moves past it.
   * On a cold start against a chain with history that silently loses the entire
   * settlement record, which is exactly the thing this system exists to report.
   *
   * Applied logs are remembered by identity (block, log index, address) and
   * kept for every block ABOVE the cursor. That is what makes both halves safe:
   *
   *   - `apply()` mutates the store irreversibly — holdings accumulate, trades
   *     and claims are appended — and the cursor only advances on success. A
   *     sweep that throws part-way therefore leaves real writes behind with the
   *     cursor unmoved, and the next poll re-fetches the same blocks. Without
   *     the memory, a transient 429 would silently double someone's payout.
   *   - A lagging or reorged node can report a *lower* head afterwards. The
   *     range must then shrink to what the node will actually serve — extending
   *     it to the earlier head would mark blocks indexed that nobody ever
   *     returned, losing everything in them permanently and silently. Keeping
   *     the identities for the blocks above the new cursor is what lets those
   *     blocks be re-fetched later without being applied twice.
   *
   * Identities at or below the cursor are dropped: those blocks are never
   * fetched again, so retaining them would grow with the chain.
   */
  async syncTo(headBlock) {
    const fromBlock = this.cursorBlock + 1;
    if (headBlock < fromBlock) return 0;

    let applied = 0;
    let seenAddresses = -1;
    // Bounded by the number of contracts a range can introduce; each pass must
    // strictly grow the address set or it is the last one.
    for (let pass = 0; pass < 8; pass += 1) {
      const logs = await this.logs.getLogs({ fromBlock, toBlock: headBlock });
      for (const log of logs) {
        const id = `${log.blockNumber}:${log.logIndex}:${String(log.address).toLowerCase()}`;
        if (this.appliedLogs.has(id)) continue;
        // Recorded only after the handler returns. Several handlers throw by
        // design — `_roomByAddress` does, for a log from a room the projection
        // does not know — and recording first marked such a log applied so it
        // was never retried. The cursor then moved past it and the gap was
        // invisible: the sync returned normally and health reported the new
        // block.
        this.apply(log);
        this.appliedLogs.add(id);
        applied += 1;
      }
      const addresses = this._knownAddressCount();
      if (addresses === seenAddresses) break;
      seenAddresses = addresses;
    }

    // The range is fully applied. Refresh market state *before* advancing the
    // cursor: a reader failure must not leave staleness reporting zero lag over
    // rows that were never refreshed.
    await this._measureClears();
    await this.refreshTouchedMarkets(headBlock);
    this.cursorBlock = headBlock;
    this.store.cursorBlock = headBlock;
    this._forgetAppliedThrough(headBlock);
    await this._rememberHashes(fromBlock, headBlock);
    return applied;
  }

  /**
   * Records the hash of each block just indexed, so a later rewrite is visible.
   *
   * A log source that cannot answer `blockHash` disables reorg detection rather
   * than failing the sync — but it does so loudly at the point of use, in
   * `detectReorg`, instead of silently reporting "no reorg" forever.
   */
  async _rememberHashes(fromBlock, toBlock) {
    if (typeof this.logs.blockHash !== "function") return;
    // Only the tail matters: anything older than the window can no longer be
    // compared against, so fetching it would be work nobody reads.
    const start = Math.max(fromBlock, toBlock - REORG_WINDOW + 1);
    for (let block = start; block <= toBlock; block += 1) {
      const hash = await this.logs.blockHash(block);
      if (hash) this.recentHashes.set(block, hash);
    }
    for (const block of this.recentHashes.keys()) {
      if (block < toBlock - REORG_WINDOW) this.recentHashes.delete(block);
    }
  }

  /** The hash of the block the cursor currently sits on, if it is known. */
  async cursorHash() {
    return this.recentHashes.get(this.cursorBlock) ?? null;
  }

  /**
   * Whether the chain rewrote history under the cursor.
   *
   * Returns null when nothing changed, or a description of the divergence:
   * the last block both chains agree on, and whether that could be established
   * at all. It never rolls anything back itself — deciding to discard indexed
   * state is the caller's, and doing it as a side effect of a health check is
   * how a transient RPC answer turns into a wiped projection.
   *
   * @returns {Promise<null | {commonAncestor: number|null, from: number, beyondRetainedHistory: boolean}>}
   */
  async detectReorg() {
    if (typeof this.logs.blockHash !== "function") return null;
    if (this.cursorBlock === 0 || this.recentHashes.size === 0) return null;

    const known = this.recentHashes.get(this.cursorBlock);
    if (!known) return null;
    const current = await this.logs.blockHash(this.cursorBlock);
    // An RPC that cannot answer is not a reorg. Treating an unreadable block as
    // a rewritten one would let one bad response discard a correct projection.
    if (!current || current === known) return null;

    // Walk back through what is retained for the deepest block both agree on.
    const blocks = [...this.recentHashes.keys()].sort((a, b) => b - a);
    for (const block of blocks) {
      if (block >= this.cursorBlock) continue;
      const mine = this.recentHashes.get(block);
      const theirs = await this.logs.blockHash(block);
      if (theirs && theirs === mine) {
        return { commonAncestor: block, from: this.cursorBlock, beyondRetainedHistory: false };
      }
    }
    // Every retained block differs, so the fork is older than anything that can
    // be compared. The honest answer is that the ancestor is unknown.
    return { commonAncestor: null, from: this.cursorBlock, beyondRetainedHistory: true };
  }

  /** Drops identities for blocks the cursor has passed; those never return. */
  _forgetAppliedThrough(block) {
    for (const id of this.appliedLogs) {
      if (Number(id.slice(0, id.indexOf(":"))) <= block) this.appliedLogs.delete(id);
    }
  }

  /** How many contract addresses the projections currently know about. */
  _knownAddressCount() {
    return this.store.rooms.size + this.store.markets.size;
  }

  /**
   * Discards indexed state back to `block` and replays to the head.
   *
   * The rollback is a full rebuild, and that is a real limitation rather than an
   * oversight: the projections do not record which block produced each row, so
   * there is nothing to roll back selectively. A rebuild converges on the
   * canonical chain, which is the property that matters, at O(chain) cost per
   * reorg.
   *
   * ponytail: full rebuild per reorg; record a source block per projected row
   * and roll back selectively if reorg frequency ever makes the replay hurt.
   */
  async rewindTo(block, headBlock) {
    for (const known of [...this.recentHashes.keys()]) {
      if (known > block) this.recentHashes.delete(known);
    }
    return this.rebuild(headBlock);
  }

  /** Full rebuild from genesis — the acceptance gate for "projections only". */
  async rebuild(headBlock) {
    this.store.reset();
    this.cursorBlock = 0;
    this.touchedMarkets = new Set();
    // A rebuild replays everything, so the applied-log set starts empty too;
    // keeping it would make the rebuild silently apply nothing.
    this.appliedLogs = new Set();
    this.recentHashes = new Map();
    return this.syncTo(headBlock);
  }

  apply(log) {
    const handler = this[`_on${log.event}`];
    if (typeof handler === "function") handler.call(this, log);
  }

  /** Reads state no event carries, for every market a log touched. */
  async refreshTouchedMarkets(blockNumber) {
    if (!this.reader) return;
    for (const market of this.touchedMarkets) {
      const state = await this.reader.readMarketState(market, blockNumber);
      const existing = this.store.getMarket(market) ?? {};
      this.store.upsertMarket({
        market_address: market,
        ...existing,
        // These strings are immutable contract configuration. Preserve a
        // previously-read value if a partial/fake reader omits them; never
        // manufacture a name from a source key or wallet address.
        participant_a_name: state.participantAName ?? existing.participant_a_name ?? null,
        participant_b_name: state.participantBName ?? existing.participant_b_name ?? null,
        gate_state: Number(state.gateState),
        // The rate this market actually charges, not an assumed 1%.
        winner_reward_bps: Number(state.winnerRewardBps),
        reserve_a: state.reserveA,
        reserve_b: state.reserveB,
        implied_prob_a: state.spotPriceA,
        total_lp_shares: state.totalLpShares,
        winner_reward_pool: state.winnerRewardPool,
        pending_collateral: state.pendingCollateral,
        collateral_backing: state.collateralBacking,
        unclaimed_lp_fees: state.unclaimedLpFees,
        current_epoch: state.currentEpoch,
        last_safe_seq: state.lastSafeSequence,
        final_outcome: Number(state.finalOutcome),
        // The block IS the timestamp. A wall-clock field would make two
        // rebuilds of the same chain differ, which defeats the whole point of
        // projections being disposable and reproducible.
        block_number: blockNumber,
      });
      this._syncSlotState(market, blockNumber);
    }
    this.touchedMarkets.clear();
  }

  /** Normalised: logs carry lowercase addresses and reads carry checksummed
   *  ones, so a raw Set held the same market twice and read it twice. */
  _touch(market) {
    this.touchedMarkets.add(String(market).toLowerCase());
  }

  // ------------------------------------------------------- factory events

  /// Emitted by the FACTORY. The room address is an argument, not `log.address`.
  _onRoomCreated(log) {
    this.store.upsertRoom({
      room_id: decodeRoomId(log.args.roomId),
      room_id_bytes32: log.args.roomId,
      live_room_address: log.args.room,
      factory_address: log.address,
      state: "armed",
      gate_signer: log.args.gateSigner,
      publisher: log.args.publisher,
      last_observed_seq: 0n,
      closed_source_seq: null,
      room_seq: 0,
      block_number: log.blockNumber,
    });
  }

  _onMarketCreated(log) {
    // Room binding travels with the market so the catalog is complete even
    // before the room's own SlotPublished is indexed.
    const roomId = decodeRoomId(log.args.roomId);
    const room = this._roomById(roomId);
    this.store.upsertMarket({
      market_address: log.args.market,
      room_id: room ? room.room_id : roomId,
      slot_index: Number(log.args.slotIndex),
      template_id: log.args.templateId,
      condition_hash: log.args.conditionHash,
      question: log.args.question,
      stream_url: log.args.streamUrl,
      final_outcome: 0,
      block_number: log.blockNumber,
    });
    this._touch(log.args.market);
  }

  // ---------------------------------------------------------- room events

  _onSlotPublished(log) {
    const room = this._roomByAddress(log.address);
    const market = log.args.market;
    const meta = this.slotMeta.get(market) ?? {};
    const existingMarket = this.store.getMarket(market) ?? {};
    this.store.upsertSlot({
      room_id: room.room_id,
      slot_index: Number(log.args.slotIndex),
      state: "announced",
      shape: meta.shape ?? null,
      question: meta.question ?? existingMarket.question ?? "",
      template_id: log.args.templateId,
      params: meta.params ?? {},
      opening_condition: meta.openingCondition ?? {},
      closing_condition: meta.closingCondition ?? {},
      condition_hash: log.args.conditionHash,
      request_hash: log.args.requestHash,
      permit_nonce: log.args.nonce,
      winner_reward_bps: meta.winnerRewardBps ?? existingMarket.winner_reward_bps ?? null,
      market_address: market,
      published_seq: log.args.undecidedThroughSequence,
      opens_at: log.args.opensAt,
      block_number: log.blockNumber,
    });
    this.store.upsertRoom({
      room_id: room.room_id,
      state: "live",
      last_observed_seq: log.args.undecidedThroughSequence,
      block_number: log.blockNumber,
    });
    this.store.upsertMarket({
      market_address: market,
      room_id: room.room_id,
      slot_index: Number(log.args.slotIndex),
      block_number: log.blockNumber,
    });
    this._touch(market);
  }

  _onRoomEpochsMarkedSafe(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertRoom({
      room_id: room.room_id,
      last_observed_seq: log.args.sourceSequence,
      block_number: log.blockNumber,
    });
  }

  _onRoomSuspended(log) {
    this._roomSequence(log, log.args.sourceSequence);
  }

  _onRoomReopened(log) {
    this._roomSequence(log, log.args.sourceSequence);
  }

  /// Carries a COUNT, not a markets array: which markets closed comes from each
  /// market's own ForecastingClosed event.
  _onSlotsClosed(log) {
    this._roomSequence(log, log.args.decisiveSequence);
  }

  _onRoomClosed(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertRoom({
      room_id: room.room_id,
      state: "closing",
      closed_source_seq: log.args.decisiveSequence,
      last_observed_seq: log.args.decisiveSequence,
      block_number: log.blockNumber,
    });
  }

  _onRoomClosedByGateStall(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertRoom({
      room_id: room.room_id,
      state: "closing",
      closed_by_stall: true,
      stalled_since: log.args.stalledSince,
      block_number: log.blockNumber,
    });
  }

  /// A persistently skipped market refunds its audience rather than settling,
  /// so the skip is recorded rather than inferred from absence.
  _onSlotCallSkipped(log) {
    const room = this._roomByAddress(log.address);
    this.store.appendSkip({
      room_id: room.room_id,
      market: log.args.market,
      epoch: Number(log.args.epoch),
      selector: log.args.selector,
      reason: log.args.reason,
      block_number: log.blockNumber,
    });
  }

  _onIntegrityBondPosted(log) {
    this._bond(log, log.args.participant, { posted: log.args.amount });
  }

  _onIntegrityBondClaimed(log) {
    this._bond(log, log.args.participant, { claimed: log.args.amount });
  }

  _onIntegrityBondForfeited(log) {
    this._bond(log, log.args.participant, { forfeited: log.args.amount, claim_id: Number(log.args.claimId) });
  }

  _onIntegrityClaimFiled(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertIntegrityClaim({
      room_id: room.room_id,
      claim_id: Number(log.args.claimId),
      claimant: log.args.claimant,
      participant: log.args.participant,
      violation_code: log.args.violationCode,
      status: "open",
      block_number: log.blockNumber,
    });
  }

  _onIntegrityClaimAdjudicated(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertIntegrityClaim({
      room_id: room.room_id,
      claim_id: Number(log.args.claimId),
      status: log.args.upheld ? "upheld" : "rejected",
      block_number: log.blockNumber,
    });
  }

  _onIntegrityClaimExpired(log) {
    const room = this._roomByAddress(log.address);
    this.store.upsertIntegrityClaim({
      room_id: room.room_id,
      claim_id: Number(log.args.claimId),
      status: "expired",
      block_number: log.blockNumber,
    });
  }

  // -------------------------------------------------------- market events

  _onActionSubmitted(log) {
    this.pendingClears.set(`${String(log.address).toLowerCase()}:${Number(log.args.actionId)}`, {
      submittedBlock: log.blockNumber,
      executedBlock: null,
    });
    // The event carries no outcome side; that is only knowable from execution
    // or from the action book, so it is left null rather than guessed.
    this.store.upsertAction({
      market_address: log.address,
      action_id: Number(log.args.actionId),
      epoch: Number(log.args.epoch),
      kind: Number(log.args.kind),
      status: 0,
      account: log.args.user,
      outcome_a: null,
      amount: log.args.amount,
      return_amount: null,
      submitted_block: log.blockNumber,
      settled_block: null,
    });
    this._touch(log.address);
  }

  /**
   * Turns submitted/executed block pairs into clear latencies in seconds.
   *
   * Deferred to the end of a sync rather than done inside the handlers because
   * it needs block timestamps, which are an RPC read the handlers are not
   * allowed to make — they are synchronous and must stay that way, since a
   * projection that awaits mid-apply can interleave two logs for one market.
   *
   * A block whose time cannot be read produces NO sample. Guessing seconds from
   * block counts would report a latency this system never measured.
   */
  async _measureClears() {
    if (typeof this.logs.blockTimestamp !== "function") return;
    for (const [key, pair] of [...this.pendingClears]) {
      if (pair.executedBlock === null || pair.executedBlock === undefined) continue;
      const [from, to] = await Promise.all([
        this.logs.blockTimestamp(pair.submittedBlock),
        this.logs.blockTimestamp(pair.executedBlock),
      ]);
      this.pendingClears.delete(key);
      if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) continue;
      this.clearSamples.push(Math.max(0, Number(to) - Number(from)));
    }
    // Bounded: this is a live signal, not a history.
    if (this.clearSamples.length > CLEAR_SAMPLE_WINDOW) {
      this.clearSamples = this.clearSamples.slice(-CLEAR_SAMPLE_WINDOW);
    }
  }

  /**
   * The slowest recent clear, in seconds, or null when nothing has cleared.
   *
   * Null rather than zero, deliberately: a room where actions are piling up
   * unexecuted has no samples, and a zero there would read as a perfectly fast
   * room at exactly the moment one was failing.
   */
  epochClearSeconds() {
    if (this.clearSamples.length === 0) return null;
    return Math.max(...this.clearSamples);
  }

  _onActionExecuted(log) {
    const key = `${String(log.address).toLowerCase()}:${Number(log.args.actionId)}`;
    const pending = this.pendingClears.get(key);
    if (pending) pending.executedBlock = log.blockNumber;
    this.store.upsertAction({
      market_address: log.address,
      action_id: Number(log.args.actionId),
      status: 1,
      return_amount: log.args.returnAmount,
      settled_block: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onActionRefunded(log) {
    this.store.upsertAction({
      market_address: log.address,
      action_id: Number(log.args.actionId),
      status: 2,
      refunded_amount: log.args.amount,
      settled_block: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onEpochMarkedSafe(log) {
    this.store.recordSafeEpoch(log.address, Number(log.args.epoch), log.args.sourceSequence, log.blockNumber);
    this._touch(log.address);
  }

  _onGateSuspended(log) {
    this._touch(log.address);
  }

  _onGateReopened(log) {
    this._touch(log.address);
  }

  _onForecastingClosed(log) {
    const slot = this.store.slotByMarket(log.address);
    if (slot) {
      this.store.upsertSlot({
        room_id: slot.room_id,
        slot_index: slot.slot_index,
        state: "closed",
        closed_seq: log.args.decisiveSequence,
        block_number: log.blockNumber,
      });
    }
    this._touch(log.address);
  }

  _onTrade(log) {
    const delta = log.args.isBuy
      ? log.args.participantAOutcome
        ? { position_a: log.args.amountOut }
        : { position_b: log.args.amountOut }
      : log.args.participantAOutcome
        ? { position_a: -log.args.amountIn }
        : { position_b: -log.args.amountIn };
    this.store.adjustHolding(log.address, log.args.user, delta, log.blockNumber);
    this.store.appendTrade({
      market_address: log.address,
      account: log.args.user,
      outcome_a: log.args.participantAOutcome,
      is_buy: log.args.isBuy,
      amount_in: log.args.amountIn,
      amount_out: log.args.amountOut,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onLiquidityAdded(log) {
    this.store.adjustHolding(
      log.address,
      log.args.provider,
      {
        lp_shares: log.args.sharesMinted,
        position_a: log.args.adjustmentA ?? 0n,
        position_b: log.args.adjustmentB ?? 0n,
      },
      log.blockNumber
    );
    this._touch(log.address);
  }

  _onPositionTransferred(log) {
    const key = log.args.participantAOutcome ? "position_a" : "position_b";
    this.store.adjustHolding(log.address, log.args.from, { [key]: -log.args.amount }, log.blockNumber);
    this.store.adjustHolding(log.address, log.args.to, { [key]: log.args.amount }, log.blockNumber);
    this._touch(log.address);
  }

  _onPositionsRedeemed(log) {
    this.store.adjustHolding(
      log.address,
      log.args.user,
      { position_a: -log.args.amountA, position_b: -log.args.amountB },
      log.blockNumber
    );
    this.store.appendClaim({
      market_address: log.address,
      account: log.args.user,
      kind: "redeem",
      amount: log.args.payout,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onLpInventorySettled(log) {
    this.store.adjustHolding(log.address, log.args.provider, { lp_shares: -log.args.shares }, log.blockNumber);
    this.store.appendClaim({
      market_address: log.address,
      account: log.args.provider,
      kind: "lp_inventory",
      amount: log.args.payout,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onLpFeesClaimed(log) {
    this.store.appendClaim({
      market_address: log.address,
      account: log.args.provider,
      kind: "lp_fees",
      amount: log.args.amount,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onWinnerRewardClaimed(log) {
    this.store.appendClaim({
      market_address: log.address,
      account: log.args.recipient,
      kind: "winner_reward",
      amount: log.args.amount,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onInvalidWinnerFeeRefunded(log) {
    this.store.appendClaim({
      market_address: log.address,
      account: log.args.forecaster,
      kind: "winner_fee_refund",
      amount: log.args.amount,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onResultAttested(log) {
    this.store.appendAttestation({
      market_address: log.address,
      resolver: log.args.resolver,
      outcome: Number(log.args.outcome),
      evidence_hash: log.args.evidenceHash,
      count: Number(log.args.count),
      block_number: log.blockNumber,
    });
  }

  _onProvisionalResultRegistered(log) {
    const slot = this.store.slotByMarket(log.address);
    if (slot) {
      this.store.upsertSlot({
        room_id: slot.room_id,
        slot_index: slot.slot_index,
        state: "provisional",
        block_number: log.blockNumber,
      });
    }
    this.store.upsertMarket({
      market_address: log.address,
      provisional_outcome: Number(log.args.outcome),
      provisional_evidence_hash: log.args.evidenceHash,
      challenge_ends_at: log.args.challengeEndsAt,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onResultChallenged(log) {
    const slot = this.store.slotByMarket(log.address);
    if (slot) {
      this.store.upsertSlot({
        room_id: slot.room_id,
        slot_index: slot.slot_index,
        state: "challenged",
        block_number: log.blockNumber,
      });
    }
    this.store.upsertMarket({
      market_address: log.address,
      challenger: log.args.challenger,
      challenge_evidence_hash: log.args.evidenceHash,
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onChallengeVerdictAttested(log) {
    this.store.appendChallengeVerdict({
      market_address: log.address,
      resolver: log.args.resolver,
      accept_challenge: Boolean(log.args.acceptChallenge),
      count: Number(log.args.count),
      block_number: log.blockNumber,
    });
    this._touch(log.address);
  }

  _onResultFinalized(log) {
    const outcome = Number(log.args.outcome);
    this.store.upsertMarket({
      market_address: log.address,
      final_outcome: outcome,
      // `block_number` is freshness and advances on later reads/events. The
      // finalization block is an immutable historical fact and must survive
      // those refreshes for a truthful settlement timeline.
      finalized_block_number: log.blockNumber,
      block_number: log.blockNumber,
    });
    const slot = this.store.slotByMarket(log.address);
    if (slot) {
      this.store.upsertSlot({
        room_id: slot.room_id,
        slot_index: slot.slot_index,
        state: outcome === 4 ? "invalid" : "final",
        block_number: log.blockNumber,
      });
      this._maybeSettleRoom(slot.room_id, log.blockNumber);
    }
    this._touch(log.address);
  }

  // --------------------------------------------------------------- helpers

  _roomSequence(log, sequence) {
    const room = this._roomByAddress(log.address);
    this.store.upsertRoom({
      room_id: room.room_id,
      last_observed_seq: sequence,
      block_number: log.blockNumber,
    });
  }

  _bond(log, participant, fields) {
    const room = this._roomByAddress(log.address);
    this.store.upsertBond({
      room_id: room.room_id,
      participant,
      ...fields,
      block_number: log.blockNumber,
    });
  }

  _roomByAddress(address) {
    const room = [...this.store.rooms.values()].find(
      (entry) => String(entry.live_room_address).toLowerCase() === String(address).toLowerCase()
    );
    if (!room) throw new Error(`unknown room contract ${address}`);
    return room;
  }

  _roomById(roomId) {
    return [...this.store.rooms.values()].find((entry) => entry.room_id === roomId) ?? null;
  }

  /** Derives slot state from freshly-read market state, without overwriting a
   *  resolution state a log already established. */
  _syncSlotState(market, blockNumber) {
    const slot = this.store.slotByMarket(market);
    if (!slot) return;
    if (SLOT_TERMINAL.has(slot.state) || SLOT_RESOLVING.has(slot.state)) return;
    const row = this.store.getMarket(market);
    if (!row) return;
    let state;
    if (Number(row.final_outcome ?? 0) !== 0) state = Number(row.final_outcome) === 4 ? "invalid" : "final";
    else if (Number(row.gate_state) === GATE_STATE.closed) state = "closed";
    else if (Number(row.gate_state) === GATE_STATE.suspended) state = "suspended";
    else if ((row.total_lp_shares ?? 0n) === 0n) state = "awaiting-liquidity";
    else state = "open";
    if (state !== slot.state) {
      this.store.upsertSlot({
        room_id: slot.room_id,
        slot_index: slot.slot_index,
        state,
        block_number: blockNumber,
      });
    }
  }

  _maybeSettleRoom(roomId, blockNumber) {
    const room = this.store.getRoom(roomId);
    if (!room || room.closed_source_seq === null || room.closed_source_seq === undefined) return;
    const slots = this.store.listSlots(roomId);
    const allSettled = slots.length > 0 && slots.every((slot) => SLOT_TERMINAL.has(slot.state));
    if (!allSettled) {
      this.store.upsertRoom({ room_id: roomId, state: "settling", block_number: blockNumber });
      return;
    }
    const anyValid = slots.some((slot) => slot.state === "final");
    this.store.upsertRoom({
      room_id: roomId,
      state: anyValid ? "final" : "invalid",
      block_number: blockNumber,
    });
  }
}
