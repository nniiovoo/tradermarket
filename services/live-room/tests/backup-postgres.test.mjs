// PostgreSQL backup/restore/DR verification (Phase 1 item 6).
//
// The SQLite side has this already: `backupDatabase()` takes a byte-exact
// snapshot via `vacuum into`, and `scripts/backup.mjs` carries the adjacent
// evidence directory. Neither technique exists for PostgreSQL — `vacuum
// into` is a SQLite pragma, and this environment has no reachable network
// Postgres to run `pg_dump` against even if the binary were installed (no
// Docker daemon, no local postgres — the same absence recorded against
// blocker B2 throughout Phase 1). What IS real: PGlite, the actual Postgres
// engine compiled to WASM, reached through exactly the
// `query(sql, params) -> { rows }` contract this codebase already commits
// every adapter to. So this backup is logical — SELECT every row of every
// table, out through that same contract — rather than physical. Portable
// across `pg`, `postgres.js` and PGlite alike, and testable against a real
// Postgres dialect without a server.
//
// "Restore into a fresh database, then prove the service actually works
// against it" is the bar, not "the row counts match" — a restore that
// silently leaves a bigserial sequence behind still shows correct counts
// right up until the first message posted after recovery collides with one
// that already means something.

import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { privateKeyToAccount } from "viem/accounts";

import {
  migrate,
  pgBackup,
  pgRestore,
  PostgresEventStore,
  PostgresRawArchive,
  PostgresKeyValue,
  PostgresChatStore,
  PostgresReferralStore,
  PostgresAcceptanceStore,
  PostgresPublicationQueue,
} from "../src/ports/postgres-stores.mjs";
import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { normalizeFillsResponse } from "../src/connector/hyperliquid.mjs";
import { verifyChain } from "../src/domain/eventlog.mjs";
import { buildService, configFromEnv } from "../src/app.mjs";
import { TERMS_VERSION, ELIGIBILITY_ATTESTATIONS } from "../src/entry/entry.mjs";

const KEY = "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82";
const ALICE = "0x000000000000000000000000000000000000000a";

const fill = (tid, closedPnl) => ({
  tid,
  time: 1_000 + tid,
  closedPnl,
  fee: "0",
  coin: "ETH",
  side: "B",
  px: "1",
  sz: "1",
});

test("a Postgres backup restores every table into a fresh database, byte- and chain-exact", async () => {
  const source = await PGlite.create();
  const target = await PGlite.create(); // genuinely separate: this is what "the old one is gone" looks like
  try {
    await migrate(source);

    const eventLog = new PostgresEventStore(source);
    const rawArchive = new PostgresRawArchive(source);
    const connector = new SourceConnector({
      roomId: "room-1",
      source: "hyperliquid-testnet",
      store: eventLog,
      rawArchive,
      signer: privateKeyToAccount(KEY),
      clock: () => "2026-01-01T00:00:00.000Z",
    });
    for (let tid = 1; tid <= 5; tid++) {
      await connector.ingestBatch({
        rawBytes: JSON.stringify([fill(tid, "10")]),
        rawQuery: { endpoint: "info", type: "userFillsByTime", user: ALICE, startTime: 0, endTime: tid * 100 },
        drafts: normalizeFillsResponse("alice", ALICE, [fill(tid, "10")]),
      });
    }

    await new PostgresKeyValue(source).set("nextNonce", 41);

    const chat = new PostgresChatStore(source, "room-1");
    for (let i = 0; i < 3; i++) await chat.append({ author: ALICE, text: `msg ${i}`, at: "t" });

    await new PostgresReferralStore(source).bind({
      account: ALICE,
      code: "ref-1",
      referrer: "0x000000000000000000000000000000000000000b",
    });

    const acceptances = new PostgresAcceptanceStore(source);
    await acceptances.set(ALICE, "terms-v1");
    await acceptances.setProven(ALICE, true);

    const queue = new PostgresPublicationQueue(source, "room-1");
    const { id } = await queue.submit({ slotIndex: 0, templateId: "tpl", params: {} });
    await queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: {} });
    await queue.markPermitted(id, {
      permit: { nonce: 7n, big: 12345678901234567890n },
      signature: "0xsig",
      request: {},
    });

    const snapshot = await pgBackup(source);
    await pgRestore(target, snapshot);

    const restoredEvents = await new PostgresEventStore(target).forRoom("room-1").all();
    assert.equal(restoredEvents.length, 5);
    const verification = await verifyChain(restoredEvents, {
      verifySignature: makeSignatureVerifier(privateKeyToAccount(KEY).address),
    });
    assert.equal(verification.ok, true, `a restored log must still verify: ${JSON.stringify(verification.failures)}`);

    for (const event of restoredEvents) {
      assert.ok(await new PostgresRawArchive(target).get(event.raw_ref), `raw bytes for ${event.raw_ref} missing`);
    }

    assert.equal(await new PostgresKeyValue(target).get("nextNonce", null), 41);
    assert.equal((await new PostgresChatStore(target, "room-1").history()).length, 3);
    assert.equal((await new PostgresReferralStore(target).bindingFor(ALICE))?.code, "ref-1");
    assert.equal(await new PostgresAcceptanceStore(target).get(ALICE), "terms-v1");
    assert.equal(await new PostgresAcceptanceStore(target).proven(ALICE), true);

    const restored = await new PostgresPublicationQueue(target, "room-1").get(id);
    assert.equal(restored.status, "permitted");
    assert.equal(typeof restored.permit.nonce, "bigint", "a nonce restored as a Number would sign a different permit");
    assert.equal(restored.permit.big, 12345678901234567890n);
  } finally {
    await source.close();
    await target.close();
  }
});

