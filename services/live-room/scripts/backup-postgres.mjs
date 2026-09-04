#!/usr/bin/env node
// A logical snapshot of every durable table in the PostgreSQL backend.
//
//   TM_DATABASE_URL=postgres://... node scripts/backup-postgres.mjs <destination.json>
//
// The SQLite backup (scripts/backup.mjs) takes a byte-exact copy through
// `vacuum into`, a SQLite pragma with no Postgres equivalent; the standard
// answer there is `pg_dump`, run against a real server. This instead reads
// every row of every table through the same query() the service itself
// uses, and writes them out as portable JSON — the technique verified in
// tests/backup-postgres.test.mjs against real PostgreSQL (PGlite).
//
// Runs against the live service; no need to stop anything. Refuses to
// overwrite an existing destination, same as scripts/backup.mjs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "pg";
import { pgBackup } from "../src/ports/postgres-stores.mjs";
import { redactedDatabaseUrl } from "../src/app.mjs";

const [destination] = process.argv.slice(2);

if (!destination) {
  console.error("usage: TM_DATABASE_URL=postgres://... node scripts/backup-postgres.mjs <destination.json>");
  process.exit(1);
}
if (!process.env.TM_DATABASE_URL || !redactedDatabaseUrl(process.env.TM_DATABASE_URL)) {
  console.error("TM_DATABASE_URL must be set to a postgres:// or postgresql:// connection string.");
  process.exit(1);
}
if (existsSync(destination)) {
  console.error(`${destination} exists; refusing to overwrite a backup. Choose another name.`);
  process.exit(1);
}

const client = new Client({ connectionString: process.env.TM_DATABASE_URL });
await client.connect();

let snapshot;
try {
  snapshot = await pgBackup(client);
} finally {
  await client.end();
}

mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(snapshot));

const rowCount = (table) => snapshot.tables[table]?.length ?? 0;
console.log(`Backed up ${redactedDatabaseUrl(process.env.TM_DATABASE_URL)} -> ${destination}`);
console.log(`  ${rowCount("session_event")} session events`);
console.log(`  ${rowCount("raw_blob")} raw provider payloads`);
console.log(`  ${rowCount("chat_message")} chat messages`);
console.log(`  ${rowCount("kv")} durable keys (gate nonces, audit, cursors, operator liveness)`);
console.log(`  ${rowCount("livestream_oracle_proof")} livestream evidence records`);

const totalRows = Object.values(snapshot.tables).reduce((sum, rows) => sum + rows.length, 0);
if (totalRows === 0) {
  console.log("\nThis backup is empty. That is a fact about the database, not about the backup —");
  console.log("but check TM_DATABASE_URL points where the operators actually write.");
}
console.log(
  "\nEvidence recordings (TM_DATA_DIR/oracle-proofs) are NOT part of this file — this table only records " +
    "their metadata and hashes. Back up that directory separately, exactly as scripts/backup.mjs does for SQLite."
);
console.log(`\nRestore with: TM_DATABASE_URL=... node scripts/restore-postgres.mjs ${destination}`);
