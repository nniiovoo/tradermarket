// Issue 05: the Source Gate Authority — replay-deterministic gating, decisive
// closes before clearance, suspension on staleness or unevaluable conditions,
// permit signing with self-computed hashes, and crash-resume without double work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { buildEvent } from "../src/domain/eventlog.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

const gateAccount = privateKeyToAccount(generatePrivateKey());
const connectorAccount = privateKeyToAccount(generatePrivateKey());

const HEADLINE_MARKET = "0xHEADLINE";
const MICRO_MARKET = "0xMICRO";
const HEADLINE_CONDITION = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };
const MICRO_CONDITION = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "bob", metric: "return_pct", operator: ">=", value: "2" },
};

function fill(tid, timeMs, closedPnl) {
  return { tid, time: timeMs, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" };
}

function harness({ epochDurationS = 10, sourceFinalityDelayS = 10, freshnessThresholdMs = 20_000 } = {}) {
  const store = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-gate",
    source: "hyperliquid-testnet",
    store,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date().toISOString(),
  });
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE_MARKET, 0, conditionHash(HEADLINE_CONDITION));
  chain.addSlot(MICRO_MARKET, 1, conditionHash(MICRO_CONDITION));
  const conditions = new Map([
    [HEADLINE_MARKET, HEADLINE_CONDITION],
    [MICRO_MARKET, MICRO_CONDITION],
  ]);
  const gate = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions,
    config: {
      epochDurationS,
      sourceFinalityDelayS,
      freshnessThresholdMs,
      maxPermitLifetimeS: 300,
      headlineMarket: HEADLINE_MARKET,
    },
  });
  return { store, connector, chain, gate };
}

async function ingestFills(connector, participant, address, fills, windowEnd) {
  return connector.ingestBatch({
    rawBytes: JSON.stringify(fills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime: windowEnd },
    drafts: normalizeFillsResponse(participant, address, fills),
  });
}

test("undecided epochs clear at the tip sequence after the finality delay", async () => {
  const { connector, chain, gate } = harness();
  const epochEndMs = 10_000; // epoch 0 ends at t=10s
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());

  // Before finality delay: nothing clears.
  await gate.tick(epochEndMs + 5_000);
  assert.equal(chain.calls.filter(([name]) => name === "markRoomEpochsSafe").length, 0);

  // After epoch end + finality delay, with the log observed past the boundary.
  await gate.tick(epochEndMs + 10_500);
  const marks = chain.calls.filter(([name]) => name === "markRoomEpochsSafe");
  assert.equal(marks.length, 1);
  const [, seq, markets, epochs] = marks[0];
  assert.equal(seq, 2, "watermark is the fully-evaluated tip sequence");
  assert.deepEqual(new Set(markets), new Set([HEADLINE_MARKET, MICRO_MARKET]));
  assert.ok(epochs.every((epoch) => epoch === 0));
  assert.ok(chain.calls.some(([name]) => name === "processRoom"), "cleared epochs get processed");
});

test("a decisive headline event closes the room before any clearance, and ticks are idempotent", async () => {
  const { connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "10000")], 9_000);
  await gate.tick(21_000);

  assert.ok(chain.calls.some(([name]) => name === "closeRoom"), "room closed on the decisive event");
  assert.ok(!chain.calls.some(([name]) => name === "markRoomEpochsSafe"), "no epoch cleared past the decision");
  const closeSeq = chain.calls.find(([name]) => name === "closeRoom")[1];
  assert.equal(closeSeq, 1, "closed at the decisive event's sequence, not the tip");
  assert.equal(await chain.roomClosedSequence(), 1);

  const callsBefore = chain.calls.length;
  await gate.tick(22_000);
  assert.equal(chain.calls.length, callsBefore, "post-close ticks add nothing once slots are closed");
});

test("a micro decision closes only that slot; the headline keeps clearing", async () => {
  const { store, connector, chain, gate } = harness();
  await connector.ingestBatch({
    rawBytes: "{}",
    rawQuery: { endpoint: "info", type: "clearinghouseState", user: "0xB", at: 1000 },
    drafts: [normalizeBaseline("bob", "0xB", { marginSummary: { accountValue: "10000" } }, 1_000)],
  });
  await ingestFills(connector, "bob", "0xB", [fill(2, 6_000, "250")], 9_000); // 2.5% >= 2%
  await gate.tick(21_000);

  const closes = chain.calls.filter(([name]) => name === "closeSlots");
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0][2], [MICRO_MARKET]);
  assert.equal(closes[0][1], 2, "closed at the deciding sequence");
  assert.ok(!chain.calls.some(([name]) => name === "closeRoom"), "headline unaffected");

  // Later ticks keep clearing the headline: one epoch per market per tick,
  // oldest first, each at a strictly newer heartbeat-advanced sequence.
  await connector.heartbeat(new Date(23_000).toISOString());
  await gate.tick(31_000); // clears epoch 0
  await connector.heartbeat(new Date(31_500).toISOString());
  await gate.tick(32_000); // clears epoch 1 at the newer sequence
  const marks = chain.calls.filter(([name]) => name === "markRoomEpochsSafe");
  assert.equal(marks.length, 2);
  for (const [, , markets] of marks) {
    assert.deepEqual(markets, [HEADLINE_MARKET], "only the open headline clears");
  }
  assert.deepEqual(marks.map(([, , , epochs]) => epochs[0]), [0, 1], "oldest epoch first, then the next");
  assert.equal(chain.skips.length, 0, "no child call reverted");
});

