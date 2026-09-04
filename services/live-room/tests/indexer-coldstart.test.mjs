// A service that starts against a chain which already has history must index
// all of it.
//
// The defect this pins: markets are discovered from the factory's own logs, but
// the market address set is read once per pass. So on a cold start every log a
// market emitted — every trade, claim, attestation and resolution — falls in
// the same block range that discovered the market, is never fetched, and is
// then skipped forever because the cursor has already advanced past it.
//
// The symptom is silent and total: the room and its slots look right, and the
// entire settlement and payout history is simply absent.

import test from "node:test";
import assert from "node:assert/strict";

import { ChainIndexer } from "../src/indexer/indexer.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";

const FACTORY = "0xfac0";
const ROOM = "0xr00m";
const MARKET = "0xmarke7";

/** A log source that only returns logs for addresses it is currently told about. */
class AddressScopedSource {
  constructor({ rooms, markets }) {
    this.rooms = rooms;
    this.markets = markets;
    this.fetches = [];
    this.all = [
      {
        event: "RoomCreated",
        address: FACTORY,
        args: { room: ROOM, roomId: "room-1", creator: "0xdeploy" },
        blockNumber: 5,
        logIndex: 0,
      },
      {
        event: "MarketCreated",
        address: FACTORY,
        args: {
          market: MARKET,
          roomId: "room-1",
          slotIndex: 0n,
          templateId: "0xt",
          conditionHash: "0xc",
          question: "Who wins?",
          streamUrl: "",
        },
        blockNumber: 6,
        logIndex: 0,
      },
      // Emitted by the market, in the very same range that created it.
      {
        event: "PositionsRedeemed",
        address: MARKET,
        args: { user: "0xalice", amountA: 10n, amountB: 0n, payout: 190n },
        blockNumber: 7,
        logIndex: 0,
      },
    ];
  }

  async head() {
    return 9;
  }

  async getLogs({ fromBlock, toBlock }) {
    const visible = new Set([FACTORY, ...this.rooms(), ...this.markets()].map((a) => String(a).toLowerCase()));
    this.fetches.push({ fromBlock, toBlock, visible: [...visible] });
    return this.all.filter(
      (log) =>
        log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock &&
        visible.has(String(log.address).toLowerCase())
    );
  }
}

test("a cold start indexes logs from markets discovered in the same range", async () => {
  const store = new ProjectionStore();
  const logs = new AddressScopedSource({
    rooms: () => [...store.rooms.values()].map((row) => row.live_room_address).filter(Boolean),
    markets: () => [...store.markets.values()].map((row) => row.market_address),
  });
  const indexer = new ChainIndexer({ store, logs, reader: null });

  await indexer.syncTo(9);

  assert.ok(store.getMarket(MARKET), "the market itself was discovered");
  assert.equal(
    store.listClaims().length,
    1,
    "the redemption emitted by the newly discovered market must be indexed, not skipped forever"
  );
  assert.equal(store.listClaims()[0].amount, 190n);
});

test("a second pass over the same range does not double-count", async () => {
  const store = new ProjectionStore();
  const logs = new AddressScopedSource({
    rooms: () => [...store.rooms.values()].map((row) => row.live_room_address).filter(Boolean),
    markets: () => [...store.markets.values()].map((row) => row.market_address),
  });
  const indexer = new ChainIndexer({ store, logs, reader: null });

  await indexer.syncTo(9);
  await indexer.syncTo(9);

  assert.equal(store.listClaims().length, 1, "re-syncing the same head must not duplicate a claim");
});

