// Read-model projection store (issue 06). Implements the query surface the
// spec's SQL schema describes, in memory with an optional file snapshot.
//
// Two rules keep the projections honest:
//  - implied_prob_a is the CLEARED price from on-chain reserves; pending
//    actions are surfaced separately as pending pressure, never folded in.
//  - every chain-derived row carries the block it came from, and reads past a
//    staleness threshold are flagged rather than served as confident data.

/**
 * Addresses arrive in two cases: chain logs carry them lowercase, while contract
 * reads and callers carry them checksummed. Keying rows by the raw string means
 * a Trade indexed from a log and a holding queried by a caller land in different
 * buckets — the projection reports zero while the chain says otherwise. Every
 * address key is normalised here so that cannot happen.
 */
function key(address) {
  return typeof address === "string" ? address.toLowerCase() : address;
}

export class ProjectionStore {
  constructor() {
    this.reset();
  }

  reset() {
    this.rooms = new Map();
    this.slots = new Map(); // `${roomId}:${slotIndex}` -> row
    this.markets = new Map(); // market -> row
    this.actions = new Map(); // `${market}:${actionId}` -> row
    this.holdings = new Map(); // `${market}:${account}` -> row
    this.roomEvents = [];
    // Tables the real chain events populate. Each is append-only or keyed, and
    // every row records the block it was derived from.
    this.skips = [];
    this.trades = [];
    this.claims = [];
    this.attestations = [];
    this.challengeVerdicts = [];
    this.integrityClaims = new Map();
    this.bonds = new Map();
    this.safeEpochs = new Map(); // `${market}:${epoch}` -> row
    this.cursorBlock = 0;
  }

