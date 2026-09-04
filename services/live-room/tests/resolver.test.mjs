// Issue 14: resolver nodes reconstruct results from RAW data independently.
// Three operators must agree; a corrupted log must fail closed to no
// attestation; nothing may read `facts`/`derived` as a resolution input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";
import { ResolverNode, OUTCOME_ENUM } from "../src/resolver/resolver.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

const connectorAccount = privateKeyToAccount(generatePrivateKey());

const PARTICIPANTS = [
  { key: "alice", address: "0xAAA0000000000000000000000000000000000001" },
  { key: "bob", address: "0xBBB0000000000000000000000000000000000002" },
];
const HEADLINE = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "1000" } };
const THRESHOLD = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "bob", metric: "return_pct", operator: ">=", value: "2" },
};
const RACE = {
  condition_version: "1.0.0",
  template: "first_to_metric",
  params: { metric: "realized_pnl_usd", operator: ">=", value: "800" },
};

function fill(tid, timeMs, closedPnl, fee = "0") {
  return { tid, time: timeMs, closedPnl, fee, coin: "ETH", side: "B", px: "1", sz: "1" };
}

class RecordingChain {
  constructor() {
    this.attestations = [];
  }

  async attestResult(market, outcomeEnum, evidenceHash) {
    this.attestations.push({ market, outcomeEnum, evidenceHash });
  }
}

/** Builds a session log with archived raw payloads. */
async function buildSession() {
  const store = new MemoryEventStore();
  const rawArchive = new MemoryRawArchive();
  let tick = 0;
  const connector = new SourceConnector({
    roomId: "room-resolve",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: connectorAccount,
    clock: () => new Date(1700000000000 + ++tick * 1000).toISOString(),
  });

  for (const participant of PARTICIPANTS) {
    const state = { marginSummary: { accountValue: "10000" } };
    await connector.ingestBatch({
      rawBytes: JSON.stringify(state),
      rawQuery: { endpoint: "info", type: "clearinghouseState", user: participant.address, at: 1000 },
      drafts: [normalizeBaseline(participant.key, participant.address, state, 1000)],
    });
  }

  // bob crosses 2% (>=200) at t=4000; alice reaches the 1000 target at t=7000.
  const bobFills = [fill(11, 3000, "150"), fill(12, 4000, "100")];
  await connector.ingestBatch({
    rawBytes: JSON.stringify(bobFills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: PARTICIPANTS[1].address, startTime: 0, endTime: 5000 },
    drafts: normalizeFillsResponse("bob", PARTICIPANTS[1].address, bobFills),
  });
  const aliceFills = [fill(21, 5000, "600"), fill(22, 7000, "400")];
  await connector.ingestBatch({
    rawBytes: JSON.stringify(aliceFills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: PARTICIPANTS[0].address, startTime: 0, endTime: 8000 },
    drafts: normalizeFillsResponse("alice", PARTICIPANTS[0].address, aliceFills),
  });
  return { store, rawArchive };
}

function makeResolver(name, rawArchive, chain) {
  return new ResolverNode({ name, rawArchive, participants: PARTICIPANTS, signerChain: chain });
}

test("three independent nodes reach the same payout vector for a replayed session", async () => {
  const { store, rawArchive } = await buildSession();
  const results = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const chain = new RecordingChain();
    const resolver = makeResolver(name, rawArchive, chain);
    const outcome = await resolver.resolveSlot({
      market: "0xHEADLINE",
      condition: HEADLINE,
      conditionHash: conditionHash(HEADLINE),
      headlineCondition: HEADLINE,
      logEvents: store.all(),
      participantAKey: "alice",
      participantBKey: "bob",
    });
    assert.equal(outcome.attested, true, JSON.stringify(outcome));
    results.push([outcome.outcomeEnum, outcome.evidenceHash]);
  }
  assert.equal(results[0][0], OUTCOME_ENUM.a, "alice reached the target first");
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2], "identical evidence hash across operators");
});

