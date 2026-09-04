// The gate, running on PostgreSQL.
//
// The point of making the durable-store port async was not tidiness — it was
// that the service could not use the PostgreSQL adapter at all while the port
// was synchronous. This is the proof the conversion achieved that: the same
// GateAuthority, unmodified, resuming its nonce and audit from Postgres rather
// than SQLite.
//
// It also pins the property the whole conversion risked breaking. A gate that
// signs from nonce 1 after a restart has its permits refused by the room for a
// reused nonce, and the symptom is a room that publishes nothing and gives no
// reason.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { PGlite } from "@electric-sql/pglite";

import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";
import { migrate, PostgresKeyValue } from "../src/ports/postgres-stores.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

const MARKET = "0xMARKET";
const CONDITION = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "1000" } };

function gateOn(state, chain, store) {
  return new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: privateKeyToAccount(generatePrivateKey()),
    conditions: new Map([[MARKET, CONDITION]]),
    state,
    config: {
      epochDurationS: 10,
      sourceFinalityDelayS: 5,
      freshnessThresholdMs: 10 ** 9,
      maxPermitLifetimeS: 300,
      maxPendingTimeS: 90,
      unevaluableGraceMs: 60_000,
      headlineMarket: null,
    },
  });
}

test("a gate resumes its nonce and audit from PostgreSQL", async (t) => {
  const client = await PGlite.create();
  t.after(() => client.close());
  await migrate(client);

  const state = new PostgresKeyValue(client);
  const chain = new FakeRoomChain();
  chain.addSlot(MARKET, 0, conditionHash(CONDITION));
  const store = new MemoryEventStore();

  const first = gateOn(state, chain, store);
  await first.load();
  // Advance the nonce and write an audit entry the way real work does.
  await first._save("nextNonce", 7);
  await first._log({ action: "closeRoom", seq: 3 });

  // A different process, same database.
  const restarted = gateOn(state, new FakeRoomChain(), store);
  await restarted.load();

  assert.equal(restarted.nextNonce, 7, "the nonce counter survives; signing from 1 again gets every permit refused");
  assert.equal(restarted.audit.length, 1, "and so does the record of what it signed");
  assert.equal(restarted.audit[0].action, "closeRoom");
});

test("a gate with no stored state starts from the documented defaults", async (t) => {
  const client = await PGlite.create();
  t.after(() => client.close());
  await migrate(client);

  const gate = gateOn(new PostgresKeyValue(client), new FakeRoomChain(), new MemoryEventStore());
  await gate.load();

  // 1, not 0 and not NaN: the room's first permit uses nonce 1.
  assert.equal(gate.nextNonce, 1);
  assert.deepEqual(gate.audit, []);
});

test("durableState() reports what is stored, not what construction guessed", async (t) => {
  // The runbook inspects this. Before the port went async it read whatever the
  // constructor had loaded; now it must load first, or a restarted gate would
  // report a clean slate it does not have.
  const client = await PGlite.create();
  t.after(() => client.close());
  await migrate(client);

  const state = new PostgresKeyValue(client);
  await state.set("gate.nextNonce", 12);

  const gate = gateOn(state, new FakeRoomChain(), new MemoryEventStore());
  const snapshot = await gate.durableState();
  assert.equal(snapshot.nextNonce, 12, "durableState must load before answering");
});
