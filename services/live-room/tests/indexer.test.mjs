// Issue 06: the indexer projects chain logs into read models.
//
// These tests use the REAL event names and argument shapes, taken from the
// compiled ABIs. The previous version of this file invented its own shapes and
// every test passed while the indexer could not read a single real log:
// `RoomCreated` is a factory event, `SlotsClosed` carries a count rather than a
// markets array, `ActionSubmitted` has no outcome field, and `MarketState` — the
// event the whole price projection depended on — does not exist.
//
// The coverage test below is the guard: it checks every projected event against
// the built ABI, so the same drift cannot happen again silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainIndexer, GATE_STATE } from "../src/indexer/indexer.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { abis, INDEXED_EVENTS, verifyEventCoverage } from "../src/indexer/abi.mjs";

const FACTORY = "0xFACTORY";
const ROOM = "0xROOM";
const HEADLINE = "0xM0";
const MICRO = "0xM1";
// The chain carries bytes32; the projection keys rooms by the decoded id so
// both sides of the seam agree.
const ROOM_ID_BYTES32 = "0x726f6f6d2d310000000000000000000000000000000000000000000000000000";
const ROOM_ID = "room-1";

class FakeLogSource {
  constructor(logs) {
    this.logs = logs;
  }

  async getLogs({ fromBlock, toBlock }) {
    return this.logs
      .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
}

/** Market state as the getters actually return it. */
class FakeMarketReader {
  constructor(states) {
    this.states = states;
  }