test("staleness suspends, recovery reopens, and nothing clears while stale", async () => {
  const { connector, chain, gate } = harness({ freshnessThresholdMs: 5_000 });
  await ingestFills(connector, "alice", "0xA", [fill(1, 1_000, "1")], 2_000);

  await gate.tick(30_000); // tip observed at 1s; 29s stale
  assert.ok(chain.calls.some(([name]) => name === "suspendRoom"));
  assert.ok(!chain.calls.some(([name]) => name === "markRoomEpochsSafe"));

  await connector.heartbeat(new Date(31_000).toISOString());
  await gate.tick(32_000);
  assert.ok(chain.calls.some(([name]) => name === "reopenRoom"));
});

test("an unevaluable headline suspends instead of guessing", async () => {
  const { store, chain, gate } = harness();
  // A corrupt fact cannot pass the normalizer, so model a compromised
  // connector writing garbage into the log directly.
  const corrupt = buildEvent({
    tip: null,
    draft: {
      room_id: "room-gate",
      source: "hyperliquid-testnet",
      source_event_id: "0xa:1",
      participant: "alice",
      observed_at: new Date(1_000).toISOString(),
      kind: "trade_closed",
      facts: { realized_pnl_usd: "corrupt" },
      raw_ref: "mem://raw/x",
      raw_hash: "0x0",
      raw_query: { endpoint: "info", type: "userFillsByTime", user: "0xa", startTime: 0, endTime: 2000 },
    },
    ingestedAt: new Date(1_100).toISOString(),
  });
  store.append(corrupt);
  await gate.tick(5_000);
  assert.ok(chain.calls.some(([name]) => name === "suspendRoom"), "fail closed on unevaluable");
  assert.ok(!chain.calls.some(([name]) => name === "closeRoom"));
});

test("crash-resume does not double-sign: cleared epochs reconcile against the chain", async () => {
  const { store, connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());
  await gate.tick(20_500);
  const marksBefore = chain.calls.filter(([name]) => name === "markRoomEpochsSafe").length;
  assert.equal(marksBefore, 1);

  // A fresh authority instance (crash) over the same store and chain.
  const resumed = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions: new Map([
      [HEADLINE_MARKET, HEADLINE_CONDITION],
      [MICRO_MARKET, MICRO_CONDITION],
    ]),
    config: {
      epochDurationS: 10,
      sourceFinalityDelayS: 10,
      freshnessThresholdMs: 20_000,
      maxPermitLifetimeS: 300,
      headlineMarket: HEADLINE_MARKET,
    },
  });
  await connector.heartbeat(new Date(20_600).toISOString());
  await resumed.tick(20_900);
  const marksAfter = chain.calls.filter(([name]) => name === "markRoomEpochsSafe").length;
  assert.equal(marksAfter, marksBefore, "already-safe epochs are not re-marked after resume");
});

