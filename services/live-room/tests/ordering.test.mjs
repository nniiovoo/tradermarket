// What order did the world happen in?
//
// The Session Event Log is append-only, so its sequence numbers record the
// order facts REACHED US. That is not the order they happened in. A provider
// indexes one account before another, a window is re-asked after a failure, and
// the reconciliation sweep exists precisely to append facts late — so a fill at
// t=1000 can arrive after a fill at t=1200, routinely.
//
// Every condition in this system is "the FIRST participant to…" or "the first
// time X exceeds…". Order is not a detail of those questions; order IS those
// questions. The resolver has always known this and sorts by provider fill time
// (ADR 0024: "Independent ordering: provider fill time, then trade id. Never
// the connector's sequence numbers"). The gate's evaluator walked the log in
// sequence order instead.
//
// So the two could name different winners from the same facts, with no
// divergence to show for it: `compareWithLog` matches fact for fact, because
// every fact IS identical. Only the order differed, and nothing compared that.
// The room closes on one participant while both resolvers attest the other, and
// the market pays the side its own settlement record contradicts.

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import { SourceConnector } from "../src/connector/connector.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { normalizeFillsResponse } from "../src/connector/hyperliquid.mjs";
import { evaluateCondition, foldMetrics, rectify } from "../src/domain/conditions.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";

const KEY = "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82";
const ALICE = "0x000000000000000000000000000000000000000a";
const BOB = "0x000000000000000000000000000000000000000b";
const PARTICIPANTS = [
  { key: "alice", address: ALICE },
  { key: "bob", address: BOB },
];

const fill = (tid, time, closedPnl) => ({ tid, time, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });

function session() {
  const store = new MemoryEventStore();
  const rawArchive = new MemoryRawArchive();
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: privateKeyToAccount(KEY),
    clock: () => "2026-01-01T00:00:00.000Z",
  });
  return {
    store,
    rawArchive,
    post: (key, address, fills, endTime) =>
      connector.ingestBatch({
        rawBytes: JSON.stringify(fills),
        rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime },
        drafts: normalizeFillsResponse(key, address, fills),
      }),
  };
}

async function resolverVerdict({ rawArchive, store }, condition, headline = condition) {
  const node = new ResolverNode({ name: "r1", rawArchive, participants: PARTICIPANTS, signerChain: null });
  const events = store.all();
  const reconstruction = await node.reconstructFacts(events);
  return {
    divergence: node.compareWithLog(reconstruction, events),
    decision: node.evaluateSlot(condition, headline, reconstruction),
  };
}

const HEADLINE = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "8000" } };

test("a fact that arrives late is scored where it happened, not where it landed", async () => {
  const s = session();
  // The provider has not indexed alice's earlier fill yet, so the first window
  // misses it. Bob's fill arrives, then the sweep backfills alice's.
  await s.post("alice", ALICE, [fill(2, 1100, "4000")], 1200);
  await s.post("bob", BOB, [fill(7, 1200, "8000")], 1200);
  await s.post("alice", ALICE, [fill(1, 1000, "5000")], 900_000);

  const gate = evaluateCondition(HEADLINE, s.store.all());
  const { decision, divergence } = await resolverVerdict(s, HEADLINE);

  assert.deepEqual(divergence, [], "every fact matches: this was never a data problem");
  assert.equal(
    gate.outcome,
    decision.outcome,
    `the gate closed the room on ${gate.outcome} while the resolvers attested ${decision.outcome}`
  );
  // Alice reached 9000 at t=1100, before bob reached 8000 at t=1200.
  assert.equal(gate.outcome, "alice");
});

test("a threshold is crossed at the moment it was crossed", async () => {
  const s = session();
  await s.post("alice", ALICE, [fill(5, 5_000, "100")], 5_100);
  // A backfilled earlier fill that, in real time, took alice over the line first.
  await s.post("alice", ALICE, [fill(4, 4_000, "900")], 900_000);

  const condition = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "1000" },
  };
  const gate = evaluateCondition(condition, s.store.all());
  const { decision } = await resolverVerdict(s, condition, HEADLINE);
  assert.equal(gate.status, "decided");
  assert.equal(gate.outcome, "yes");
  assert.equal(decision.outcome, "yes", "and the resolver agrees, since it always ordered by provider time");
});

test("ordering is by provider time, then trade id — never by arrival", async () => {
  const s = session();
  await s.post("bob", BOB, [fill(9, 3_000, "1")], 3_100);
  await s.post("alice", ALICE, [fill(3, 1_000, "1"), fill(8, 2_000, "1")], 900_000);

  const ordered = rectify(s.store.all()).filter((event) => event.kind === "trade_closed");
  assert.deepEqual(
    ordered.map((event) => event.facts.tid),
    [3, 8, 9],
    "the timeline is the provider's, not the log's"
  );
});

