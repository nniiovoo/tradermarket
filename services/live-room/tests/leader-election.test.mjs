// Issue 22: elect a leader per room, or stop claiming replicas.
//
// Two Coordinator processes can already be pointed at the same room and the
// same TM_DATA_DIR — nothing stopped that. Both would index independently,
// which is wasted chain load today and a real correctness hazard the moment
// any indexing side effect stops being safe to run twice. This proves the
// fix: one shared durable lease per room, and only its holder indexes.
//
// "Two replicas, one durable store" is built here as two real buildService()
// instances pointed at the same SQLite file — the same shape the gate and
// publisher already use to share a channel, not a mock of it.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildService, configFromEnv } from "../src/app.mjs";

const BASE = {
  TM_ROOM_ID: "room-1",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
  TM_CHAIN_ID: "31337",
  TM_ROOM_API_URL: "http://127.0.0.1:8787",
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-leader-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** No real chain: syncOnce only needs a head ahead of the cursor to reach the write. */
function wireFakeChain(service) {
  let writes = 0;
  service.client.getBlockNumber = async () => 10n;
  service.indexer.syncTo = async () => {
    writes += 1;
    return 0;
  };
  return () => writes;
}

test("only the leader indexes; the standby performs no writes across repeated real-time ticks", async () => {
  const { dir, clean } = scratch();
  try {
    const env = { ...BASE, TM_DATA_DIR: dir };
    const replicaA = buildService(configFromEnv(env));
    const replicaB = buildService(configFromEnv(env));
    const writesA = wireFakeChain(replicaA);
    const writesB = wireFakeChain(replicaB);

    // Real ticks, real Date.now() inside syncOnce, exactly as production runs
    // it — no clock injected. Whichever wins the first tick must keep it.
    for (let round = 0; round < 4; round += 1) {
      await replicaA.syncOnce();
      await replicaB.syncOnce();
    }

    assert.equal(writesA() + writesB(), 4, "exactly one replica indexed on every one of the 4 rounds");
    assert.ok(
      (writesA() === 4 && writesB() === 0) || (writesA() === 0 && writesB() === 4),
      "the same replica leads every round; leadership does not flap between renewals"
    );
  } finally {
    clean();
  }
});

test("a live lease refuses a second holder, and an unrenewed one frees itself exactly at the bound", async () => {
  const { dir, clean } = scratch();
  try {
    const env = { ...BASE, TM_DATA_DIR: dir };
    const replicaA = buildService(configFromEnv(env));
    const replicaB = buildService(configFromEnv(env));

    const t0 = 1_000_000;
    assert.equal(await replicaA.isLeading(t0), true, "the first acquirer leads");
    assert.equal(await replicaB.isLeading(t0), false, "a live lease refuses a second holder");

    // replicaA "dies": nothing ever calls its isLeading/syncOnce again, so its
    // lease is never renewed past this point.
    const justBefore = t0 + replicaA.leaseTtlMs - 1;
    assert.equal(await replicaB.isLeading(justBefore), false, "not yet — the dead leader's lease has not expired");

    const atBound = t0 + replicaA.leaseTtlMs;
    assert.equal(await replicaB.isLeading(atBound), true, "promoted exactly at the bound, not before it");
  } finally {
    clean();
  }
});

test("killing the leader promotes the follower, which then performs the indexing pass itself", async () => {
  const { dir, clean } = scratch();
  try {
    const env = { ...BASE, TM_DATA_DIR: dir };
    const replicaA = buildService(configFromEnv(env));
    const replicaB = buildService(configFromEnv(env));
    wireFakeChain(replicaA);
    const writesB = wireFakeChain(replicaB);

    await replicaA.syncOnce();

    // Simulate replicaA's process dying by acquiring, from replicaB, a lease
    // whose clock has already moved past replicaA's — this is the same
    // primitive syncOnce uses internally, just with the bound made explicit
    // rather than waiting out real seconds in a test.
    const promoted = await replicaB.isLeading(Date.now() + replicaA.leaseTtlMs + 1);
    assert.equal(promoted, true);

    await replicaB.syncOnce();
    assert.equal(writesB(), 1, "the promoted replica now performs the indexing pass");
  } finally {
    clean();
  }
});

test("leadership is per room: two replicas can each lead a disjoint room set", async () => {
  const { dir, clean } = scratch();
  try {
    const roomC = "0x4444444444444444444444444444444444444444";
    const partitioned = buildService(
      configFromEnv({ ...BASE, TM_DATA_DIR: dir, TM_ROOMS: `only-mine=${roomC}` })
    );
    const original = buildService(configFromEnv({ ...BASE, TM_DATA_DIR: dir }));

    assert.equal(await original.isLeading(0), true, "leads room-1");
    assert.equal(await partitioned.isLeading(0), true, "leads only-mine — a disjoint room set is not blocked");
  } finally {
    clean();
  }
});

test("metrics report leadership without acquiring or renewing it", async () => {
  const { dir, clean } = scratch();
  try {
    const env = { ...BASE, TM_DATA_DIR: dir };
    const replicaA = buildService(configFromEnv(env));
    wireFakeChain(replicaA);

    let before = await replicaA.metrics();
    assert.equal(before.leading, false, "no tick has run yet, so this replica has not decided it leads");

    await replicaA.syncOnce();
    const after = await replicaA.metrics();
    assert.equal(after.leading, true);
    assert.equal(after.replica_id, replicaA.replicaId);
  } finally {
    clean();
  }
});
