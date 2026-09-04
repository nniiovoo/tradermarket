// The SQLite adapter against the port contract.
//
// SQLite is the local and test adapter and stays that way. Running it against
// the same contract as every other adapter is what makes the contract a
// definition rather than a description of one implementation — a rule only one
// adapter is held to is not a rule.

import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runStoreContract } from "./helpers/store-contract.mjs";
import {
  openDatabase,
  SqliteEventStore,
  SqliteRawArchive,
  SqliteKeyValue,
  SqliteChatStore,
  SqliteReferralStore,
  SqliteAcceptanceStore,
  SqliteResolutionLog,
  SqliteOracleProofStore,
  SqliteLeaderLease,
} from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";

runStoreContract({
  test,
  name: "sqlite",
  async open() {
    // A real file, not :memory:, so the "another process sees it" case is
    // genuinely tested rather than trivially satisfied by a shared handle.
    const dir = mkdtempSync(join(tmpdir(), "tm-contract-sqlite-"));
    const path = join(dir, "room.db");
    const db = openDatabase(path);
    return {
      eventLog: new SqliteEventStore(db),
      rawArchive: new SqliteRawArchive(db),
      keyValue: new SqliteKeyValue(db),
      chat: new SqliteChatStore(db),
      referrals: new SqliteReferralStore(db),
      acceptances: new SqliteAcceptanceStore(db),
      resolutionLog: new SqliteResolutionLog(db, "room-1", "0xresolver"),
      oracle: new SqliteOracleProofStore(db),
      leases: new SqliteLeaderLease(db),
      queue: new SqlitePublicationQueue(db, "room-1"),
      async reopenQueue() {
        const second = openDatabase(path);
        return new SqlitePublicationQueue(second, "room-1");
      },
      close() {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
