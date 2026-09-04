// Provider corrections.
//
// A provider can restate a fill it already reported — a corrected realized PnL
// after a fee settles, a reversed trade, an amended size. The connector
// deduplicates on `source_event_id`, which is exactly right for the retries and
// window overlaps that make a poll reconnect-safe, and exactly wrong for a
// restatement: the corrected figure was silently dropped and the log kept the
// stale one, while the raw bytes a resolver reconstructs from held the new one.
// That is the shape of a market settling one way and its own evidence saying
// another.
//
// A correction is an append, never a mutation: the chain is the point. The
// superseded event stays, the correction names what it corrects, and everything
// that folds the log counts the fact once, at its latest value.

import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

import { SourceConnector } from "../src/connector/connector.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { normalizeFillsResponse } from "../src/connector/hyperliquid.mjs";
import { foldMetrics, evaluateCondition } from "../src/domain/conditions.mjs";
import { verifyChain } from "../src/domain/eventlog.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";

const KEY = "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82";
const ALICE = "0x000000000000000000000000000000000000000a";
const BOB = "0x000000000000000000000000000000000000000b";

function connector() {
  const store = new MemoryEventStore();
  return {
    store,
    connector: new SourceConnector({
      roomId: "room-1",
      source: "hyperliquid-testnet",
      store,
      rawArchive: new MemoryRawArchive(),
      signer: privateKeyToAccount(KEY),
      clock: () => "2026-01-01T00:00:00.000Z",
    }),
  };
}

const fill = (tid, closedPnl, extra = {}) => ({
  tid,
  time: 1_000 + tid,
  closedPnl,
  fee: "0",
  coin: "ETH",
  side: "B",
  px: "1",
  sz: "1",
  ...extra,
});

async function ingest(source, fills, at) {
  return source.ingestBatch({
    rawBytes: JSON.stringify(fills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: ALICE, startTime: 0, endTime: at },
    drafts: normalizeFillsResponse("alice", ALICE, fills),
  });
}

test("an identical fill seen twice is ingested once", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);
  const again = await ingest(source, [fill(1, "100")], 4_000);

  assert.equal(again.length, 0, "a window overlap is not new information");
  assert.equal(store.all().filter((event) => event.kind === "trade_closed").length, 1);
});

test("a restated fill is appended as a correction, not dropped", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);

  // The provider restates the same trade id with a different realized figure.
  const corrected = await ingest(source, [fill(1, "80")], 4_000);
  assert.equal(corrected.length, 1, "a restatement is new information");

  const event = corrected[0];
  assert.equal(event.source_event_id, `${ALICE}:1`, "it is the same fact, restated");
  assert.equal(event.facts.closed_pnl_usd, "80");
  assert.ok(event.corrects, "and it names what it corrects");

  const trades = store.all().filter((entry) => entry.kind === "trade_closed");
  assert.equal(trades.length, 2, "the superseded event stays: the chain is append-only");
  assert.equal(trades[0].facts.closed_pnl_usd, "100");
  assert.equal(event.corrects, trades[0].hash, "by hash, so the link survives a replay");
});

test("a corrected fact is counted once, at its corrected value", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);
  await ingest(source, [fill(1, "80")], 4_000);
  await ingest(source, [fill(2, "5")], 6_000);

  // Accumulating both would read 185. Ignoring the correction would read 105.
  // The truth is 85: one trade restated to 80, plus one at 5.
  const state = foldMetrics(store.all());
  assert.equal(state.get("alice").cumRealizedPnlUsd, "85");
});

test("a correction can itself be corrected, and the last one wins", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);
  await ingest(source, [fill(1, "80")], 4_000);
  await ingest(source, [fill(1, "90")], 6_000);

  assert.equal(foldMetrics(store.all()).get("alice").cumRealizedPnlUsd, "90");
  assert.equal(store.all().filter((event) => event.kind === "trade_closed").length, 3);
});

test("a reversed fill corrects to zero rather than vanishing", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);
  await ingest(source, [fill(1, "0")], 4_000);

  assert.equal(foldMetrics(store.all()).get("alice").cumRealizedPnlUsd, "0");
  assert.equal(
    store.all().filter((event) => event.kind === "trade_closed").length,
    2,
    "the original is still in the record — a reversal is a fact, not an erasure"
  );
});

test("corrections leave the hash chain verifiable", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "100")], 2_000);
  await ingest(source, [fill(1, "80")], 4_000);
  await ingest(source, [fill(2, "5")], 6_000);

  const result = await verifyChain(store.all(), { verifySignature: async () => true });
  assert.deepEqual(result.failures, [], "a correction must not break the chain it extends");
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Corrections through the evaluator.
//
// Counting a correction once in `foldMetrics` is not enough: the evaluator that
// decides a market is a separate scan, and it accumulated every event it saw.
// A restatement therefore added to the total instead of replacing it, so the
// gate could close a room, and a threshold market could settle "yes", on a
// figure that is the sum of a fact and the provider's withdrawal of it.
//
// A correction restates something that already happened. It takes the place of
// the fact it supersedes, at the moment that fact occurred — which is exactly
// what a resolver reconstructing from raw bytes does, and the two must agree or
// the market pays one way while its own evidence says another.