test("a correction still lands on the fact it corrects, wherever that fact sits in time", async () => {
  const s = session();
  await s.post("alice", ALICE, [fill(2, 2_000, "500")], 2_100);
  await s.post("alice", ALICE, [fill(1, 1_000, "100")], 900_000); // late arrival, earlier moment
  await s.post("alice", ALICE, [fill(1, 1_000, "4000")], 900_001); // and then a restatement of it

  assert.equal(foldMetrics(s.store.all()).get("alice").cumRealizedPnlUsd, "4500");
  const timeline = rectify(s.store.all()).filter((event) => event.kind === "trade_closed");
  assert.deepEqual(timeline.map((event) => event.facts.tid), [1, 2]);
  assert.equal(timeline[0].facts.realized_pnl_usd, "4000", "at its corrected value");
});

test("folding to a sequence still sees every fact that had arrived by then", async () => {
  // The fold takes an upper bound in log sequence — "what we knew by then". Once
  // the timeline is ordered by provider time, sequence numbers no longer ascend
  // through it, so a fold that stopped at the first out-of-order event would
  // silently drop the rest of the session.
  const s = session();
  await s.post("alice", ALICE, [fill(5, 5_000, "1")], 5_100);
  await s.post("alice", ALICE, [fill(1, 1_000, "10")], 900_000);
  await s.post("alice", ALICE, [fill(6, 6_000, "100")], 900_001);

  const events = s.store.all();
  const last = events.at(-1).seq;
  assert.equal(foldMetrics(events, last).get("alice").cumRealizedPnlUsd, "111", "every fact counts");
  const early = events.find((event) => event.facts?.tid === 5).seq;
  assert.equal(foldMetrics(events, early).get("alice").cumRealizedPnlUsd, "1", "and a bound still bounds");
});

// ---------------------------------------------------------------------------
// When did the session end?
//
// The resolver's answer is the terminal FILL: the moment the headline condition
// was met on the provider's timeline, after which nothing counts. The gate and
// the settlement replay used a log SEQUENCE instead — the room's closed
// watermark. Those coincide right up until they don't, and the case where they
// part is one this build creates deliberately: when a restatement decides the
// headline retroactively, the room must close at a sequence the chain will
// accept, which is past the true decisive one.
//
// The replay window then includes fills the resolver dropped, and the published
// settlement record states an outcome the market did not pay.

const LATE_SLOT = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "bob", metric: "realized_pnl_usd", operator: ">=", value: "100" },
};

test("the session ends at the terminal fill, not at the room's closing watermark", async () => {
  const s = session();
  await s.post("alice", ALICE, [fill(1, 1_000, "3000")], 1_050);
  await s.post("alice", ALICE, [fill(2, 1_100, "1000")], 1_150);
  await s.post("bob", BOB, [fill(9, 1_200, "100")], 1_250);
  // The gate cleared an epoch at the tip, so the room watermark is 3. Then a
  // sweep restates alice's first fill upward, deciding the headline at seq 2 —
  // behind the watermark, so the room closes at 4.
  await s.post("alice", ALICE, [fill(1, 1_000, "7000")], 900_000);

  const events = s.store.all();
  const headline = evaluateCondition(HEADLINE, events);
  assert.equal(headline.outcome, "alice");
  const closingSeq = Math.max(headline.seq, 3 + 1); // what _closingSequence sends the chain

  const replay = evaluateCondition(LATE_SLOT, events, {
    terminalSeq: closingSeq,
    headlineCondition: HEADLINE,
  });
  const { decision } = await resolverVerdict(s, LATE_SLOT, HEADLINE);

  assert.equal(
    replay.outcome,
    decision.outcome,
    `the settlement record says ${replay.outcome} while the market pays ${decision.outcome}`
  );
  // Bob's fill happened after alice's win. It does not count, on either side.
  assert.equal(decision.outcome, "no");
});

test("a slot decided before the terminal fill still stands", async () => {
  const s = session();
  await s.post("bob", BOB, [fill(9, 900, "100")], 950); // before alice's win
  await s.post("alice", ALICE, [fill(1, 1_000, "3000")], 1_050);
  await s.post("alice", ALICE, [fill(2, 1_100, "6000")], 1_150);

  const events = s.store.all();
  const replay = evaluateCondition(LATE_SLOT, events, {
    terminalSeq: events.at(-1).seq,
    headlineCondition: HEADLINE,
  });
  const { decision } = await resolverVerdict(s, LATE_SLOT, HEADLINE);
  assert.equal(replay.outcome, "yes");
  assert.equal(decision.outcome, "yes");
});
