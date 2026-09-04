// Issues 44-47: multi-room and multi-replica actually working, and an operator
// being able to tell what is happening.
//
// Each of these passed every existing test while being broken in production,
// because the tests drove the pieces by hand where the running service does not.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { buildService, configFromEnv } from "../src/app.mjs";
import { renderMetrics } from "../src/observability/exporter.mjs";
import { migrate as migratePostgres } from "../src/ports/postgres-stores.mjs";

const BASE = {
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_CHAIN_ID: "31337",
  TM_ROOM_API_URL: "http://127.0.0.1:8787",
};
const ROOM_A = "0x2222222222222222222222222222222222222222";
const ROOM_B = "0x3333333333333333333333333333333333333333";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-replica-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Two replicas over one shared durable store — the deployment shape at issue. */
function replicaPair(dir, rooms) {
  const env = { ...BASE, TM_ROOMS: rooms, TM_DATA_DIR: dir };
  const a = buildService(configFromEnv(env));
  const b = buildService(configFromEnv(env));
  for (const service of [a, b]) service.client.getBlockNumber = async () => 10n;
  return { a, b };
}

// ------------------------------------------------------------- issue 44

test("two replicas over two rooms do not deadlock into nobody leading", async () => {
  // The defect: leadership was `every room at once`, and the lease is per room.
  // Each replica wins one room, `every()` is false on both, and because
  // `tryAcquire` renews unconditionally for the current holder, the split never
  // expires. Both replicas serve an empty room, forever.
  const { dir, clean } = scratch();
  try {
    const { a, b } = replicaPair(dir, `alpha=${ROOM_A},beta=${ROOM_B}`);
    // Interleaved on purpose, so each replica takes one room first — the
    // ordinary racing outcome, not an exotic interleaving.
    await a.claimRooms?.(0);
    await b.claimRooms?.(0);

    const ledByA = await a.claimRooms(0);
    const ledByB = await b.claimRooms(0);
    const led = [...ledByA, ...ledByB];

    assert.deepEqual(
      [...new Set(led)].sort(),
      ["alpha", "beta"],
      "every room is led by somebody — a room nobody leads is a room nobody indexes"
    );
    assert.equal(led.length, new Set(led).size, "and no room is led by two replicas at once");
  } finally {
    clean();
  }
});

test("a replica indexes the rooms it holds rather than refusing unless it holds all of them", async () => {
  const { dir, clean } = scratch();
  try {
    const { a, b } = replicaPair(dir, `alpha=${ROOM_A},beta=${ROOM_B}`);
    await a.claimRooms(0);
    const second = await b.claimRooms(0);

    // Whatever B got, it is a real working set, not an empty one caused by A
    // holding something else.
    const first = await a.claimRooms(0);
    assert.ok(first.length + second.length >= 2, "the two replicas between them lead both rooms");
    assert.ok(first.length > 0, "the first replica leads something");
  } finally {
    clean();
  }
});

test("a single replica on a single room still leads it", async () => {
  const { dir, clean } = scratch();
  try {
    const service = buildService(configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A}`, TM_DATA_DIR: dir }));
    assert.deepEqual(await service.claimRooms(0), ["alpha"]);
    assert.equal(await service.isLeading(0), true, "and still reports itself leading");
  } finally {
    clean();
  }
});

// ------------------------------------------------------------- issue 45

test("every room is ticked by the driving loop, not just the primary", async () => {
  // Before this, `coordinator` was bound to rooms[0] and the sync loop drove
  // only that object. Room beta was constructed, served, subscribable — and
  // never ticked, so a viewer got `hello` and then silence forever.
  const { dir, clean } = scratch();
  try {
    const service = buildService(
      configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}`, TM_DATA_DIR: dir })
    );
    // Head parked at the cursor so the pass drives the coordinators without
    // attempting a real getLogs against a chain that is not running.
    service.client.getBlockNumber = async () => 0n;

    assert.equal(service.roomFor("beta").coordinator.chainHead, null, "nothing has driven the second room yet");

    // The real driving pass, not a hand-rolled tick.
    await service.syncOnce();

    assert.notEqual(
      service.roomFor("beta").coordinator.chainHead,
      null,
      "the second room was driven by the sync loop — nothing in this test ticked it"
    );
    assert.notEqual(service.roomFor("alpha").coordinator.chainHead, null, "and so was the first");
  } finally {
    clean();
  }
});

