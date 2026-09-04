#!/usr/bin/env node
// Replays a scripts/backup-postgres.mjs snapshot into PostgreSQL.
//
//   TM_DATABASE_URL=postgres://... node scripts/restore-postgres.mjs <source.json>
//
// The target must be empty — this is a disaster-recovery operation, not a
// merge, and pgRestore() refuses a database that already has rows rather
// than silently dropping colliding ones. Point TM_DATABASE_URL at a fresh
// database (a new one, or the same server with a clean schema), not at
// whatever produced the backup.

import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { pgRestore } from "../src/ports/postgres-stores.mjs";
import { redactedDatabaseUrl } from "../src/app.mjs";

const [source] = process.argv.slice(2);

if (!source) {
  console.error("usage: TM_DATABASE_URL=postgres://... node scripts/restore-postgres.mjs <source.json>");
  process.exit(1);
}
if (!process.env.TM_DATABASE_URL || !redactedDatabaseUrl(process.env.TM_DATABASE_URL)) {
  console.error("TM_DATABASE_URL must be set to a postgres:// or postgresql:// connection string.");
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`No backup at ${source}.`);
  process.exit(1);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(source, "utf8"));
} catch (error) {
  console.error(`Could not read ${source} as a backup: ${error.message}`);
  process.exit(1);
}

const client = new Client({ connectionString: process.env.TM_DATABASE_URL });
await client.connect();

let captured;
try {
  captured = await pgRestore(client, snapshot);
} catch (error) {
  console.error(error.message);
  process.exit(1);
} finally {
  await client.end();
}

console.log(`Restored ${source} -> ${redactedDatabaseUrl(process.env.TM_DATABASE_URL)}`);
for (const [table, count] of Object.entries(captured)) {
  if (count > 0) console.log(`  ${table}: ${count}`);
}
console.log(
  "\nDoes NOT restore evidence recordings (TM_DATA_DIR/oracle-proofs) — this snapshot only carries their " +
    "metadata and hashes. Restore that directory from its own backup separately."
);
console.log("\nVerify before serving traffic: boot the service against this database and confirm it reports healthy.");