  async readMarketState(market) {
    // Case-insensitive, like a real chain client: logs carry lowercase
    // addresses and contract reads carry checksummed ones.
    const wanted = String(market).toLowerCase();
    const found = [...this.states.entries()].find(([address]) => String(address).toLowerCase() === wanted);
    return (
      found?.[1] ?? {
        participantAName: "Alice",
        participantBName: "Bob",
        gateState: 0,
        reserveA: 0n,
        reserveB: 0n,
        spotPriceA: 500000n,
        totalLpShares: 0n,
        winnerRewardPool: 0n,
        pendingCollateral: 0n,
        collateralBacking: 0n,
        unclaimedLpFees: 0n,
        currentEpoch: 0n,
        lastSafeSequence: 0n,
        finalOutcome: 0,
        provisionalAt: 0n,
      }
    );
  }
}

function state(overrides = {}) {
  return {
    participantAName: "Alice",
    participantBName: "Bob",
    gateState: GATE_STATE.open,
    reserveA: 1000n,
    reserveB: 1000n,
    spotPriceA: 500000n,
    totalLpShares: 1000n,
    winnerRewardPool: 0n,
    pendingCollateral: 0n,
    collateralBacking: 1000n,
    unclaimedLpFees: 0n,
    currentEpoch: 1n,
    lastSafeSequence: 2n,
    finalOutcome: 0,
    provisionalAt: 0n,
    ...overrides,
  };
}

let logIndex = 0;
const at = (blockNumber, address, event, args) => ({
  blockNumber,
  logIndex: logIndex++,
  address,
  event,
  args,
});

/** A session in real event shapes, exactly as the contracts emit them. */
function session() {
  logIndex = 0;
  return [
    at(1, FACTORY, "RoomCreated", { room: ROOM, roomId: ROOM_ID, publisher: "0xPUB", gateSigner: "0xGATE" }),
    at(2, FACTORY, "MarketCreated", {
      market: HEADLINE,
      participantA: "0xPA",
      participantB: "0xPB",
      roomId: ROOM_ID_BYTES32,
      slotIndex: 0,
      templateId: "0xTPL",
      conditionHash: "0xC0",
      question: "Who wins?",
      streamUrl: "https://example.com/live",
    }),
    at(2, ROOM, "SlotPublished", {
      market: HEADLINE,
      slotIndex: 0,
      templateId: "0xTPL",
      requestHash: "0xR0",
      conditionHash: "0xC0",
      nonce: 1n,
      undecidedThroughSequence: 10n,
      opensAt: 1700000030n,
    }),
    at(3, HEADLINE, "ActionSubmitted", { actionId: 0n, epoch: 1n, kind: 2, user: "0xLP", amount: 1000n }),
    at(4, HEADLINE, "EpochMarkedSafe", { epoch: 1n, sourceSequence: 11n }),
    at(4, HEADLINE, "ActionExecuted", { actionId: 0n, epoch: 1n, returnAmount: 1000n }),
    at(4, HEADLINE, "LiquidityAdded", {
      provider: "0xLP",
      collateralAmount: 1000n,
      sharesMinted: 1000n,
      adjustmentA: 0n,
      adjustmentB: 0n,
    }),
    at(5, ROOM, "RoomEpochsMarkedSafe", { sourceSequence: 11n, cleared: 1n, skipped: 0n }),
    at(6, FACTORY, "MarketCreated", {
      market: MICRO,
      participantA: "0xPA",
      participantB: "0xPB",
      roomId: ROOM_ID_BYTES32,
      slotIndex: 1,
      templateId: "0xTPL2",
      conditionHash: "0xC1",
      question: "Will Bob exceed 2%?",
      streamUrl: "",
    }),
    at(6, ROOM, "SlotPublished", {
      market: MICRO,
      slotIndex: 1,
      templateId: "0xTPL2",
      requestHash: "0xR1",
      conditionHash: "0xC1",
      nonce: 2n,
      undecidedThroughSequence: 20n,
      opensAt: 1700000090n,
    }),
    at(7, HEADLINE, "ActionSubmitted", { actionId: 1n, epoch: 2n, kind: 0, user: "0xTRADER", amount: 100n }),
    at(8, ROOM, "RoomSuspended", { sourceSequence: 25n }),
    at(8, HEADLINE, "GateSuspended", { sourceSequence: 25n }),
    at(9, ROOM, "RoomReopened", { sourceSequence: 30n }),
    at(9, HEADLINE, "GateReopened", { sourceSequence: 30n }),
    at(10, HEADLINE, "ActionExecuted", { actionId: 1n, epoch: 2n, returnAmount: 90n }),
    at(10, HEADLINE, "Trade", {
      user: "0xTRADER",
      participantAOutcome: true,
      isBuy: true,
      amountIn: 100n,
      amountOut: 90n,
    }),
    at(11, ROOM, "SlotsClosed", { decisiveSequence: 40n, closed: 1n }),
    at(11, MICRO, "ForecastingClosed", { epoch: 4n, decisiveSequence: 40n }),
    at(12, MICRO, "ResultAttested", { resolver: "0xR1", outcome: 1, evidenceHash: "0xE", count: 1 }),
    at(12, MICRO, "ResultAttested", { resolver: "0xR2", outcome: 1, evidenceHash: "0xE", count: 2 }),
    at(12, MICRO, "ProvisionalResultRegistered", { outcome: 1, evidenceHash: "0xE", challengeEndsAt: 1700001000n }),
    at(13, MICRO, "ResultFinalized", { outcome: 1 }),
    at(14, ROOM, "RoomClosed", { decisiveSequence: 50n }),
    at(14, HEADLINE, "ForecastingClosed", { epoch: 6n, decisiveSequence: 50n }),
    at(15, HEADLINE, "ResultFinalized", { outcome: 2 }),
    at(16, HEADLINE, "PositionsRedeemed", { user: "0xTRADER", amountA: 90n, amountB: 0n, payout: 0n }),
    at(16, ROOM, "IntegrityBondClaimed", { participant: "0xPA", amount: 100000000n }),
  ];
}

function build(logs, states = new Map()) {
  const store = new ProjectionStore();
  const indexer = new ChainIndexer({
    store,
    logs: new FakeLogSource(logs),
    reader: new FakeMarketReader(states),
  });
  return { store, indexer };
}

function marketStates() {
  return new Map([
    [HEADLINE, state({ gateState: GATE_STATE.closed, finalOutcome: 2 })],
    [MICRO, state({ gateState: GATE_STATE.closed, finalOutcome: 1, totalLpShares: 0n })],
  ]);
}

// ------------------------------------------------------- the drift guard

test("every event the indexer projects exists in the compiled ABI", () => {
  const verdict = verifyEventCoverage();
  assert.equal(verdict.ok, true, `missing from the ABI: ${verdict.missing.join(", ")}`);
});

test("the indexer handles exactly the events it declares, and no invented ones", async () => {
  const source = (await import("node:fs")).readFileSync(
    new URL("../src/indexer/indexer.mjs", import.meta.url),
    "utf8"
  );
  const handled = [...source.matchAll(/_on([A-Za-z]+)\(log\)/g)].map((match) => match[1]);
  const declared = new Set(Object.values(INDEXED_EVENTS).flat());
  for (const name of handled) {
    assert.ok(declared.has(name), `_on${name} handles an event that is not in INDEXED_EVENTS`);
  }
});

// ------------------------------------------------------------ projection

test("indexes a full session from real event shapes", async () => {
  const { store, indexer } = build(session(), marketStates());
  await indexer.syncTo(16);

  const room = store.getRoom(ROOM_ID);
  assert.equal(room.live_room_address, ROOM, "the room address comes from the factory event argument");
  assert.equal(room.factory_address, FACTORY);
  assert.equal(room.state, "final");
  assert.equal(room.closed_source_seq, 50n);

  assert.equal(store.listSlots(ROOM_ID).length, 2);
  assert.equal(store.getSlot(ROOM_ID, 0).state, "final");
  assert.equal(store.getSlot(ROOM_ID, 0).question, "Who wins?", "question comes from MarketCreated");
  assert.equal(store.getSlot(ROOM_ID, 1).state, "final");
  assert.equal(store.getSlot(ROOM_ID, 1).closed_seq, 40n, "closed by the market's own ForecastingClosed");

  assert.equal(store.getMarket(HEADLINE).gate_state, GATE_STATE.closed);
  assert.equal(store.getMarket(HEADLINE).implied_prob_a, 500000n, "price read from the getter, not invented");
  assert.equal(store.getMarket(HEADLINE).participant_a_name, "Alice", "display labels are frozen from the market contract");
  assert.equal(store.getMarket(HEADLINE).participant_b_name, "Bob");
  assert.equal(store.getMarket(HEADLINE).finalized_block_number, 15, "the finalization event has its own immutable block");
  assert.equal(store.getMarket(MICRO).finalized_block_number, 13);
  assert.equal(store.getHolding(HEADLINE, "0xTRADER").position_a, 0n, "redeemed positions are cleared");
  assert.equal(store.getHolding(HEADLINE, "0xLP").lp_shares, 1000n);
  assert.equal(store.listAttestations(MICRO).length, 2, "resolver attestations recorded");
  assert.equal(store.listClaims("0xTRADER").length, 1);
  assert.ok(store.isEpochSafe(HEADLINE, 1), "safe epochs recorded from EpochMarkedSafe");
});

test("a market never touched by a log is never invented", async () => {
  const { store, indexer } = build(session().slice(0, 3), marketStates());
  await indexer.syncTo(2);
  assert.equal(store.getMarket(MICRO), null, "the second market does not exist yet");
});

test("dropping and rebuilding reproduces identical state", async () => {
  const logs = session();
  const { store, indexer } = build(logs, marketStates());
  await indexer.syncTo(16);
  const before = store.fingerprint();

  await indexer.rebuild(16);
  assert.equal(store.fingerprint(), before, "rebuild from genesis is byte-identical");

  const other = build(logs, marketStates());
  await other.indexer.syncTo(16);
  assert.equal(other.store.fingerprint(), before);
});

test("incremental sync converges to the same state as one-shot", async () => {
  const logs = session();
  const oneShot = build(logs, marketStates());
  await oneShot.indexer.syncTo(16);

  const incremental = build(logs, marketStates());
  for (let block = 1; block <= 16; block++) await incremental.indexer.syncTo(block);

  // Block numbers on state rows differ by construction (they record when the
  // read happened), so compare the settled facts rather than the read stamps.
  assert.equal(incremental.store.getRoom(ROOM_ID).state, oneShot.store.getRoom(ROOM_ID).state);
  assert.equal(incremental.store.getSlot(ROOM_ID, 0).state, oneShot.store.getSlot(ROOM_ID, 0).state);
  assert.equal(incremental.store.getSlot(ROOM_ID, 1).state, oneShot.store.getSlot(ROOM_ID, 1).state);
  assert.equal(
    incremental.store.getHolding(HEADLINE, "0xLP").lp_shares,
    oneShot.store.getHolding(HEADLINE, "0xLP").lp_shares
  );
});

test("a reorg converges to the canonical chain with no orphans", async () => {
  const logs = session();
  const { store, indexer } = build(logs, marketStates());
  await indexer.syncTo(13);
  assert.equal(store.getSlot(ROOM_ID, 1).state, "final");

  const canonical = logs
    .filter((log) => log.blockNumber < 12)
    .concat([
      { blockNumber: 12, logIndex: 900, address: MICRO, event: "ResultFinalized", args: { outcome: 4 } },
    ]);
  indexer.logs = new FakeLogSource(canonical);
  await indexer.rewindTo(12, 13);

  assert.equal(store.getSlot(ROOM_ID, 1).state, "invalid", "converged to the canonical outcome");
  assert.equal(store.listSlots(ROOM_ID).filter((slot) => slot.slot_index === 1).length, 1, "no orphan rows");
});

test("cleared price never includes pending pressure", async () => {
  const logs = session().filter((log) => log.blockNumber <= 7);
  const { store, indexer } = build(logs, new Map([[HEADLINE, state()]]));
  await indexer.syncTo(7);

  assert.equal(store.getMarket(HEADLINE).implied_prob_a, 500000n, "the cleared on-chain price");
  const pressure = store.pendingPressure(HEADLINE);
  assert.equal(pressure.count, 1, "the pending buy is surfaced separately");
});

test("skipped gate calls are recorded rather than inferred from absence", async () => {
  const logs = session().concat([
    at(17, ROOM, "SlotCallSkipped", { market: HEADLINE, epoch: 7n, selector: "0x1234abcd", reason: "0xdead" }),
  ]);
  const { store, indexer } = build(logs, marketStates());
  await indexer.syncTo(17);
  const skips = store.listSkips(HEADLINE);
  assert.equal(skips.length, 1);
  assert.equal(skips[0].epoch, 7);
});

test("a gate-stall close is recorded as such", async () => {
  const logs = session()
    .filter((log) => log.event !== "RoomClosed")
    .concat([
      at(20, ROOM, "RoomClosedByGateStall", { sequence: 60n, caller: "0xKEEPER", stalledSince: 1700000000n }),
    ]);
  const { store, indexer } = build(logs, marketStates());
  await indexer.syncTo(20);
  const room = store.getRoom(ROOM_ID);
  assert.equal(room.closed_by_stall, true);
  assert.equal(room.stalled_since, 1700000000n);
});

test("integrity claims and bonds project", async () => {
  const logs = session().concat([
    at(18, ROOM, "IntegrityClaimFiled", {
      claimId: 0n,
      claimant: "0xCLAIMANT",
      participant: "0xPA",
      violationCode: "0xV1",
    }),
    at(19, ROOM, "IntegrityClaimAdjudicated", { claimId: 0n, upheld: false }),
  ]);
  const { store, indexer } = build(logs, marketStates());
  await indexer.syncTo(19);
  const claims = store.listIntegrityClaims(ROOM_ID);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "rejected");
  assert.equal(store.listBonds(ROOM_ID).length, 1);
});

