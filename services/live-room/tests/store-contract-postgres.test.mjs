// The PostgreSQL adapter against the same port contract.
//
// The contract file is imported unchanged — that is the entire point. An
// adapter that needed its own version of the contract would not be an adapter,
// it would be a second port wearing the same name.
//
// The database is real PostgreSQL. PGlite is the actual server compiled to
// WebAssembly, so the SQL dialect, the type system, the constraints and the
// transaction semantics are Postgres's own rather than a stand-in for them.
//
// What that does NOT verify, and must not be read as verifying: connection
// pooling under load, replication, failover, network partition behaviour, or
// any server-level configuration. Those need a real server and are a standing
// gap.

import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import { runStoreContract } from "./helpers/store-contract.mjs";
import {
  migrate,
  PostgresEventStore,
  PostgresRawArchive,
  PostgresKeyValue,
  PostgresChatStore,
  PostgresReferralStore,
  PostgresAcceptanceStore,
  PostgresResolutionLog,
  PostgresOracleProofStore,
  PostgresPublicationQueue,
  PostgresLeaderLease,
} from "../src/ports/postgres-stores.mjs";

runStoreContract({
  test,
  name: "postgres",
  async open() {
    const client = await PGlite.create();
    await migrate(client);
    return {
      eventLog: new PostgresEventStore(client),
      rawArchive: new PostgresRawArchive(client),
      keyValue: new PostgresKeyValue(client),
      chat: new PostgresChatStore(client),
      referrals: new PostgresReferralStore(client),
      acceptances: new PostgresAcceptanceStore(client),
      resolutionLog: new PostgresResolutionLog(client, "room-1", "0xresolver"),
      oracle: new PostgresOracleProofStore(client),
      leases: new PostgresLeaderLease(client),
      queue: new PostgresPublicationQueue(client, "room-1"),
      // A second store object on the same database, which is what the gate and
      // the publisher actually are.
      async reopenQueue() {
        return new PostgresPublicationQueue(client, "room-1");
      },
      close() {
        return client.close();
      },
    };
  },
});

test("[postgres] resolves a raw reference minted by the SQLite adapter", async (t) => {
  // Migration safety, and it is not cosmetic. Raw refs are written INTO the
  // session event log, which is the evidence a resolver reconstructs from. A
  // database migrated from SQLite carries `sqlite://raw/<id>` refs forever, and
  // an adapter that only understood its own scheme would make every migrated
  // market's evidence unreadable — which a resolver cannot distinguish from
  // evidence that was never recorded, so a storage migration would silently
  // become an invalidation.
  const assert = await import("node:assert/strict").then((m) => m.default);
  const client = await PGlite.create();
  t.after(() => client.close());
  await migrate(client);

  // Exactly what a migrated row looks like: the old scheme, carried over.
  const bytes = Buffer.from([0x01, 0x02, 0xfe]);
  await client.query("insert into raw_blob (ref, bytes) values ($1, $2)", [
    "sqlite://raw/legacy-blob",
    new Uint8Array(bytes),
  ]);

  const archive = new PostgresRawArchive(client);
  assert.deepEqual(
    await archive.get("sqlite://raw/legacy-blob"),
    bytes,
    "a ref recorded by the previous adapter must still resolve"
  );
  // And a ref that genuinely does not exist is still null, in either scheme.
  assert.equal(await archive.get("sqlite://raw/never-stored"), null);
  assert.equal(await archive.get("postgres://raw/never-stored"), null);
});
