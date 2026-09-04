#!/usr/bin/env node
// A consistent database snapshot plus immutable recordings the chain cannot rebuild.
//
//   node scripts/backup.mjs <TM_DATA_DIR> <destination.db>
//
// Chain state survives anything. These local artifacts do not: the database holds the signed
// session event log, the raw provider bytes a resolver reconstructs results
// from, chat and its moderation record, terms acceptances, referral bindings,
// the gate's permit nonce counter and audit log, the poller's cursors, and the
// hashes/references for complete Livestream Event recordings stored beside it.
// Losing it does not lose anyone's money — every position, claim and bond is on
// chain — but it loses the evidence for how a market was settled, and it lets a
// restarted gate reissue a nonce it has already used.
//
// Runs against a live service. It takes the copy through SQLite rather than
// copying bytes, because with WAL a `cp` can produce a database that opens and
// is quietly missing the last hour of a session.

import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, backupDatabase } from "../src/ports/sqlite-stores.mjs";

const [dataDir, destination] = process.argv.slice(2);

if (!dataDir || !destination) {
  console.error("usage: node scripts/backup.mjs <TM_DATA_DIR> <destination.db>");
  process.exit(1);
}

const source = join(dataDir, "room.db");
const recordingSource = join(dataDir, "oracle-proofs");
const recordingDestination = `${destination}.oracle-proofs`;
if (!existsSync(source)) {
  console.error(`No durable state at ${source}.`);
  console.error(`Nothing in ${dataDir} to back up — check TM_DATA_DIR, or the service has not written yet.`);
  process.exit(1);
}
if (existsSync(recordingDestination)) {
  console.error(`${recordingDestination} exists; refusing to overwrite an evidence backup. Choose another name.`);
  process.exit(1);
}

let database;
try {
  database = openDatabase(source);
} catch (error) {
  console.error(`Could not open ${source}: ${error.message}`);
  process.exit(1);
}

let captured;
try {
  captured = backupDatabase(database, destination);
} catch (error) {
  console.error(error.message);
  process.exit(1);
} finally {
  database.close();
}

if (captured.oracle_proofs > 0) {
  try {
    if (!existsSync(recordingSource)) {
      throw new Error(`${captured.oracle_proofs} evidence record(s) exist but ${recordingSource} is missing`);
    }
    // Recordings are immutable and every database row is inserted only after
    // its file is renamed into this directory. The database snapshot is taken
    // first, then the directory copy: every row in the snapshot therefore has
    // a source file available to this copy. A concurrent later upload may add
    // an harmless extra file, never omit one the snapshot references.
    cpSync(recordingSource, recordingDestination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const copied = readdirSync(recordingDestination).filter((name) => name.endsWith(".mp4")).length;
    if (copied < captured.oracle_proofs) {
      throw new Error(`copied ${copied} evidence recordings for ${captured.oracle_proofs} database records`);
    }
  } catch (error) {
    // Neither half is a valid full backup on its own. These paths were both
    // created by this invocation and were proven absent above.
    rmSync(recordingDestination, { recursive: true, force: true });
    rmSync(destination, { force: true });
    console.error(`Evidence backup failed: ${error.message}`);
    process.exit(1);
  }
}

console.log(`Backed up ${source} -> ${captured.path}`);
console.log(`  ${captured.events} session events`);
console.log(`  ${captured.raw_blobs} raw provider payloads`);
console.log(`  ${captured.chat_messages} chat messages`);
console.log(`  ${captured.keys} durable keys (gate nonces, audit, cursors, operator liveness)`);
console.log(`  ${captured.oracle_proofs} livestream evidence recordings`);

if (captured.events === 0 && captured.keys === 0 && captured.oracle_proofs === 0) {
  console.log("\nThis backup is empty. That is a fact about the service, not about the backup —");
  console.log("but check TM_DATA_DIR points where the operators actually write.");
}
console.log("\nRestore the database as TM_DATA_DIR/room.db and, when present, the .oracle-proofs directory as TM_DATA_DIR/oracle-proofs.");
