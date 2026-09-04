// Regression tests for the independent review's service findings.
//
// (2) The GateAuthority must be restart-safe: the audit log and permit nonces
//     must survive a restart so a nonce is never reused, and suspension must be
//     reconciled from chain so a restart while suspended still reopens the room.
// (3) `unevaluable` must be handled durably: a persistence threshold, then
//     closure, then recovery or invalidation, and eventually bond release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { MemoryEventStore, MemoryRawArchive, FileKeyValue, MemoryKeyValue } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";
import { buildEvent } from "../src/domain/eventlog.mjs";

const gateAccount = privateKeyToAccount(generatePrivateKey());
const connectorAccount = privateKeyToAccount(generatePrivateKey());

const HEADLINE = "0xHEADLINE";
const MICRO = "0xMICRO";
const HEADLINE_CONDITION = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };
const MICRO_CONDITION = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "bob", metric: "return_pct", operator: ">=", value: "2" },
};
const FRESH_CONDITION = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "999999" },
};

function harness({ state, store = new MemoryEventStore(), chain = new FakeRoomChain(), unevaluableGraceMs = 30_000 } = {}) {
  const connector = new SourceConnector({
    roomId: "room-durable",
    source: "hyperliquid-testnet",
    store,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date().toISOString(),
  });
  const conditions = new Map([
    [HEADLINE, HEADLINE_CONDITION],
    [MICRO, MICRO_CONDITION],
  ]);
  const gate = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions,
    state,
    config: {
      epochDurationS: 10,
      sourceFinalityDelayS: 10,
      freshnessThresholdMs: 20_000,
      maxPermitLifetimeS: 300,
      unevaluableGraceMs,
      headlineMarket: HEADLINE,
    },
  });
  return { store, connector, chain, gate, conditions };
}

async function ingest(connector, participant, address, fills, endMs) {
  return connector.ingestBatch({
    rawBytes: JSON.stringify(fills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime: endMs },
    drafts: normalizeFillsResponse(participant, address, fills),
  });
}

const fill = (tid, timeMs, pnl) => ({ tid, time: timeMs, closedPnl: pnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });

/** Appends a fact a compromised connector could write: not a valid decimal. */
function appendCorrupt(store, seqOffset = 0) {
  const corrupt = buildEvent({
    tip: store.tip(),
    draft: {
      room_id: "room-durable",
      source: "hyperliquid-testnet",
      source_event_id: `corrupt-${store.count()}-${seqOffset}`,
      participant: "alice",
      observed_at: new Date(1_000 + store.count() * 1000).toISOString(),
      kind: "trade_closed",
      facts: { realized_pnl_usd: "corrupt" },
      raw_ref: "mem://raw/x",
      raw_hash: "0x0",
      raw_query: { endpoint: "info", type: "userFillsByTime", user: "0xa", startTime: 0, endTime: 2000 },
    },
    ingestedAt: new Date().toISOString(),
  });
  store.append(corrupt);
  return corrupt;
}

// ------------------------------------------------------------------ (2)

test("permit nonces survive a restart: a consumed nonce is never reissued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-state-"));
  const statePath = join(dir, "gate.json");

  const first = harness({ state: new FileKeyValue(statePath) });
  await ingest(first.connector, "alice", "0xA", [fill(1, 1000, "10")], 2000);
  const a = await first.gate.requestPermit({
    slotIndex: 1,
    templateId: "tpl-threshold-v1",
    params: FRESH_CONDITION.params,
    conditionDocument: FRESH_CONDITION,
    announceDelay: 30,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
    restricted: [],
  });
  assert.equal(a.refused, false);
  const usedNonce = a.permit.nonce;

  // Restart: a brand-new authority over the same persisted state.
  const second = harness({ state: new FileKeyValue(statePath), store: first.store, chain: first.chain });
  const b = await second.gate.requestPermit({
    slotIndex: 2,
    templateId: "tpl-threshold-v1",
    params: FRESH_CONDITION.params,
    conditionDocument: FRESH_CONDITION,
    announceDelay: 30,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
    restricted: [],
  });
  assert.equal(b.refused, false);
  assert.notEqual(b.permit.nonce, usedNonce, "a restarted gate must not reissue a consumed nonce");
  assert.ok(b.permit.nonce > usedNonce, "nonces advance monotonically across restarts");
});

test("the audit log survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-audit-"));
  const statePath = join(dir, "gate.json");

  const first = harness({ state: new FileKeyValue(statePath) });
  await ingest(first.connector, "alice", "0xA", [fill(1, 1000, "10")], 2000);
  await first.gate.requestPermit({
    slotIndex: 1,
    templateId: "tpl-threshold-v1",
    params: FRESH_CONDITION.params,
    conditionDocument: FRESH_CONDITION,
    announceDelay: 30,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
    restricted: [],
  });
  const entriesBefore = first.gate.audit.filter((entry) => entry.permit).length;
  assert.equal(entriesBefore, 1);

  const second = harness({ state: new FileKeyValue(statePath), store: first.store, chain: first.chain });
  // A restarted gate has not resumed until it loads. Reading `audit` straight
  // after construction would see an empty log and conclude it had never signed.
  await second.gate.load();
  const persisted = second.gate.audit.filter((entry) => entry.permit);
  assert.equal(persisted.length, 1, "the restarted gate still has the record of what it signed");
  assert.equal(persisted[0].permit, "signed");
  assert.ok(persisted[0].conditionHash, "the audit entry keeps the hash it attested");
});

