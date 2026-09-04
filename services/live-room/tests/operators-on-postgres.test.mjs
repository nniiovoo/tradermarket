// Issue 49: the operator roles could not use PostgreSQL at all.
//
// `operators.mjs` had zero references to Postgres or TM_DATABASE_URL — every
// role opened SQLite unconditionally — while the Coordinator branched
// correctly. On a PostgreSQL deployment the two halves of the system therefore
// wrote and read different databases:
//
//   - the publisher queued a condition document into local SQLite, the
//     Coordinator read publication records from Postgres, and settlement
//     records silently omitted `closing_condition`;
//   - authority liveness was written to SQLite and read from Postgres, so
//     /v1/health reported no operators and three page-severity alert rules
//     became structurally unfirable;
//   - and every role sharing one local file is why resolvers cannot be
//     independent, which is the root cause behind issue 48.
//
// Verified against real PostgreSQL (PGlite is the engine compiled to WASM), so
// the SQL dialect and every store are exercised for real. The TCP transport is
// not — same standing limitation as blocker B2.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

import { buildOperator, operatorConfigFromEnv, operatorHealth, recordTick } from "../src/operators.mjs";
import { migrate as migratePostgres, PostgresKeyValue, PostgresPublicationQueue } from "../src/ports/postgres-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";

const ANVIL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SECOND_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

const BASE = {
  TM_ROOM_ID: "room-1",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
  TM_CHAIN_ID: "31337",
  TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-op-pg-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("TM_DATABASE_URL selects PostgreSQL for an operator's stores", async () => {
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({ ...BASE, TM_PUBLISHER_KEY: ANVIL_KEY, TM_DATA_DIR: "/should-not-be-used" }),
      { pgClient: client }
    );

    assert.ok(publisher.queue instanceof PostgresPublicationQueue, "the publication queue is the Postgres one");
    assert.ok(publisher.durableState instanceof PostgresKeyValue, "and so is the durable state");
    assert.equal(publisher.database, null, "SQLite must not also open when Postgres is selected");
  } finally {
    await client.close();
  }
});

test("a publisher and the Coordinator on one database see the same publication record", async () => {
  // The split-brain, stated as a test: the publisher writes the condition
  // document, the read tier looks it up. On SQLite-vs-Postgres those were
  // different databases and `conditionForMarket` returned null, so settlement
  // records silently omitted the question the market settled on.
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({ ...BASE, TM_PUBLISHER_KEY: ANVIL_KEY, TM_DATA_DIR: "/unused" }),
      { pgClient: client }
    );

    const document = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };
    const { id } = await publisher.queue.submit({ slotIndex: 0, templateId: "tpl", params: { target: "10000" } });
    await publisher.queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: document });
    await publisher.queue.markPermitted(id, { permit: { nonce: 1n }, signature: "0x", request: {} });
    await publisher.queue.markPublished(id, { market: "0xMARKET" });

    // A separate reader on the same database — which is what the Coordinator is.
    const readTier = new PostgresPublicationQueue(client, "room-1");
    const found = await readTier.conditionForMarket("0xMARKET");
    assert.ok(found, "the read tier finds the record the publisher wrote");
    assert.deepEqual(found.conditionDocument, document, "including the condition document settlement reports");
  } finally {
    await client.close();
  }
});

test("authority liveness written on PostgreSQL is readable on PostgreSQL", async () => {
  // operatorHealth reads operator:<role>:* keys. Written to SQLite and read
  // from Postgres, /v1/health reported `operators: []` and three page-severity
  // rules became unfirable — a dead gate invisible from outside its process.
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const gate = buildOperator(
      "gate",
      operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: "/unused" }),
      { pgClient: client }
    );
    await recordTick(gate.durableState, "gate", { ok: true, nowMs: 1_000_000 });

    // The Coordinator's own view of the same store.
    const health = await operatorHealth(new PostgresKeyValue(client), ["gate"], 1_000_000);
    assert.equal(health.length, 1, "the Coordinator can see the gate reported");
    assert.equal(health[0].role, "gate");
    assert.equal(health[0].failing, false);
  } finally {
    await client.close();
  }
});

test("two operator processes on one database share the event log", async () => {
  // This is what makes resolver independence possible at all: a store the
  // roles can reach without sharing a filesystem.
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const connector = buildOperator(
      "connector",
      operatorConfigFromEnv({
        ...BASE,
        TM_CONNECTOR_KEY: ANVIL_KEY,
        TM_DATA_DIR: "/unused",
        TM_SOURCE: "hyperliquid-testnet",
      }),
      { pgClient: client }
    );
    const resolver = buildOperator(
      "resolver",
      operatorConfigFromEnv({ ...BASE, TM_RESOLVER_KEY: SECOND_KEY, TM_DATA_DIR: "/unused" }),
      { pgClient: client }
    );

    await connector.eventLog.append({
      seq: 1,
      room_id: "room-1",
      kind: "baseline",
      hash: "0xa",
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal((await resolver.eventLog.tip()).seq, 1, "one log, two processes, no shared filesystem");
  } finally {
    await client.close();
  }
});

test("SQLite is still the default and is untouched when TM_DATABASE_URL is unset", async () => {
  const { dir, clean } = scratch();
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({ ...BASE, TM_PUBLISHER_KEY: ANVIL_KEY, TM_DATA_DIR: dir })
    );
    assert.ok(publisher.queue instanceof SqlitePublicationQueue, "no database URL means the local file, as before");
    assert.ok(publisher.database, "and the SQLite handle is there to close");
    publisher.database.close();
  } finally {
    clean();
  }
});

test("a malformed TM_DATABASE_URL refuses to start, without echoing it", async () => {
  // It carries a password. A startup error reaches logs, and logs reach places
  // a credential must not.
  assert.throws(
    () =>
      buildOperator(
        "publisher",
        operatorConfigFromEnv({ ...BASE, TM_PUBLISHER_KEY: ANVIL_KEY, TM_DATABASE_URL: "not a url" })
      ),
    (error) => {
      assert.match(error.message, /TM_DATABASE_URL/);
      assert.doesNotMatch(error.message, /not a url/, "the offending value is never echoed");
      return true;
    }
  );
});

test("an operator on PostgreSQL needs no TM_DATA_DIR to hold its durable state", async () => {
  // TM_DATA_DIR is required today because it IS the store. With a database
  // URL the store is elsewhere, and demanding a directory anyway would be a
  // requirement with no reason behind it.
  const client = await PGlite.create();
  await migratePostgres(client);
  try {
    const gate = buildOperator(
      "gate",
      operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY }),
      { pgClient: client }
    );
    await gate.durableState.set("k", 1);
    assert.equal(await gate.durableState.get("k", null), 1);
  } finally {
    await client.close();
  }
});
