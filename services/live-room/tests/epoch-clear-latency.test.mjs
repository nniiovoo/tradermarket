// Epoch clear latency — the other half of issue 12's "two latencies that decide
// whether the product is honest".
//
// Gate lag is now measured. This one was not measured anywhere outside
// tests/metrics.test.mjs, and it is the one with money attached: past
// `maxPendingTime` an uncleared action refunds instead of executing, so a
// forecaster who did nothing wrong gets their collateral back and no position.
// Nothing measured how close a room was running to that edge.
//
// It is measured in the indexer because that is the only place both timestamps
// exist: `ActionSubmitted` and `ActionExecuted` for the same action id.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainIndexer } from "../src/indexer/indexer.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";

const MARKET = "0xMARKET";

/** A chain whose blocks have known times, so the subtraction is exact. */
function chainWith(logs, times) {
  return {
    async head() {
      return 100;
    },
    async getLogs({ fromBlock, toBlock }) {
      return logs
        .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
        .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    },
    async blockTimestamp(block) {
      return times.get(block) ?? null;
    },
  };
}

const submitted = (block, actionId) => ({
  blockNumber: block,
  logIndex: 0,
  address: MARKET,
  event: "ActionSubmitted",
  args: { actionId: BigInt(actionId), epoch: 1n, kind: 0, user: "0xUSER", amount: 100n },
});

const executed = (block, actionId) => ({
  blockNumber: block,
  logIndex: 1,
  address: MARKET,
  event: "ActionExecuted",
  args: { actionId: BigInt(actionId), returnAmount: 90n },
});

test("the indexer measures the seconds between an action's submission and its execution", async () => {
  const times = new Map([
    [10, 1_000],
    [14, 1_022], // 22 seconds later
  ]);
  const chain = chainWith([submitted(10, 1), executed(14, 1)], times);
  const indexer = new ChainIndexer({ logs: chain, store: new ProjectionStore(), factory: "0xFACTORY", reader: null });

  await indexer.syncTo(20);

  assert.equal(indexer.epochClearSeconds(), 22, "measured against block times, not block counts");
});

test("an action that has not executed contributes no latency", async () => {
  // A pending action has no clear time yet. Counting it as zero would report a
  // perfectly fast room precisely while actions were piling up unexecuted.
  const chain = chainWith([submitted(10, 1)], new Map([[10, 1_000]]));
  const indexer = new ChainIndexer({ logs: chain, store: new ProjectionStore(), factory: "0xFACTORY", reader: null });

  await indexer.syncTo(20);

  assert.equal(indexer.epochClearSeconds(), null, "no sample, rather than a zero that reads as healthy");
});

test("a chain that cannot answer block times reports no latency rather than a wrong one", async () => {
  const chain = chainWith([submitted(10, 1), executed(14, 1)], new Map());
  const indexer = new ChainIndexer({ logs: chain, store: new ProjectionStore(), factory: "0xFACTORY", reader: null });

  await indexer.syncTo(20);

  assert.equal(indexer.epochClearSeconds(), null);
});

test("the reported figure is the slowest recent clear, not the average", async () => {
  // An average hides the tail, and the tail is the part that refunds. One action
  // clearing in 90 seconds inside a batch of fast ones is exactly the signal an
  // operator needs, and a mean would bury it.
  const times = new Map([
    [10, 1_000], [11, 1_002],
    [12, 1_000], [13, 1_090],
    [14, 1_000], [15, 1_003],
  ]);
  const chain = chainWith(
    [submitted(10, 1), executed(11, 1), submitted(12, 2), executed(13, 2), submitted(14, 3), executed(15, 3)],
    times
  );
  const indexer = new ChainIndexer({ logs: chain, store: new ProjectionStore(), factory: "0xFACTORY", reader: null });

  await indexer.syncTo(20);

  assert.equal(indexer.epochClearSeconds(), 90, "the worst recent clear is what an operator has to see");
});