test("a gate that restarts while the room is suspended still reopens it", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  const dir = mkdtempSync(join(tmpdir(), "gate-suspend-"));
  const statePath = join(dir, "gate.json");

  const first = harness({ state: new FileKeyValue(statePath), chain });
  await ingest(first.connector, "alice", "0xA", [fill(1, 1000, "1")], 2000);
  await first.gate.tick(60_000); // tip observed at 1s: stale
  assert.ok(chain.calls.some(([name]) => name === "suspendRoom"), "suspended before the restart");
  assert.equal(await chain.gateStateOf(HEADLINE), "suspended");

  // Restart. The new instance has never seen the suspension in its own memory.
  const second = harness({ state: new FileKeyValue(statePath), store: first.store, chain });
  await second.connector.heartbeat(new Date(61_000).toISOString());
  await second.gate.tick(62_000);

  assert.ok(chain.calls.some(([name]) => name === "reopenRoom"), "a restarted gate reconciles and reopens");
  assert.equal(await chain.gateStateOf(HEADLINE), "open");
});

test("a restarted gate does not re-suspend an already-suspended room", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  const first = harness({ state: new MemoryKeyValue(), chain });
  await ingest(first.connector, "alice", "0xA", [fill(1, 1000, "1")], 2000);
  await first.gate.tick(60_000);
  const suspendsAfterFirst = chain.calls.filter(([name]) => name === "suspendRoom").length;
  assert.equal(suspendsAfterFirst, 1);

  const second = harness({ state: new MemoryKeyValue(), store: first.store, chain });
  await second.gate.tick(61_000); // still stale
  assert.equal(
    chain.calls.filter(([name]) => name === "suspendRoom").length,
    suspendsAfterFirst,
    "chain state, not memory, decides whether a suspend is needed"
  );
});

// ------------------------------------------------------------------ (3)

test("a transient unevaluable headline suspends but does not close the room", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  const { store, gate, connector } = harness({ state: new MemoryKeyValue(), chain, unevaluableGraceMs: 30_000 });
  appendCorrupt(store);

  await gate.tick(10_000);
  assert.ok(chain.calls.some(([name]) => name === "suspendRoom"), "suspends immediately");
  assert.equal(chain.roomClosed, 0, "does not close inside the grace period");

  // The condition becomes evaluable again before the threshold elapses.
  gate.conditions.set(HEADLINE, HEADLINE_CONDITION);
  store.events = store.events.filter((event) => event.facts?.realized_pnl_usd !== "corrupt");
  await connector.heartbeat(new Date(20_000).toISOString());
  await gate.tick(25_000);
  assert.ok(chain.calls.some(([name]) => name === "reopenRoom"), "recovery reopens rather than invalidating");
  assert.equal(chain.roomClosed, 0);
});

test("a persistent unevaluable headline closes the room for recovery and invalidation", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  chain.addSlot(MICRO, 1, "0xC1");
  const { store, gate } = harness({ state: new MemoryKeyValue(), chain, unevaluableGraceMs: 30_000 });
  appendCorrupt(store);

  await gate.tick(10_000);
  assert.equal(chain.roomClosed, 0, "grace period still running");

  // Past the threshold with the condition still unevaluable.
  await gate.tick(50_000);
  assert.notEqual(chain.roomClosed, 0, "the room closes rather than hanging suspended forever");
  const closed = gate.audit.find((entry) => entry.action === "closeRoom");
  assert.match(closed.reason ?? "", /unevaluable/, "the close records why");

  // Every slot ends up closed, so resolution can run and bonds can release.
  assert.ok(chain.slots.every((slot) => slot.closed), "all slots closed for resolution");
});

test("a persistent unevaluable micro condition closes only that slot", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  chain.addSlot(MICRO, 1, "0xC1");
  const { store, connector, gate } = harness({ state: new MemoryKeyValue(), chain, unevaluableGraceMs: 30_000 });
  // The headline stays evaluable; only the micro condition is broken.
  gate.conditions.set(MICRO, { condition_version: "1.0.0", template: "nope", params: {} });
  await ingest(connector, "alice", "0xA", [fill(1, 5000, "100")], 9000);
  await connector.heartbeat(new Date(12_000).toISOString());

  await gate.tick(15_000);
  assert.equal(chain.slots.find((slot) => slot.market === MICRO).closed, false, "grace period running");

  await connector.heartbeat(new Date(50_000).toISOString());
  await gate.tick(55_000);
  assert.equal(chain.slots.find((slot) => slot.market === MICRO).closed, true, "the broken micro slot closes");
  assert.equal(chain.slots.find((slot) => slot.market === HEADLINE).closed, false, "the headline keeps running");
  assert.equal(chain.roomClosed, 0, "one broken question does not end the session");
});

test("the unevaluable clock is persisted, so a restart cannot reset the grace period", async () => {
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xC0");
  const dir = mkdtempSync(join(tmpdir(), "gate-uneval-"));
  const statePath = join(dir, "gate.json");

  const first = harness({ state: new FileKeyValue(statePath), chain, unevaluableGraceMs: 30_000 });
  appendCorrupt(first.store);
  await first.gate.tick(10_000);
  assert.equal(chain.roomClosed, 0);

  // Restart mid-grace. A memory-only clock would start over here and the room
  // would stay suspended forever across a restart loop.
  const second = harness({
    state: new FileKeyValue(statePath),
    store: first.store,
    chain,
    unevaluableGraceMs: 30_000,
  });
  await second.gate.tick(50_000);
  assert.notEqual(chain.roomClosed, 0, "the persisted clock still expires after a restart");
});

test("the gate reports its durable state for the runbook", async () => {
  const { gate, store } = harness({ state: new MemoryKeyValue() });
  await store;
  const snapshot = await gate.durableState();
  assert.equal(typeof snapshot.nextNonce, "number");
  assert.ok(Array.isArray(snapshot.audit));
  assert.ok("unevaluableSince" in snapshot);
});
