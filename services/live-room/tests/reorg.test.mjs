// Chain reorganisation detection.
//
// Issue 06 was marked resolved with the Change "handle reorgs by
// block-number-keyed rollback and replay" and the acceptance criterion "a
// simulated reorg of five blocks converges to the canonical chain". Neither was
// true. `rewindTo(_block, headBlock)` ignored its first argument and rebuilt
// from genesis, and — the part that actually mattered — **nothing ever called
// it**, because nothing detected a reorg in the first place.
//
// Reorgs are routine on Polygon PoS. Undetected, one leaves the projections
// describing a chain that no longer exists, and every surface fed by them —
// prices, positions, settlement history — silently describes it too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainIndexer } from "../src/indexer/indexer.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";

/**
 * A chain whose history can be rewritten under the indexer, like a real one.
 *
 * `blocks` maps block number -> hash. Reorging replaces the hashes from a given
 * height, which is exactly the observable an indexer has to notice.
 */
class ReorgableChain {
  constructor(depth = 20) {
    this.blocks = new Map();
    for (let n = 0; n <= depth; n += 1) this.blocks.set(n, `0xoriginal-${n}`);
    this.headBlock = depth;
    this.logs = [];
  }

  async head() {
    return this.headBlock;
  }

  async getLogs({ fromBlock, toBlock }) {
    return this.logs
      .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  async blockHash(number) {
    return this.blocks.get(number) ?? null;
  }

  /** Rewrites every block from `fromBlock` upward. */
  reorg(fromBlock) {
    for (let n = fromBlock; n <= this.headBlock; n += 1) this.blocks.set(n, `0xreorged-${n}`);
  }
}

function indexerOn(chain) {
  return new ChainIndexer({
    logs: chain,
    store: new ProjectionStore(),
    factory: "0xFACTORY",
    reader: null,
  });
}

test("the indexer records the hash of the block it indexed to", async () => {
  const chain = new ReorgableChain();
  const indexer = indexerOn(chain);

  await indexer.syncTo(10);

  assert.equal(indexer.cursorBlock, 10);
  assert.equal(
    await indexer.cursorHash(),
    "0xoriginal-10",
    "without the hash of its own cursor there is nothing to compare a reorg against"
  );
});

test("a five-block reorg is detected rather than indexed straight over", async () => {
  const chain = new ReorgableChain();
  const indexer = indexerOn(chain);
  await indexer.syncTo(15);

  // Blocks 11..15 are replaced. The head number does not move, which is the
  // case a cursor-vs-head comparison cannot see at all.
  chain.reorg(11);

  const detected = await indexer.detectReorg();
  assert.ok(detected, "a rewritten history must be detected");
  assert.equal(detected.commonAncestor, 10, "and rolled back to the last block both chains agree on");
});

test("no reorg is reported when the chain simply advanced", async () => {
  const chain = new ReorgableChain();
  const indexer = indexerOn(chain);
  await indexer.syncTo(10);

  chain.headBlock = 18;
  for (let n = 11; n <= 18; n += 1) chain.blocks.set(n, `0xoriginal-${n}`);

  assert.equal(await indexer.detectReorg(), null, "ordinary progress is not a reorg");
});

test("a reorg deeper than retained history is reported, not silently rebuilt", async () => {
  // The honest failure. If the indexer cannot find a common ancestor it does not
  // know what is still valid, and quietly rebuilding while reporting a healthy
  // cursor would present a guess as a fact.
  const chain = new ReorgableChain(200);
  const indexer = indexerOn(chain);
  await indexer.syncTo(200);

  chain.reorg(1); // deeper than any retained window

  const detected = await indexer.detectReorg();
  assert.ok(detected, "still detected");
  assert.equal(detected.commonAncestor, null, "but no ancestor is known");
  assert.ok(detected.beyondRetainedHistory, "and it says so, rather than implying it rolled back cleanly");
});

test("a five-block reorg converges the projections onto the canonical chain", async () => {
  // Issue 06's own acceptance criterion, which nothing ever exercised. Detection
  // is only half of it: what matters is that after the rewrite, the projections
  // describe the chain that exists rather than the one that did.
  //
  // The check is against a FRESH indexer replaying the canonical chain, not
  // against a hand-written expectation — the property is "indistinguishable from
  // never having seen the orphaned blocks", and only a rebuild states that
  // without encoding today's projection shape into the test.
  const { ChainIndexer: Indexer } = await import("../src/indexer/indexer.mjs");

  const roomLog = (blockNumber, roomId, room) => ({
    blockNumber,
    logIndex: 0,
    address: "0xFACTORY",
    event: "RoomCreated",
    args: { roomId, room, headlineTemplateId: "0x00", creator: "0xCREATOR" },
  });

  const chain = new ReorgableChain(20);
  // Block 12 on the original chain creates a room that the reorg erases, and
  // the replacement chain creates a different one at the same height.
  const orphaned = roomLog(12, "0x726f6f6d2d310000000000000000000000000000000000000000000000000000", "0xORPHANED");
  const canonical = roomLog(12, "0x726f6f6d2d320000000000000000000000000000000000000000000000000000", "0xCANONICAL");
  chain.logs = [orphaned];

  const indexer = indexerOn(chain);
  await indexer.syncTo(15);
  assert.equal(indexer.store.rooms.size, 1, "the orphaned room was indexed, as it should have been at the time");

  // The chain rewrites blocks 11..15 and the orphaned room never happened.
  chain.reorg(11);
  chain.logs = [canonical];

  const detected = await indexer.detectReorg();
  assert.ok(detected && detected.commonAncestor === 10);
  await indexer.rewindTo(detected.commonAncestor, 15);

  const fresh = indexerOn(chain);
  await fresh.syncTo(15);

  assert.deepEqual(
    [...indexer.store.rooms.keys()].sort(),
    [...fresh.store.rooms.keys()].sort(),
    "after the rollback the projections must match a fresh replay of the canonical chain"
  );
  assert.ok(
    ![...indexer.store.rooms.values()].some((room) => room.room_address === "0xORPHANED"),
    "and must not still contain the room the reorg erased"
  );
});

test("the real log source answers the two block questions the indexer asks", async () => {
  // Both were absent from ViemLogSource at different points while this was being
  // built, and neither absence fails a test that uses a fake chain — the indexer
  // simply disables the feature and reports nothing, forever, in production only.
  const { ViemLogSource } = await import("../src/indexer/chain-source.mjs");
  const source = new ViemLogSource({ publicClient: {}, factory: "0xFACTORY" });
  assert.equal(typeof source.blockHash, "function", "without this, reorg detection silently never runs");
  assert.equal(typeof source.blockTimestamp, "function", "without this, epoch clear latency is silently never measured");
});