test("permits: refused for decided and unevaluable, signed for undecided, hashes self-computed", async () => {
  const { connector, gate } = harness();
  await connector.ingestBatch({
    rawBytes: "{}",
    rawQuery: { endpoint: "info", type: "clearinghouseState", user: "0xB", at: 1000 },
    drafts: [normalizeBaseline("bob", "0xB", { marginSummary: { accountValue: "10000" } }, 1_000)],
  });
  await ingestFills(connector, "bob", "0xB", [fill(2, 6_000, "250")], 9_000);

  // Decided (bob already >= 2%): refused with a distinct reason.
  const refusedDecided = await gate.requestPermit({
    slotIndex: 2,
    templateId: "tpl-threshold-v1",
    params: MICRO_CONDITION.params,
    conditionDocument: MICRO_CONDITION,
    announceDelay: 30,
    // The log's newest observation is at t=9s; the permit is requested just
    // after it, so freshness is not what is under test here.
    nowMs: 10_000,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
    restricted: [],
  });
  assert.equal(refusedDecided.refused, true);
  assert.match(refusedDecided.reason, /decided/);

  // Unevaluable (unknown template): refused with a distinct reason.
  const refusedUnevaluable = await gate.requestPermit({
    slotIndex: 2,
    templateId: "tpl-unknown",
    params: {},
    conditionDocument: { condition_version: "1.0.0", template: "nope", params: {} },
    announceDelay: 30,
    nowMs: 10_000,
  });
  assert.equal(refusedUnevaluable.refused, true);
  assert.match(refusedUnevaluable.reason, /unevaluable/);

  // Undecided: signed, with the gate's own hash of the condition document.
  const fresh = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "return_pct", operator: ">=", value: "50" },
  };
  const signed = await gate.requestPermit({
    slotIndex: 2,
    templateId: "tpl-threshold-v1",
    params: fresh.params,
    conditionDocument: fresh,
    announceDelay: 30,
    nowMs: 10_000,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
    restricted: [],
  });
  assert.equal(signed.refused, false);
  assert.equal(signed.permit.conditionHash, conditionHash(fresh));
  assert.equal(signed.permit.undecidedThroughSequence, 2n, "attests the evaluated tip");
  assert.ok(signed.signature.startsWith("0x"));

  // Every outcome is in the audit log.
  const outcomes = gate.audit.filter((entry) => entry.permit).map((entry) => entry.permit);
  assert.deepEqual(outcomes, ["refused", "refused", "signed"]);
});

test("a correction that decides the headline in the past still closes the room", async () => {
  // A provider can restate a fill upward. The session's terminal condition was
  // then met earlier than anyone knew at the time — at a sequence the room's
  // watermark has already passed. The chain refuses a sequence that regresses,
  // and rightly: a watermark that can move backwards is not a watermark. So the
  // gate must close the room at a sequence the chain accepts while recording
  // the sequence the session actually ended at. Throwing instead leaves a
  // decided room open, with bonds locked and every market unresolved.
  const { connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "4000")], 9_000);
  await ingestFills(connector, "alice", "0xA", [fill(2, 6_000, "3000")], 9_500);
  await connector.heartbeat(new Date(12_000).toISOString());
  await gate.tick(30_000);
  const watermark = await chain.lastObservedSequence();
  assert.ok(watermark > 0, "an epoch cleared, so the room has a watermark");
  assert.equal(await chain.roomClosedSequence(), 0, "7000 does not reach the 10000 target");

  // The restatement puts alice over the target as of the SECOND fill, whose
  // sequence the watermark has already passed.
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "9000")], 20_000);
  await connector.heartbeat(new Date(22_000).toISOString());
  await gate.tick(40_000);

  const closedAt = Number(await chain.roomClosedSequence());
  assert.notEqual(closedAt, 0, "the room is decided and must not stay open");
  assert.ok(closedAt >= watermark, "and it closed at a sequence the chain accepts");
  const closing = gate.audit.find((entry) => entry.action === "closeRoom");
  assert.equal(closing.outcome, "alice");
  assert.ok(closing.seq < closedAt, "the record keeps the sequence the session actually ended at");
});

test("an epoch the chain skipped is retried, not remembered as cleared", async () => {
  // `markRoomEpochsSafe` isolates child failures: a market that rejects the
  // call is skipped and logged, and the room reports success. The gate recorded
  // the epoch as cleared anyway, without looking, and its own short-circuit then
  // ensured it was never attempted again — so the Forecaster actions waiting in
  // that epoch were never executed, only refunded when they timed out.
  //
  // The skip is not hypothetical: a market rejects any sequence at or below its
  // own watermark, and `reopenRoom` raises that watermark to the tip. So the
  // first clearance after every recovery from an outage lands on exactly the
  // sequence the market just moved to.
  const { connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());

  // The market's watermark is raised out from under the clearance, exactly as
  // reopenGate does on chain.
  const original = chain.markRoomEpochsSafe.bind(chain);
  chain.markRoomEpochsSafe = async (seq, markets, epochs) => {
    for (const market of markets) chain._slot(market).lastSafeSeq = seq;
    return original(seq, markets, epochs);
  };

  await gate.tick(30_000);
  assert.equal(await chain.isEpochSafe(HEADLINE_MARKET, 0), false, "the chain skipped it");

  // A later tick, with the collision gone, has to try again — while the epoch
  // is still inside the window that could hold a pending action.
  chain.markRoomEpochsSafe = original;
  await connector.heartbeat(new Date(30_000).toISOString());
  await gate.tick(35_000);
  assert.equal(
    await chain.isEpochSafe(HEADLINE_MARKET, 0),
    true,
    "an epoch the chain never cleared must not be remembered as cleared"
  );
});