test("the dedup set does not grow without bound across syncs", async () => {
  const store = new ProjectionStore();
  const logs = new AddressScopedSource({
    rooms: () => [...store.rooms.values()].map((row) => row.live_room_address).filter(Boolean),
    markets: () => [...store.markets.values()].map((row) => row.market_address),
  });
  const indexer = new ChainIndexer({ store, logs, reader: null });

  // The dedup set exists to make the re-sweeps within one range idempotent.
  // Once the cursor has moved past a range, those logs are never fetched again,
  // so retaining their identities for the life of the process is a leak that
  // grows with every block a long-running indexer sees.
  await indexer.syncTo(9);
  const afterFirst = indexer.appliedLogs.size;
  await indexer.syncTo(20);

  assert.equal(afterFirst, 0, "identities must not outlive the range they guard");
  assert.equal(indexer.appliedLogs.size, 0, "and must not accumulate across syncs");
  assert.equal(store.listClaims().length, 1, "while still applying each log exactly once");
});

test("a sync that fails part-way does not double-apply on the next poll", async () => {
  const store = new ProjectionStore();
  const discovered = new AddressScopedSource({
    rooms: () => [...store.rooms.values()].map((row) => row.live_room_address).filter(Boolean),
    markets: () => [...store.markets.values()].map((row) => row.market_address),
  });

  // Later blocks, emitted by a market that is already known.
  const later = [
    {
      event: "Trade",
      address: "0xmarke7",
      args: { user: "0xalice", participantAOutcome: true, isBuy: true, amountIn: 25n, amountOut: 40n },
      blockNumber: 12,
      logIndex: 0,
    },
    {
      event: "LpFeesClaimed",
      address: "0xmarke7",
      args: { provider: "0xlp", amount: 7n },
      blockNumber: 13,
      logIndex: 0,
    },
  ];

  let calls = 0;
  let failOnCall = 0;
  const logs = {
    head: async () => 20,
    async getLogs(range) {
      calls += 1;
      // The re-sweep design means at least two round trips per range, so a
      // transient RPC failure *between* them is routine on a public testnet —
      // and by then the first sweep has already written to the store.
      if (calls === failOnCall) throw new Error("HTTP 429 rate limited");
      const fromDiscovery = await discovered.getLogs(range);
      return [...fromDiscovery, ...later.filter((l) => l.blockNumber >= range.fromBlock && l.blockNumber <= range.toBlock)];
    },
  };
  const indexer = new ChainIndexer({ store, logs, reader: null });

  await indexer.syncTo(9);
  assert.equal(store.listClaims().length, 1);

  const callsBefore = calls;
  failOnCall = callsBefore + 2;
  await assert.rejects(() => indexer.syncTo(20), /429/);
  assert.equal(store.listTrades().length, 1, "the first sweep applied the trade before the failure");
  const positionAfterFirstApply = store.getHolding("0xmarke7", "0xalice").position_a;

  // apply() mutates the store irreversibly — holdings accumulate and claims are
  // appended. With the cursor unmoved, the next poll re-fetches the same range.
  failOnCall = 0;
  await indexer.syncTo(20);

  assert.equal(store.listTrades().length, 1, "a retried range must not duplicate a trade");
  assert.equal(store.listClaims().length, 2, "nor a claim");
  assert.equal(
    store.getHolding("0xmarke7", "0xalice").position_a,
    positionAfterFirstApply,
    "nor move a position that was already applied"
  );
});

