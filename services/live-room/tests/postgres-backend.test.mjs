// Phase 1: app.mjs can actually run against PostgreSQL, not just the adapter.
//
// The adapter (src/ports/postgres-stores.mjs) has passed the port contract
// since the storage-foundation work — but nothing in the composition root
// could select it. This is that wiring: TM_DATABASE_URL, or an injected
// `pgClient` for tests, replaces SQLite everywhere durable state lives.
//
// What this file does NOT prove, and must not be read as proving: that a
// `pg.Pool` actually opened over a real network connects, negotiates TLS with
// a real managed provider, or survives a connection-pool exhaustion. There is
// no reachable PostgreSQL server or Docker daemon in this environment to test
// that against, and it is a standing gap awaiting provider selection. PGlite is the real Postgres engine
// compiled to WASM, so the SQL dialect, migration and every store above the
// query() boundary are exercised for real; only the TCP transport is not.

import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { buildService, configFromEnv } from "../src/app.mjs";
import {
  migrate as migratePostgres,
  PostgresChatStore,
  PostgresEventStore,
  PostgresKeyValue,
  PostgresLeaderLease,
} from "../src/ports/postgres-stores.mjs";

const BASE = {
  TM_ROOM_ID: "room-1",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
  TM_CHAIN_ID: "31337",
  TM_ROOM_API_URL: "http://127.0.0.1:8787",
};

test("with neither TM_DATA_DIR nor TM_DATABASE_URL, nothing durable is selected", () => {
  const service = buildService(configFromEnv(BASE));
  assert.equal(service.database, null);
  assert.equal(service.pgClient, null);
  assert.equal(service.report().durability.non_chain_history, "in-memory");
});

test("an injected pgClient is preferred over TM_DATA_DIR, and selects Postgres stores everywhere", async () => {
  const client = await PGlite.create();
  try {
    const service = buildService(configFromEnv({ ...BASE, TM_DATA_DIR: "/should-not-be-used" }), {
      pgClient: client,
    });
    assert.equal(service.pgClient, client);
    assert.equal(service.database, null, "SQLite must not also open when Postgres is selected");
    assert.ok(service.durableState instanceof PostgresKeyValue);
    assert.ok(service.leaderLease instanceof PostgresLeaderLease);
    assert.ok(service.roomFor("room-1").eventLog instanceof PostgresEventStore);
  } finally {
    await client.close();
  }
});

test("start() migrates an unmigrated injected client before serving anything", async () => {
  const client = await PGlite.create(); // deliberately not migrated first
  const service = buildService(configFromEnv({ ...BASE, TM_PORT: "18797" }), { pgClient: client });
  // No real chain to sync against; syncOnce is not what this test is about.
  service.client.getBlockNumber = async () => 10n;
  try {
    // Before start(), the schema does not exist yet — proves this test would
    // fail without start()'s migration, rather than the table having existed
    // all along for some other reason.
    await assert.rejects(() => service.durableState.get("k", null));

    await service.start();
    await service.durableState.set("k", "v");
    assert.equal(await service.durableState.get("k", null), "v", "the schema exists and the store actually works");
  } finally {
    await service.stop();
  }
});

test("leader election works the same way against the Postgres-selected path", async () => {
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const replicaA = buildService(configFromEnv(BASE), { pgClient: client });
    const replicaB = buildService(configFromEnv(BASE), { pgClient: client });
    // Both point at the same in-process PGlite instance — the same "one
    // durable store, two replicas" shape the SQLite leader-election tests
    // use, just on the other adapter.
    assert.equal(await replicaA.isLeading(0), true);
    assert.equal(await replicaB.isLeading(0), false, "one live lease, shared through Postgres, refuses the second");
  } finally {
    await client.close();
  }
});

test("TM_DATABASE_URL that is not a postgres connection string refuses to start, without echoing it", () => {
  assert.throws(
    () => buildService(configFromEnv({ ...BASE, TM_DATABASE_URL: "not a url" })),
    (error) => {
      assert.match(error.message, /TM_DATABASE_URL/);
      assert.doesNotMatch(error.message, /not a url/);
      return true;
    }
  );
});

test("the boot report redacts the password in TM_DATABASE_URL", async () => {
  const client = await PGlite.create();
  try {
    const service = buildService(
      configFromEnv({ ...BASE, TM_DATABASE_URL: "postgres://appuser:hunter2@db.example.com:5432/tradermarket" }),
      { pgClient: client }
    );
    const detail = service.report().durability.detail;
    assert.match(detail, /db\.example\.com/, "names the host, which is operationally useful");
    assert.doesNotMatch(detail, /hunter2/, "never the password");
  } finally {
    await client.close();
  }
});

test("Postgres selected with no TM_DATA_DIR: structured stores work, evidence upload stays truthfully off", async () => {
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const service = buildService(configFromEnv(BASE), { pgClient: client });
    assert.equal(service.oracle, null, "no directory for recordings means the capability is off, not broken");
    await service.durableState.set("k", 1);
    assert.equal(await service.durableState.get("k", null), 1, "everything else still works");
  } finally {
    await client.close();
  }
});

test("chat is scoped per room against the Postgres path exactly as it is against SQLite", async () => {
  const client = await PGlite.create();
  const service = buildService(
    configFromEnv({
      ...BASE,
      TM_ROOM_ID: undefined,
      TM_ROOM_ADDRESS: undefined,
      TM_ROOMS: `alpha=${BASE.TM_ROOM_ADDRESS},beta=0x3333333333333333333333333333333333333333`,
      TM_CHAT_ENABLED: "true",
      TM_PORT: "18798",
    }),
    { pgClient: client }
  );
  service.client.getBlockNumber = async () => 10n;
  await service.start();
  // service.stop() closes pgClient (== client here) itself — a second close
  // on top of that is what the earlier version of this test hung on.
  try {
    assert.ok(service.roomFor("alpha").chat.store instanceof PostgresChatStore);
    await service.roomFor("alpha").chat.store.append({ author: "0xA", text: "hi", at: "2026-01-01T00:00:00.000Z" });
    assert.equal((await service.roomFor("alpha").chat.history()).length, 1);
    assert.equal((await service.roomFor("beta").chat.history()).length, 0);
  } finally {
    await service.stop();
  }
});