  upsertRoom(row) {
    const existing = this.rooms.get(row.room_id) ?? {};
    this.rooms.set(row.room_id, { ...existing, ...row });
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  listRooms(filter = {}) {
    return [...this.rooms.values()].filter((room) => (filter.state ? room.state === filter.state : true));
  }

  upsertSlot(row) {
    const key = `${row.room_id}:${row.slot_index}`;
    const existing = this.slots.get(key) ?? {};
    this.slots.set(key, { ...existing, ...row });
  }

  getSlot(roomId, slotIndex) {
    return this.slots.get(`${roomId}:${slotIndex}`) ?? null;
  }

  listSlots(roomId) {
    return [...this.slots.values()]
      .filter((slot) => slot.room_id === roomId)
      .sort((a, b) => a.slot_index - b.slot_index);
  }

  slotByMarket(market) {
    return [...this.slots.values()].find((slot) => key(slot.market_address) === key(market)) ?? null;
  }

  upsertMarket(row) {
    const id = key(row.market_address);
    const existing = this.markets.get(id) ?? {};
    this.markets.set(id, { ...existing, ...row, market_address: existing.market_address ?? row.market_address });
  }

  getMarket(market) {
    return this.markets.get(key(market)) ?? null;
  }

  upsertAction(row) {
    const id = `${key(row.market_address)}:${row.action_id}`;
    const existing = this.actions.get(id) ?? {};
    this.actions.set(id, { ...existing, ...row });
  }

  listActions(market, { account = null, status = null } = {}) {
    return [...this.actions.values()]
      .filter((action) => (market ? key(action.market_address) === key(market) : true))
      .filter((action) => (account ? key(action.account) === key(account) : true))
      .filter((action) => (status === null ? true : action.status === status))
      .sort((a, b) => a.action_id - b.action_id);
  }

  listAccountActions(account) {
    return [...this.actions.values()]
      .filter((action) => key(action.account) === key(account))
      .sort((a, b) => a.submitted_block - b.submitted_block);
  }

  adjustHolding(market, account, delta, blockNumber) {
    const id = `${key(market)}:${key(account)}`;
    const row = this.holdings.get(id) ?? {
      market_address: market,
      account,
      position_a: 0n,
      position_b: 0n,
      lp_shares: 0n,
      block_number: blockNumber,
    };
    row.position_a += delta.position_a ?? 0n;
    row.position_b += delta.position_b ?? 0n;
    row.lp_shares += delta.lp_shares ?? 0n;
    row.block_number = blockNumber;
    this.holdings.set(id, row);
  }

  getHolding(market, account) {
    return (
      this.holdings.get(`${key(market)}:${key(account)}`) ?? {
        market_address: market,
        account,
        position_a: 0n,
        position_b: 0n,
        lp_shares: 0n,
        block_number: this.cursorBlock,
      }
    );
  }

  listAccountHoldings(account) {
    return [...this.holdings.values()].filter(
      (row) => key(row.account) === key(account) && (row.position_a > 0n || row.position_b > 0n || row.lp_shares > 0n)
    );
  }

  appendSkip(row) {
    this.skips.push(row);
  }

  /** Skips recorded for a market, oldest first. A persistent skip means that
   *  market refunds its audience rather than settling. */
  listSkips(market = null) {
    return this.skips.filter((row) => (market ? key(row.market) === key(market) : true));
  }

  appendTrade(row) {
    this.trades.push(row);
  }

  listTrades(market = null, sinceBlock = 0) {
    return this.trades.filter(
      (row) => (market ? key(row.market_address) === key(market) : true) && row.block_number > sinceBlock
    );
  }

  appendClaim(row) {
    this.claims.push(row);
  }

  listClaims(account = null) {
    return this.claims.filter((row) => (account ? key(row.account) === key(account) : true));
  }

  appendAttestation(row) {
    this.attestations.push(row);
  }

  listAttestations(market) {
    return this.attestations.filter((row) => key(row.market_address) === key(market));
  }

  appendChallengeVerdict(row) {
    this.challengeVerdicts.push(row);
  }

  listChallengeVerdicts(market) {
    return this.challengeVerdicts.filter((row) => key(row.market_address) === key(market));
  }

  upsertIntegrityClaim(row) {
    const key = `${row.room_id}:${row.claim_id}`;
    this.integrityClaims.set(key, { ...(this.integrityClaims.get(key) ?? {}), ...row });
  }

  listIntegrityClaims(roomId) {
    return [...this.integrityClaims.values()].filter((row) => row.room_id === roomId);
  }

  upsertBond(row) {
    const key = `${row.room_id}:${row.participant}`;
    this.bonds.set(key, { ...(this.bonds.get(key) ?? {}), ...row });
  }

  listBonds(roomId) {
    return [...this.bonds.values()].filter((row) => row.room_id === roomId);
  }

  recordSafeEpoch(market, epoch, sourceSequence, blockNumber) {
    this.safeEpochs.set(`${key(market)}:${epoch}`, {
      market_address: market,
      epoch,
      source_sequence: sourceSequence,
      block_number: blockNumber,
    });
  }

  isEpochSafe(market, epoch) {
    return this.safeEpochs.has(`${key(market)}:${epoch}`);
  }

  appendRoomEvent(event) {
    this.roomEvents.push(event);
  }

  listRoomEvents(roomId, sinceSeq = 0) {
    return this.roomEvents.filter((event) => event.room === roomId && event.seq > sinceSeq);
  }

  /** Pending pressure: escrowed collateral not yet applied to the curve. */
  pendingPressure(market) {
    const pending = this.listActions(market, { status: 0 });
    let buyA = 0n;
    let buyB = 0n;
    let liquidity = 0n;
    for (const action of pending) {
      if (action.kind === 0) {
        if (action.outcome_a) buyA += action.amount;
        else buyB += action.amount;
      } else if (action.kind === 2) {
        liquidity += action.amount;
      }
    }
    return { count: pending.length, buyA, buyB, liquidity };
  }

  /** Staleness flag for any read: how far the projection trails the head. */
  staleness(headBlock, threshold = 3) {
    const lag = headBlock - this.cursorBlock;
    return { lag, stale: lag > threshold, cursorBlock: this.cursorBlock };
  }

  /** Deterministic snapshot for rebuild comparison. */
  fingerprint() {
    const stable = (map) =>
      [...map.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, value]) => [key, JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item))]);
    const list = (rows) =>
      JSON.stringify(rows, (_, item) => (typeof item === "bigint" ? item.toString() : item));
    return JSON.stringify({
      rooms: stable(this.rooms),
      slots: stable(this.slots),
      markets: stable(this.markets),
      actions: stable(this.actions),
      holdings: stable(this.holdings),
      integrityClaims: stable(this.integrityClaims),
      bonds: stable(this.bonds),
      safeEpochs: stable(this.safeEpochs),
      skips: list(this.skips),
      trades: list(this.trades),
      claims: list(this.claims),
      attestations: list(this.attestations),
    });
  }
}