test("threshold and race slots resolve against the same raw reconstruction", async () => {
  const { store, rawArchive } = await buildSession();
  const chain = new RecordingChain();
  const resolver = makeResolver("alpha", rawArchive, chain);

  const threshold = await resolver.resolveSlot({
    market: "0xTHRESHOLD",
    condition: THRESHOLD,
    conditionHash: conditionHash(THRESHOLD),
    headlineCondition: HEADLINE,
    logEvents: store.all(),
    participantAKey: "alice",
    participantBKey: "bob",
  });
  assert.equal(threshold.attested, true);
  assert.equal(threshold.outcomeEnum, OUTCOME_ENUM.yes, "bob crossed 2% before the terminal fill");

  const race = await resolver.resolveSlot({
    market: "0xRACE",
    condition: RACE,
    conditionHash: conditionHash(RACE),
    headlineCondition: HEADLINE,
    logEvents: store.all(),
    participantAKey: "alice",
    participantBKey: "bob",
  });
  assert.equal(race.attested, true);
  assert.equal(race.outcomeEnum, OUTCOME_ENUM.a, "alice passed 800 at the same fill that ended the session");
  assert.equal(chain.attestations.length, 2);
});

test("a corrupted normalized event is detected and no attestation is submitted", async () => {
  const { store, rawArchive } = await buildSession();
  const chain = new RecordingChain();
  const resolver = makeResolver("alpha", rawArchive, chain);

  // A compromised connector rewrites a fact while leaving the raw bytes intact.
  const events = store.all().map((event) =>
    event.facts.tid === 21
      ? { ...event, facts: { ...event.facts, realized_pnl_usd: "999999" } }
      : event
  );

  const outcome = await resolver.resolveSlot({
    market: "0xHEADLINE",
    condition: HEADLINE,
    conditionHash: conditionHash(HEADLINE),
    headlineCondition: HEADLINE,
    logEvents: events,
    participantAKey: "alice",
    participantBKey: "bob",
  });
  assert.equal(outcome.attested, false);
  assert.equal(outcome.reason, "divergence");
  assert.ok(outcome.divergence.some((entry) => entry.kind === "fact_mismatch"));
  assert.equal(chain.attestations.length, 0, "no attestation on divergence — the market fails to Invalid");
  assert.equal(resolver.incidents.length, 1, "divergence raises an incident");
});

test("an omitted fact and a fabricated fact are both caught", async () => {
  const { store, rawArchive } = await buildSession();
  const resolver = makeResolver("alpha", rawArchive, new RecordingChain());

  const omitted = store.all().filter((event) => event.facts.tid !== 22);
  const omittedDivergence = resolver.compareWithLog(await resolver.reconstructFacts(omitted), omitted);
  assert.ok(omittedDivergence.some((entry) => entry.kind === "log_missing_fact"), "raw data has a fill the log dropped");

  const fabricated = [
    ...store.all(),
    { ...store.all()[2], source_event_id: "0xaaa:9999", kind: "trade_closed", facts: { realized_pnl_usd: "50000", tid: 9999 } },
  ];
  const fabricatedDivergence = resolver.compareWithLog(await resolver.reconstructFacts(fabricated), fabricated);
  assert.ok(fabricatedDivergence.some((entry) => entry.kind === "log_extra_fact"), "log has a fill the raw data lacks");
});

test("tampered raw bytes are rejected by the raw hash check", async () => {
  const { store, rawArchive } = await buildSession();
  const events = store.all();
  const target = events.find((event) => event.kind === "trade_closed");
  rawArchive.blobs.set(target.raw_ref, JSON.stringify([fill(99, 3000, "50000")]));

  const resolver = makeResolver("alpha", rawArchive, new RecordingChain());
  const reconstruction = await resolver.reconstructFacts(events);
  assert.ok(reconstruction.divergence.some((entry) => entry.kind === "raw_hash_mismatch"));
});

