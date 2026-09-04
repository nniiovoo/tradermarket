// Durable is not the same as recoverable.
//
// Every structured fact this system cannot rebuild from the chain lives in one
// SQLite file: the session event log and its signatures, the raw provider bytes a
// resolver reconstructs from, chat, terms acceptances, referral bindings, the
// gate's permit nonce counter and audit log, the poller's cursors. Complete
// Livestream Event recordings live beside it and the backup script carries them.
// Chain state survives anything; these artifacts survive exactly as well as the disk under them.
//
// A copy taken with `cp` while the service is running is not a backup — WAL
// means the committed data may be in a second file, and the main file may be
// mid-page-write. What makes a backup real is that it is taken consistently
// while the writer is working, and that restoring it produces a database the
// service will actually open and read.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

import { backupDatabase } from "../src/ports/sqlite-stores.mjs";
import {
  openDatabase,
  SqliteEventStore,
  SqliteKeyValue,
  SqliteRawArchive,
  SqliteChatStore,
  SqliteAcceptanceStore,
  SqliteReferralStore,
} from "../src/ports/sqlite-stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse } from "../src/connector/hyperliquid.mjs";
import { verifyChain } from "../src/domain/eventlog.mjs";
import { makeSignatureVerifier } from "../src/connector/connector.mjs";
import { LivestreamOracle } from "../src/oracle/livestream-oracle.mjs";
import { SqliteOracleProofStore } from "../src/ports/sqlite-stores.mjs";
import { Readable } from "node:stream";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY = "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82";
const ALICE = "0x000000000000000000000000000000000000000a";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-backup-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test("a backup taken while the writer is working restores every fact", async () => {
  const { dir, clean } = scratch();
  try {
    const database = openDatabase(join(dir, "room.db"));
    const store = new SqliteEventStore(database);
    const connector = new SourceConnector({
      roomId: "room-1",
      source: "hyperliquid-testnet",
      store,
      rawArchive: new SqliteRawArchive(database),
      signer: privateKeyToAccount(KEY),
      clock: () => "2026-01-01T00:00:00.000Z",
    });
    const state = new SqliteKeyValue(database);
    const chat = new SqliteChatStore(database).forRoom("room-1");
    const acceptances = new SqliteAcceptanceStore(database);
    const referrals = new SqliteReferralStore(database);

    for (let tid = 1; tid <= 20; tid++) {
      await connector.ingestBatch({
        rawBytes: JSON.stringify([fill(tid, "10")]),
        rawQuery: { endpoint: "info", type: "userFillsByTime", user: ALICE, startTime: 0, endTime: tid * 100 },
        drafts: normalizeFillsResponse("alice", ALICE, [fill(tid, "10")]),
      });
    }
    await state.set("nextNonce", 41);
    await state.set(`poller:cursor:${ALICE}`, 987_654);
    await chat.append({ author: ALICE, text: "hello", at: 1 });
    acceptances.set(ALICE, "terms-v1");
    await referrals.bind({ account: ALICE, code: "ref-1", referrer: "0x000000000000000000000000000000000000000b" });

    // Taken with the database still open and being written to, which is the
    // only moment that matters — a backup you can only take while stopped is a
    // backup nobody takes.
    const destination = join(dir, "backup", "room.db");
    const result = backupDatabase(database, destination);
    await connector.ingestBatch({
      rawBytes: JSON.stringify([fill(99, "10")]),
      rawQuery: { endpoint: "info", type: "userFillsByTime", user: ALICE, startTime: 0, endTime: 99_000 },
      drafts: normalizeFillsResponse("alice", ALICE, [fill(99, "10")]),
    });

    assert.ok(existsSync(destination), "the backup file exists");
    assert.ok(statSync(destination).size > 0, "and is not empty");
    assert.equal(result.events, 20, "the backup reports what it captured");

    const restored = openDatabase(destination);
    const restoredEvents = await new SqliteEventStore(restored).all();
    assert.equal(restoredEvents.length, 20, "every event at the moment of the backup is present");

    const verification = await verifyChain(restoredEvents, {
      verifySignature: makeSignatureVerifier(privateKeyToAccount(KEY).address),
    });
    assert.equal(verification.ok, true, `a restored log must still verify: ${JSON.stringify(verification.failures)}`);

    const restoredState = new SqliteKeyValue(restored);
    assert.equal(Number(await restoredState.get("nextNonce", null)), 41, "the gate's nonce counter survives");
    assert.equal(Number(await restoredState.get(`poller:cursor:${ALICE}`, null)), 987_654, "and the poller's cursor");
    assert.equal((await new SqliteChatStore(restored).forRoom("room-1").history()).length, 1, "and chat");
    assert.equal(await new SqliteAcceptanceStore(restored).get(ALICE), "terms-v1", "and who accepted which terms");
    assert.equal(
      (await new SqliteReferralStore(restored).bindingFor(ALICE))?.code,
      "ref-1",
      "and referral bindings"
    );

    // The raw bytes are the resolver's only bridge to the truth. A backup that
    // kept the log and lost them would restore a session nobody can re-derive.
    const archive = new SqliteRawArchive(restored);
    for (const event of restoredEvents) {
      assert.ok(await archive.get(event.raw_ref), `raw bytes for ${event.raw_ref} are missing from the backup`);
    }

    restored.close();
    database.close();
  } finally {
    clean();
  }
});