// ------------------------------------------------------------- issue 46

test("a standby is distinguishable from a leader through /v1/health alone", async () => {
  // A standby serves state `draft`, zero slots, block 0 — a plausible-looking
  // empty room, not an error. A load balancer needs something to drain on.
  const { dir, clean } = scratch();
  try {
    const { a, b } = replicaPair(dir, `alpha=${ROOM_A}`);
    a.client.getBlockNumber = async () => 0n;
    b.client.getBlockNumber = async () => 0n;
    await a.syncOnce(); // A takes the only room and starts leading
    await b.syncOnce(); // B finds it held and stands by

    const [leaderAddress, standbyAddress] = [await a.server.listen(0), await b.server.listen(0)];
    try {
      const leader = await (await fetch(`http://127.0.0.1:${leaderAddress.port}/v1/health`)).json();
      const standby = await (await fetch(`http://127.0.0.1:${standbyAddress.port}/v1/health`)).json();

      assert.equal(typeof leader.leading, "boolean", "/v1/health reports leadership at all");
      assert.equal(leader.leading, true);
      assert.equal(standby.leading, false, "and the standby says so, rather than looking healthy and empty");
    } finally {
      await a.server.close();
      await b.server.close();
    }
  } finally {
    clean();
  }
});

test("the leadership signal reaches /metrics, instead of being measured and dropped", async () => {
  const { dir, clean } = scratch();
  try {
    const service = buildService(configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A}`, TM_DATA_DIR: dir }));
    service.client.getBlockNumber = async () => 10n;
    await service.claimRooms(0);

    const text = renderMetrics(await service.metrics());
    assert.match(text, /tradermarket_leading/, "the gauge exists");
    assert.match(text, /tradermarket_leading\s+1/, "and says this replica leads");
  } finally {
    clean();
  }
});

test("a PostgreSQL-backed service reports durable history in BOTH report() and metrics()", async () => {
  // The one-word defect: `Boolean(database)` instead of `durable`. On Postgres
  // `database` is always null, so /metrics emitted history_durable 0 while
  // report() on the same process said durable — and a severity=page rule fired
  // permanently on a correctly configured deployment.
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const service = buildService(configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A}` }), { pgClient: client });
    service.client.getBlockNumber = async () => 0n;

    assert.equal(service.report().durability.non_chain_history, "durable", "report() knows");
    assert.equal(
      (await service.metrics()).non_chain_history_durable,
      true,
      "and so does metrics() — these are the same fact and must not disagree"
    );
  } finally {
    await client.close();
  }
});

// ------------------------------------------------------------- issue 47

test("a quiet room actually emits the heartbeat it advertises", async () => {
  // `coordinator.heartbeat()` had no production caller while every client was
  // told `heartbeat_ms: 10000` in its hello frame. A quiet room transmitted
  // zero bytes, so any proxy idle timeout killed every viewer silently.
  const { dir, clean } = scratch();
  try {
    const service = buildService(
      configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A}`, TM_DATA_DIR: dir, TM_HEARTBEAT_MS: "40", TM_PORT: "18921" })
    );
    service.client.getBlockNumber = async () => 10n;

    const seen = [];
    service.roomFor("alpha").edge.attach({ send: (frame) => seen.push(frame) });
    await service.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await service.stop();
    }

    assert.ok(
      seen.some((frame) => frame.type === "heartbeat"),
      `a quiet room must still say it is alive; saw ${JSON.stringify(seen.map((f) => f.type))}`
    );
  } finally {
    clean();
  }
});

test("the SSE response head lets a proxy through and a client resume", async () => {
  const { dir, clean } = scratch();
  try {
    const service = buildService(configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A}`, TM_DATA_DIR: dir }));
    service.client.getBlockNumber = async () => 10n;
    const address = await service.server.listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/rooms/alpha/stream?since=0`);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(
        response.headers.get("x-accel-buffering"),
        "no",
        "without this nginx buffers the stream by default, which defeats SSE entirely"
      );
      await response.body.cancel();
    } finally {
      await service.server.close();
    }
  } finally {
    clean();
  }
});