test("a slot published during an outage is suspended too, not left trading on a dead feed", async () => {
  // Suspension was short-circuited on "is the room already suspended", which
  // both the chain port and the fallback answer with "is ANY slot suspended".
  // So once the first slot was frozen, the gate stopped calling suspendRoom —
  // and a slot published while the outage was still running was never frozen at
  // all. It opened, and accepted orders, against a feed that had stopped.
  const { connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());

  await gate.tick(60_000); // far past the freshness threshold
  assert.equal(await chain.gateStateOf(HEADLINE_MARKET), "suspended");

  // A new slot appears while the source is still dead.
  chain.addSlot("0xLATE", 2, conditionHash(MICRO_CONDITION));
  gate.conditions.set("0xLATE", MICRO_CONDITION);
  await gate.tick(70_000);

  assert.equal(
    await chain.gateStateOf("0xLATE"),
    "suspended",
    "a market on a dead feed must not be open for orders"
  );
});

test("the gate will not sign a publication permit while the source is stale", async () => {
  // The prevention, upstream of the cure: authorising a new market on a feed
  // that has stopped is not something to fix after the fact.
  const { connector, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());

  const request = {
    templateId: "tpl-threshold-v1",
    templateParamsHash: conditionHash(MICRO_CONDITION),
    conditionHash: conditionHash(MICRO_CONDITION),
    announceDelay: 30,
    winnerRewardBps: 0,
    question: "Published into an outage?",
    streamUrl: "",
    imageUrl: "",
  };
  const result = await gate.requestPermit({
    slotIndex: 3,
    templateId: "tpl-threshold-v1",
    params: MICRO_CONDITION.params,
    conditionDocument: MICRO_CONDITION,
    announceDelay: 30,
    request,
    nowMs: 200_000, // long after the last observation
  });
  assert.equal(result.refused, true);
  assert.match(result.reason, /stale|fresh/i);
});

test("a suspended room refuses a permit whatever clock the caller is on", async () => {
  // The clock-free half of the same rule. A room the gate has already frozen
  // for a dead source is not a room to authorise a new market in, and that
  // judgement is a chain fact rather than something a caller has to remember
  // to prove with a timestamp.
  const { connector, chain, gate } = harness();
  await ingestFills(connector, "alice", "0xA", [fill(1, 5_000, "100")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());
  await gate.tick(60_000);
  assert.equal(await chain.gateStateOf(HEADLINE_MARKET), "suspended");

  const result = await gate.requestPermit({
    slotIndex: 4,
    templateId: "tpl-threshold-v1",
    params: MICRO_CONDITION.params,
    conditionDocument: MICRO_CONDITION,
    announceDelay: 30,
    request: { templateId: "tpl", question: "Q", streamUrl: "", imageUrl: "", winnerRewardBps: 0, announceDelay: 30 },
  });
  assert.equal(result.refused, true);
  assert.match(result.reason, /suspend/i);
});

test("a watermark pushed past the log tip does not stop the gate from suspending", async () => {
  // Closing a slot raises the room's watermark to one past the decisive
  // sequence — necessary, because the chain refuses a sequence at or behind it.
  // But when the log tip is what supplied that sequence, the watermark now
  // exceeds the tip, and every later call that sends the tip sequence —
  // suspension above all — reverts SequenceRegression.
  //
  // The source going quiet is exactly when that happens: the tip stops moving
  // while the grace period on an unevaluable slot expires. So the gate would
  // throw on every tick, and the room would stay OPEN on a dead feed, for as
  // long as the outage lasted.
  const { connector, chain, gate } = harness({ freshnessThresholdMs: 20_000 });
  gate.config.unevaluableGraceMs = 1_000;

  // bob has fills but no baseline, so return_pct cannot be evaluated.
  await ingestFills(connector, "bob", "0xB", [fill(2, 5_000, "250")], 9_000);
  await connector.heartbeat(new Date(12_000).toISOString());

  await gate.tick(30_000); // marks the micro unevaluable
  await gate.tick(40_000); // grace expired: the micro slot closes

  const watermark = await chain.lastObservedSequence();
  const tip = connector.store?.tip?.() ?? null;
  assert.ok(watermark > (tip?.seq ?? 0), `watermark ${watermark} should now exceed tip ${tip?.seq}`);

  // The source is now silent and stale. The gate has to freeze the room.
  await gate.tick(120_000);
  assert.equal(
    await chain.gateStateOf(HEADLINE_MARKET),
    "suspended",
    "a room on a dead feed must be frozen, whatever the watermark says"
  );
});