test("staleness is flagged rather than served as confident data", async () => {
  const { store, indexer } = build(session(), marketStates());
  await indexer.syncTo(5);
  assert.equal(store.staleness(6).stale, false);
  assert.equal(store.staleness(60).stale, true);
});

test("address case never splits a projection", () => {
  // Chain logs carry lowercase addresses; contract reads and callers carry
  // checksummed ones. A store that keys on the raw string reports zero holdings
  // for a position the chain plainly shows — the exact failure a real chain run
  // exposed and no fixture ever would.
  const store = new ProjectionStore();
  const lower = "0xabcdef0123456789abcdef0123456789abcdef01";
  const checksummed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  store.adjustHolding(lower, lower, { position_a: 90n }, 1);
  assert.equal(store.getHolding(checksummed, checksummed).position_a, 90n, "checksummed read finds it");
  assert.equal(store.getHolding(lower, lower).position_a, 90n, "lowercase read finds it");

  store.upsertMarket({ market_address: lower, room_id: "r", final_outcome: 0, block_number: 1 });
  assert.ok(store.getMarket(checksummed), "market lookup is case-insensitive");

  store.appendTrade({ market_address: lower, account: lower, block_number: 2 });
  assert.equal(store.listTrades(checksummed).length, 1);

  store.recordSafeEpoch(lower, 5, 1n, 2);
  assert.ok(store.isEpochSafe(checksummed, 5));
});