test("a restored database's serial ids do not collide with new rows written after recovery", async () => {
  const source = await PGlite.create();
  const target = await PGlite.create();
  try {
    await migrate(source);
    const chat = new PostgresChatStore(source, "room-1");
    let lastId = 0;
    for (let i = 0; i < 5; i++) lastId = (await chat.append({ author: ALICE, text: `m${i}`, at: "t" })).id;

    await pgRestore(target, await pgBackup(source));

    // A bulk insert of explicit ids does not, on its own, advance
    // chat_message_id_seq — that sequence is a separate object the insert
    // never touches unless the id column is left to its default. A restore
    // that gets every row right but leaves the sequence behind looks
    // perfect until the first message posted after recovery.
    const next = await new PostgresChatStore(target, "room-1").append({
      author: ALICE,
      text: "first message after recovery",
      at: "t",
    });
    assert.ok(next.id > lastId, `a new id (${next.id}) must not collide with a restored one (up to ${lastId})`);
  } finally {
    await source.close();
    await target.close();
  }
});

test("restore refuses a snapshot in a format it does not recognise", async () => {
  const target = await PGlite.create();
  try {
    await assert.rejects(() => pgRestore(target, { format: "something-else", tables: {} }), /format/i);
  } finally {
    await target.close();
  }
});

test("restore refuses a target that is not empty, rather than silently merging into it", async () => {
  // Restore is a disaster-recovery operation: the target is supposed to be
  // the empty replacement for what was lost. With `on conflict do nothing`
  // rows would otherwise vanish silently rather than error on a dirty
  // target — the same "refuse rather than silently do the dangerous thing"
  // choice backupDatabase() already makes for an existing destination file.
  const source = await PGlite.create();
  const target = await PGlite.create();
  try {
    await migrate(source);
    await new PostgresKeyValue(source).set("k", 1);
    const snapshot = await pgBackup(source);

    await migrate(target);
    await new PostgresKeyValue(target).set("k", "already here");

    await assert.rejects(() => pgRestore(target, snapshot), /must be empty/i);
  } finally {
    await source.close();
    await target.close();
  }
});

test("DR verification: the real service boots against a restored database and serves what was lost", async () => {
  const BASE = {
    TM_ROOM_ID: "room-1",
    TM_RPC_URL: "http://127.0.0.1:8545",
    TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
    TM_CHAIN_ID: "31337",
    TM_ROOM_API_URL: "http://127.0.0.1:8787",
    TM_CHAT_ENABLED: "true",
    TM_PORT: "18799",
  };

  const lost = await PGlite.create();
  const recovered = await PGlite.create();
  try {
    // The service that "existed before disaster", writing through its own
    // real composition root — not a store class poked directly — so this
    // proves the whole path, not just the storage layer underneath it.
    const before = buildService(configFromEnv(BASE), { pgClient: lost });
    before.client.getBlockNumber = async () => 10n;
    await before.start();
    await before.roomFor("room-1").chat.store.append({
      author: ALICE,
      text: "the message that must survive",
      at: "2026-01-01T00:00:00.000Z",
    });
    const allAttestations = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((a) => [a.id, true]));
    await before.entry.accept({ address: ALICE, version: TERMS_VERSION, attestations: allAttestations });
    const snapshot = await pgBackup(lost);
    await before.stop();

    // "The old database is gone" — a separate PGlite instance, restored into,
    // with a brand new service boot against it. Nothing here reuses any
    // in-memory object `before` built; everything comes back through the
    // restored rows alone.
    await pgRestore(recovered, snapshot);
    const after = buildService(configFromEnv(BASE), { pgClient: recovered });
    after.client.getBlockNumber = async () => 10n;
    await after.start();
    try {
      const history = await after.roomFor("room-1").chat.history();
      assert.deepEqual(
        history.map((m) => m.text),
        ["the message that must survive"]
      );
      assert.equal(await after.entry.hasAccepted(ALICE), true, "the acceptance recorded before disaster is still there");
    } finally {
      await after.stop();
    }
  } finally {
    // start()/stop() already close `lost`/`recovered` via pgClient — see
    // postgres-backend.test.mjs for why a second close on top hangs instead
    // of erroring.
  }
});