test("resolver source code never reads facts or derived as a resolution input", () => {
  const source = readFileSync(new URL("../src/resolver/resolver.mjs", import.meta.url), "utf8");
  const body = source.split("compareWithLog(reconstruction, logEvents)")[0];
  assert.ok(!/event\.derived/.test(source), "no code path reads event.derived");
  // Inside reconstruction, the log is touched only for raw pointers and kind.
  const reconstructBody = body.split("reconstructFacts(logEvents)")[1] ?? "";
  const logFieldReads = [...reconstructBody.matchAll(/event\.(\w+)/g)].map((match) => match[1]);
  const allowed = new Set(["kind", "raw_ref", "raw_hash", "raw_query"]);
  for (const field of logFieldReads) {
    assert.ok(allowed.has(field), `reconstruction read event.${field}, which is not a raw pointer`);
  }
});

test("missing raw archive entries fail closed rather than resolving", async () => {
  const { store, rawArchive } = await buildSession();
  const events = store.all();
  rawArchive.blobs.delete(events.find((event) => event.kind === "trade_closed").raw_ref);
  const chain = new RecordingChain();
  const resolver = makeResolver("alpha", rawArchive, chain);
  const outcome = await resolver.resolveSlot({
    market: "0xHEADLINE",
    condition: HEADLINE,
    conditionHash: conditionHash(HEADLINE),
    headlineCondition: HEADLINE,
    logEvents: events,
    participantAKey: "alice",
    participantBKey: "bob",
  });
  assert.equal(outcome.attested, false);
  assert.equal(chain.attestations.length, 0);
});

test("two resolvers that read the log at different moments still agree", async () => {
  // Quorum is two resolvers producing the SAME evidence hash. They run as
  // separate processes against a log the connector is still appending to, so
  // they never see byte-identical inputs — one reads before the next fill
  // lands, the other after.
  //
  // Facts after the one that determined the answer cannot change the answer,
  // and so must not change the evidence either. Including them made the hash a
  // function of when the resolver happened to look, which means two honest
  // resolvers reporting the same outcome never reach quorum, and the market
  // sits unresolved until it times out to Invalid.
  const { store, rawArchive } = await buildSession();

  const early = makeResolver("early", rawArchive, new RecordingChain());
  const earlyResult = await early.resolveSlot({
    market: "0xHEADLINE",
    condition: HEADLINE,
    conditionHash: conditionHash(HEADLINE),
    headlineCondition: HEADLINE,
    logEvents: store.all(),
    participantAKey: "alice",
    participantBKey: "bob",
  });
  assert.ok(earlyResult.attested, earlyResult.reason);

  // A fill lands after the session's terminal event — late reporting, or the
  // connector's reconciliation sweep catching up. The session already ended.
  const connector = new SourceConnector({
    roomId: "room-resolve",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: connectorAccount,
    clock: () => new Date(1700000900000).toISOString(),
  });
  const lateFills = [fill(31, 9000, "250")];
  await connector.ingestBatch({
    rawBytes: JSON.stringify(lateFills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: PARTICIPANTS[1].address, startTime: 8000, endTime: 10000 },
    drafts: normalizeFillsResponse("bob", PARTICIPANTS[1].address, lateFills),
  });

  const late = makeResolver("late", rawArchive, new RecordingChain());
  const lateResult = await late.resolveSlot({
    market: "0xHEADLINE",
    condition: HEADLINE,
    conditionHash: conditionHash(HEADLINE),
    headlineCondition: HEADLINE,
    logEvents: store.all(),
    participantAKey: "alice",
    participantBKey: "bob",
  });

  assert.ok(lateResult.attested, lateResult.reason);
  assert.equal(lateResult.outcomeEnum, earlyResult.outcomeEnum, "the outcome cannot depend on when you looked");
  assert.equal(
    lateResult.evidenceHash,
    earlyResult.evidenceHash,
    "and neither can the evidence, or quorum is unreachable between honest resolvers"
  );
});