test("the evaluator decides on the corrected total, not the sum of a fact and its correction", async () => {
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "4000")], 2_000);
  await ingest(source, [fill(2, "3000")], 4_000);
  await ingest(source, [fill(1, "1500")], 6_000); // restated, long after the fact

  const condition = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "6000" },
  };
  const events = store.all();
  const terminalSeq = events[events.length - 1].seq;

  assert.equal(foldMetrics(events).get("alice").cumRealizedPnlUsd, "4500");
  const decision = evaluateCondition(condition, events, { terminalSeq });
  assert.equal(decision.status, "decided");
  assert.equal(decision.outcome, "no", "6000 was never reached once the restatement is applied");
});

test("a correction cannot be outrun by the moment it corrects", async () => {
  // The threshold was crossed only on the stale figure. A scan that applies the
  // correction at the end — rather than in the place of the fact it restates —
  // would still decide "yes" at the crossing and never look back.
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "9000")], 2_000);
  await ingest(source, [fill(1, "10")], 4_000);

  const condition = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "5000" },
  };
  const events = store.all();
  const decision = evaluateCondition(condition, events, { seq: null, terminalSeq: events.at(-1).seq });
  assert.equal(decision.outcome, "no");
});

test("the gate's evaluator and a resolver's reconstruction agree on a corrected log", async () => {
  const store = new MemoryEventStore();
  const rawArchive = new MemoryRawArchive();
  const source = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: privateKeyToAccount(KEY),
    clock: () => "2026-01-01T00:00:00.000Z",
  });
  const participants = [
    { key: "alice", address: ALICE },
    { key: "bob", address: BOB },
  ];
  const post = async (key, address, fills) =>
    source.ingestBatch({
      rawBytes: JSON.stringify(fills),
      rawQuery: { endpoint: "info", type: "userFillsByTime", user: address, startTime: 0, endTime: 1 },
      drafts: normalizeFillsResponse(key, address, fills),
    });

  await post("alice", ALICE, [fill(1, "4000")]);
  await post("alice", ALICE, [fill(2, "3000")]);
  await post("alice", ALICE, [fill(1, "1500")]); // the restatement
  await post("bob", BOB, [{ ...fill(7, "9000"), time: 9_000 }]); // ends the session

  const headline = {
    condition_version: "1.0.0",
    template: "first_to_realized_pnl",
    params: { target: "8000" },
  };
  const threshold = {
    condition_version: "1.0.0",
    template: "participant_metric_threshold",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "6000" },
  };

  const events = store.all();
  const terminal = evaluateCondition(headline, events);
  assert.equal(terminal.status, "decided");
  assert.equal(terminal.outcome, "bob", "alice never reached 8000 once the restatement is applied");

  const gateDecision = evaluateCondition(threshold, events, { terminalSeq: terminal.seq });

  const node = new ResolverNode({ name: "r1", rawArchive, participants, signerChain: null });
  const reconstruction = await node.reconstructFacts(events);
  assert.deepEqual(node.compareWithLog(reconstruction, events), [], "raw bytes and log must agree fact by fact");
  const resolverDecision = node.evaluateSlot(threshold, headline, reconstruction);

  assert.equal(resolverDecision.status, "decided");
  assert.equal(gateDecision.outcome, resolverDecision.outcome, "the gate and the resolver must not disagree");
  assert.equal(gateDecision.outcome, "no");
});

test("a provider that changes its mind back is followed, not overruled by memory", async () => {
  // Content-keyed dedupe was permanent: a value the provider had ever reported
  // could never be reported again. That is right for a retry or a window
  // overlap — the same content in the same state is not news — and wrong the
  // moment a provider restates a fact BACK to an earlier figure, which a
  // lagging read replica does routinely.
  //
  // The cost is not a stale number. The connector drops the draft while the
  // payload still enters the raw archive, so the log says one thing and the
  // bytes a resolver rebuilds from say another. Every resolver then reports
  // divergence and refuses to attest — for every slot in the room, not just
  // this one — and every market finalizes Invalid, blaming the resolvers for a
  // read the connector swallowed.
  const { store, connector: source } = connector();
  await ingest(source, [fill(1, "9000")], 2_000);
  await ingest(source, [fill(1, "10")], 4_000);
  const back = await ingest(source, [fill(1, "9000"), fill(2, "50")], 6_000);

  assert.equal(back.length, 2, "the restatement back is news; so is the new fill");
  const restated = back.find((event) => event.source_event_id === `${ALICE}:1`);
  assert.ok(restated, "the provider said 9000 again, so the log has to say the provider said 9000 again");
  assert.ok(restated.corrects, "as a correction of what it last said");
  assert.equal(foldMetrics(store.all()).get("alice").cumRealizedPnlUsd, "9050");

  // A true repeat — the same value in the same state — is still not news.
  const repeat = await ingest(source, [fill(1, "9000"), fill(2, "50")], 8_000);
  assert.deepEqual(repeat, [], "a window overlap adds nothing");
});

test("the log and the raw bytes never disagree, so resolvers can attest", async () => {
  const { store, connector: source } = connector();
  const rawArchive = source.rawArchive;
  await ingest(source, [fill(1, "9000")], 2_000);
  await ingest(source, [fill(1, "10")], 4_000);
  await ingest(source, [fill(1, "9000"), fill(2, "50")], 6_000);

  const node = new ResolverNode({
    name: "r1",
    rawArchive,
    participants: [{ key: "alice", address: ALICE }],
    signerChain: null,
  });
  const reconstruction = await node.reconstructFacts(store.all());
  assert.deepEqual(
    node.compareWithLog(reconstruction, store.all()),
    [],
    "a resolver that diverges here refuses to attest for every market in the room"
  );
});
