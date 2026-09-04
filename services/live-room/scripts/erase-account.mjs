#!/usr/bin/env node
// Removes one account's erasable off-chain data: chat authorship, referral
// bindings, and terms acceptance.
//
//   node scripts/erase-account.mjs <TM_DATA_DIR> <0xAddress>
//
// Reaches every room in the database, not just one — see
// SqliteChatStore.eraseAccount for why. Idempotent: running it again on an
// already-erased address finds nothing further to do.
//
// Deliberately does NOT touch session events, raw provider bytes, resolution
// attempts, challenge verdicts, or livestream oracle evidence — that is the
// evidence a market's resolution rests on, not this account's data to take
// back. See docs/runbooks/DATA_PRIVACY_AND_RETENTION.md for the full
// inventory and why.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, SqliteChatStore, SqliteReferralStore, SqliteAcceptanceStore } from "../src/ports/sqlite-stores.mjs";

const [dataDir, address] = process.argv.slice(2);

if (!dataDir || !address) {
  console.error("usage: node scripts/erase-account.mjs <TM_DATA_DIR> <0xAddress>");
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error(`"${address}" does not look like an address. Refusing to guess what was meant.`);
  process.exit(1);
}

const source = join(dataDir, "room.db");
if (!existsSync(source)) {
  console.error(`No durable state at ${source}.`);
  console.error(`Check TM_DATA_DIR, or the service has not written yet.`);
  process.exit(1);
}

let database;
try {
  database = openDatabase(source);
} catch (error) {
  console.error(`Could not open ${source}: ${error.message}`);
  process.exit(1);
}

let chat, referrals, acceptances;
try {
  chat = await new SqliteChatStore(database).eraseAccount(address);
  referrals = await new SqliteReferralStore(database).eraseAccount(address);
  acceptances = await new SqliteAcceptanceStore(database).eraseAccount(address);
} finally {
  database.close();
}

console.log(`Erased ${address} from ${source}:`);
console.log(`  chat: ${chat.messagesErased} message(s) tombstoned, ${chat.timeoutsCleared} active timeout(s) cleared`);
console.log(
  `  referrals: own binding ${referrals.ownBindingDeleted ? "deleted" : "not found"}, ` +
    `${referrals.referredBindingsRedacted} binding(s) redacted where this account was the referrer`
);
console.log(`  terms acceptance: ${acceptances.deleted ? "deleted" : "not found"}`);

const touchedNothing =
  chat.messagesErased === 0 &&
  chat.timeoutsCleared === 0 &&
  !referrals.ownBindingDeleted &&
  referrals.referredBindingsRedacted === 0 &&
  !acceptances.deleted;

if (touchedNothing) {
  console.log("\nNothing was found for this address here — either it never had erasable data, or this already ran.");
}

console.log(
  "\nNot touched: session events, raw provider bytes, resolution attempts, challenge verdicts, livestream " +
    "oracle evidence. That is settlement evidence, not this account's data to take back — see " +
    "docs/runbooks/DATA_PRIVACY_AND_RETENTION.md."
);