test("the market reader reads the per-account balances no event carries", async () => {
  const { ViemMarketReader } = await import("../src/indexer/chain-source.mjs");

  // `lpFeeCredit` and `winnerFeePaid` decide what a settled account is still
  // owed, and neither appears in a log. They are public getters, so they are
  // read rather than inferred.
  const calls = [];
  const reader = new ViemMarketReader({
    publicClient: {
      async readContract({ functionName, args }) {
        calls.push({ functionName, args });
        return functionName === "lpFeeCredit" ? 7n : 3n;
      },
    },
  });

  const state = await reader.readAccountState("0xMARKET", "0xACCOUNT");
  assert.equal(state.lpFeeCredit, 7n);
  assert.equal(state.winnerFeePaid, 3n);
  // claimLpFees accrues before it pays, so the accrual inputs are read too.
  assert.deepEqual(
    calls.map((call) => call.functionName).sort(),
    ["feePerShare", "lpFeeCredit", "lpFeeDebt", "lpSharesOf", "winnerFeePaid"]
  );
  for (const call of calls) {
    if (call.functionName === "feePerShare") assert.deepEqual(call.args, []);
    else assert.deepEqual(call.args, ["0xACCOUNT"]);
  }
});

test("the market reader reads the winning-participant rate the market charges", async () => {
  const { MARKET_STATE_GETTERS } = await import("../src/indexer/abi.mjs");

  // The rate is per-market and zero is a valid setting, so the interface must
  // not name "1%" from a constant. `SlotPublished` does not carry it; the
  // contract exposes it as a getter.
  assert.ok(
    MARKET_STATE_GETTERS.includes("winnerRewardBps"),
    "the fee rate must be indexed, or every surface quoting it is guessing"
  );
});