test("a backup never overwrites a file that is already there", async () => {
  // Backups are run by cron and by people in a hurry. Silently replacing
  // yesterday's good copy with today's, at the moment someone is reaching for
  // yesterday's, is the way a backup system does more harm than none.
  const { dir, clean } = scratch();
  try {
    const database = openDatabase(join(dir, "room.db"));
    await new SqliteKeyValue(database).set("nextNonce", 1);
    const destination = join(dir, "copy.db");
    backupDatabase(database, destination);
    assert.throws(() => backupDatabase(database, destination), /exists/i);
    database.close();
  } finally {
    clean();
  }
});

test("the backup script carries livestream recordings and restores them at a new data path", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { dir, clean } = scratch();
  try {
    const dataDir = join(dir, "live");
    const database = openDatabase(join(dataDir, "room.db"));
    const oracle = new LivestreamOracle({
      store: new SqliteOracleProofStore(database),
      proofDir: join(dataDir, "oracle-proofs"),
    });
    const recording = Buffer.concat([
      Buffer.from([0, 0, 0, 16]),
      Buffer.from("ftypisom"),
      Buffer.from("complete-observation-window"),
    ]);
    const proof = await oracle.record({
      body: Readable.from([recording]),
      metadata: {
        market: "0x1111111111111111111111111111111111111111",
        outcome: 1,
        sourceSequence: 42,
        streamUrl: "https://twitch.tv/example",
        occurredAt: "2026-08-22T20:15:04.000Z",
        clipStartMs: 0,
        clipEndMs: 10_000,
        rule: "the first guest is first under the frozen appearance rule.",
        rationale: "The complete observation interval contains no earlier the second guest appearance.",
        contentType: "video/mp4",
      },
    });
    database.close();

    const destination = join(dir, "backups", "room.db");
    await run("node", [join(HERE, "..", "scripts", "backup.mjs"), dataDir, destination]);
    const recordingBackup = join(`${destination}.oracle-proofs`, `${proof.id}.mp4`);
    assert.ok(existsSync(recordingBackup), "the immutable evidence recording is part of the backup");

    const restoreDir = join(dir, "restored");
    mkdirSync(restoreDir, { recursive: true });
    cpSync(destination, join(restoreDir, "room.db"));
    cpSync(`${destination}.oracle-proofs`, join(restoreDir, "oracle-proofs"), { recursive: true });
    const restoredDb = openDatabase(join(restoreDir, "room.db"));
    const restoredOracle = new LivestreamOracle({
      store: new SqliteOracleProofStore(restoredDb),
      proofDir: join(restoreDir, "oracle-proofs"),
    });
    assert.deepEqual(readFileSync((await restoredOracle.video(proof.id)).path), recording);
    restoredDb.close();
  } finally {
    clean();
  }
});

test("the backup script refuses a data directory that has no database", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { dir, clean } = scratch();
  try {
    const result = await run("node", [join(HERE, "..", "scripts", "backup.mjs"), dir, join(dir, "out.db")]).catch(
      (error) => error
    );
    assert.equal(result.code, 1, "nothing to back up is a failure, not a success with an empty file");
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.match(output, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "it names the directory it looked in");
    assert.ok(!/Cannot find module/.test(output), "and the script actually exists to say so");
    assert.ok(!existsSync(join(dir, "out.db")), "and it must not leave an empty file that looks like a backup");
  } finally {
    clean();
  }
});