test("a log whose handler throws is retried, not recorded as applied", async () => {
  const store = new ProjectionStore();
  const logs = {
    head: async () => 9,
    async getLogs({ fromBlock, toBlock }) {
      const all = [
        {
          event: "MarketCreated",
          address: "0xfac0",
          args: {
            market: "0xmarke7", roomId: "room-1", slotIndex: 0n, templateId: "0xt",
            conditionHash: "0xc", question: "Q", streamUrl: "",
          },
          blockNumber: 6,
          logIndex: 0,
        },
      ];
      return all.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const indexer = new ChainIndexer({ store, logs, reader: null });

  // Recording the identity before calling apply() means a handler that throws
  // — several do, by design, for a log from a contract the projection does not
  // know — marks the log applied and it is never retried. The cursor then moves
  // past it, and the gap is invisible: syncOnce returns normally and health
  // reports the new block.
  let failFirst = true;
  const original = indexer._onMarketCreated.bind(indexer);
  indexer._onMarketCreated = function (log) {
    if (failFirst) {
      failFirst = false;
      throw new Error("unknown room contract");
    }
    return original(log);
  };

  await assert.rejects(() => indexer.syncTo(9));
  assert.equal(store.getMarket("0xmarke7"), null, "nothing was applied");

  await indexer.syncTo(9);
  assert.ok(store.getMarket("0xmarke7"), "the log must be retried, not skipped forever");
});

test("a head that regresses does not let a range be applied twice", async () => {
  const store = new ProjectionStore();
  const trades = [
    {
      event: "Trade",
      address: "0xmarke7",
      args: { user: "0xalice", participantAOutcome: true, isBuy: true, amountIn: 25n, amountOut: 90n },
      blockNumber: 180,
      logIndex: 0,
    },
  ];
  let refreshFails = false;
  const logs = {
    head: async () => 200,
    async getLogs({ fromBlock, toBlock }) {
      return trades.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  };
  const reader = {
    async readMarketState() {
      if (refreshFails) throw new Error("HTTP 429 rate limited");
      return {
        gateState: 0n, reserveA: 0n, reserveB: 0n, spotPriceA: 0n, totalLpShares: 0n,
        winnerRewardPool: 0n, pendingCollateral: 0n, collateralBacking: 0n, unclaimedLpFees: 0n,
        currentEpoch: 0n, lastSafeSequence: 0n, finalOutcome: 0n, provisionalAt: 0n,
      };
    },
  };
  const indexer = new ChainIndexer({ store, logs, reader });
  store.upsertMarket({ market_address: "0xmarke7", room_id: "room-1", slot_index: 0, block_number: 1 });

  // The first sync applies the trade, then the market-state refresh fails, so
  // the cursor stays put with `appliedFrom = 1`.
  refreshFails = true;
  await assert.rejects(() => indexer.syncTo(200));
  assert.equal(store.listTrades().length, 1);

  // A lagging or reorged node now reports a *lower* head. The range still
  // starts at 1, so the identities are kept, the pass no-ops — and the cursor
  // advances to 150, dropping the identities for blocks 151-200.
  refreshFails = false;
  await indexer.syncTo(150);

  // The next poll sees head 200 again and refetches 151-200.
  await indexer.syncTo(200);

  assert.equal(store.listTrades().length, 1, "a regressed head must not let a trade be counted twice");
  assert.equal(store.getHolding("0xmarke7", "0xalice").position_a, 90n, "nor double a position");
});

test("the cursor never advances over blocks the node did not serve", async () => {
  const store = new ProjectionStore();
  const later = [
    {
      event: "Trade",
      address: "0xmarke7",
      args: { user: "0xalice", participantAOutcome: true, isBuy: true, amountIn: 25n, amountOut: 40n },
      blockNumber: 190,
      logIndex: 0,
    },
  ];

  // A node that reports head 200 once, fails, and then reports 150 and STAYS
  // there — because the 200 was from a fork that lost. Carrying `appliedTo`
  // forward as the target marks 151..200 as indexed while the node has never
  // served them, so the trade at 190 is lost permanently and silently.
  let head = 200;
  let served = 150;
  let failNext = false;
  const logs = {
    head: async () => head,
    async getLogs({ fromBlock, toBlock }) {
      if (failNext) {
        failNext = false;
        throw new Error("HTTP 429");
      }
      const ceiling = Math.min(toBlock, served);
      return later.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= ceiling);
    },
  };
  const indexer = new ChainIndexer({ store, logs, reader: null });
  store.upsertMarket({ market_address: "0xmarke7", room_id: "room-1", slot_index: 0, block_number: 1 });

  failNext = true;
  await assert.rejects(() => indexer.syncTo(200));

  head = 150;
  await indexer.syncTo(150);
  assert.ok(
    indexer.cursorBlock <= 150,
    `the cursor must not pass what the node served (it is ${indexer.cursorBlock})`
  );

  // The node catches up and the block is finally available.
  head = 200;
  served = 200;
  await indexer.syncTo(200);
  assert.equal(store.listTrades().length, 1, "the trade must eventually be indexed, not skipped forever");
});
