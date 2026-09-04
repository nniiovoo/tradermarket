// Issue 04: Session Event Log — append-only, gap-free, hash-chained, signed,
// deduplicated, replayable; raw bytes archived with closed query windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildEvent, verifyChain, eventHash, GENESIS_HASH, canonicalize } from "../src/domain/eventlog.mjs";
import { MemoryEventStore, MemoryRawArchive, FileEventStore, FileRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { normalizeFill, normalizeFillsResponse, ReplaySource } from "../src/connector/hyperliquid.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const connectorKey = generatePrivateKey();
const connectorAccount = privateKeyToAccount(connectorKey);

function makeConnector(store = new MemoryEventStore(), rawArchive = new MemoryRawArchive()) {
  let tick = 0;
  return new SourceConnector({
    roomId: "room-test",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: connectorAccount,
    clock: () => new Date(1700000000000 + ++tick * 1000).toISOString(),
  });
}

function fill(tid, time, closedPnl, fee = "0.1") {
  return { tid, time, closedPnl, fee, coin: "ETH", side: "B", px: "3000", sz: "1", oid: tid * 10, hash: `0xf${tid}` };
}

function fillsBatch(drafts, windowStart = 0, windowEnd = 9999999999999) {
  return {
    rawBytes: JSON.stringify(drafts),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: "0xabc", startTime: windowStart, endTime: windowEnd },
    drafts,
  };
}

test("canonicalize is stable across key order and bans floats", () => {
  assert.equal(canonicalize({ b: 1, a: "x" }), canonicalize({ a: "x", b: 1 }));
  assert.throws(() => canonicalize({ a: 1.5 }), /decimal strings/);
});

test("chain builds gap-free with linked hashes from genesis", async () => {
  const connector = makeConnector();
  const drafts = normalizeFillsResponse("alice", "0xABC", [fill(1, 1000, "10.5"), fill(2, 2000, "-3.25")]);
  const events = await connector.ingestBatch(fillsBatch(drafts));
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].prev_hash, GENESIS_HASH);
  assert.equal(events[1].seq, 2);
  assert.equal(events[1].prev_hash, events[0].hash);
  assert.equal(events[0].facts.realized_pnl_usd, "10.4"); // closedPnl - fee
});

test("replaying an archived log reproduces byte-identical sequences and hashes", async () => {
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  const drafts = normalizeFillsResponse("alice", "0xABC", [fill(1, 1000, "5"), fill(2, 2000, "7")]);
  await connector.ingestBatch(fillsBatch(drafts));
  await connector.heartbeat("2024-01-01T00:00:10.000Z");

  const replayed = store.all();
  const verdict = await verifyChain(replayed, { verifySignature: makeSignatureVerifier(connectorAccount.address) });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  for (const event of replayed) {
    assert.equal(event.hash, eventHash(event), "hash recomputes identically");
  }
});

test("duplicate and out-of-order provider payloads cannot create a gap or rewind", async () => {
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  // Same fills delivered twice, second time out of order and with an extra new one.
  await connector.ingestBatch(fillsBatch(normalizeFillsResponse("alice", "0xABC", [fill(1, 1000, "5"), fill(2, 2000, "7")])));
  const second = await connector.ingestBatch(
    fillsBatch(normalizeFillsResponse("alice", "0xABC", [fill(2, 2000, "7"), fill(3, 3000, "1"), fill(1, 1000, "5")]))
  );
  assert.equal(second.length, 1, "only the unseen fill appends");
  assert.equal(second[0].facts.tid, 3);
  const seqs = store.all().map((event) => event.seq);
  assert.deepEqual(seqs, [1, 2, 3], "gap-free ascending despite duplicates and reordering");
});

test("a tampered event is detected by chain verification", async () => {
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  await connector.ingestBatch(fillsBatch(normalizeFillsResponse("alice", "0xABC", [fill(1, 1000, "5"), fill(2, 2000, "7")])));
  const tampered = store.all();
  tampered[0] = { ...tampered[0], facts: { ...tampered[0].facts, realized_pnl_usd: "9999" } };
  const verdict = await verifyChain(tampered, { verifySignature: makeSignatureVerifier(connectorAccount.address) });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((failure) => failure.reason === "hash mismatch"));
});

test("an open-ended raw query is refused", async () => {
  const connector = makeConnector();
  await assert.rejects(
    connector.ingestBatch({
      rawBytes: "[]",
      rawQuery: { endpoint: "info", open_ended: true },
      drafts: [],
    }),
    /closed window/
  );
});

test("file-backed store and raw archive survive a restart with identical state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eventlog-"));
  const store = new FileEventStore(join(dir, "log.jsonl"));
  const rawArchive = new FileRawArchive(join(dir, "raw"));
  const connector = new SourceConnector({
    roomId: "room-test",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: connectorAccount,
    clock: () => "2024-01-01T00:00:00.000Z",
  });
  const drafts = normalizeFillsResponse("alice", "0xABC", [fill(1, 1000, "5")]);
  const [event] = await connector.ingestBatch(fillsBatch(drafts));

  const reopened = new FileEventStore(join(dir, "log.jsonl"));
  assert.deepEqual(reopened.all(), store.all());
  const rawBytes = new FileRawArchive(join(dir, "raw")).get(event.raw_ref);
  assert.equal(rawBytes, JSON.stringify(drafts), "original bytes archived verbatim");

  // Restarted connector keeps deduplicating across the restart boundary.
  const resumed = new SourceConnector({
    roomId: "room-test",
    source: "hyperliquid-testnet",
    store: reopened,
    rawArchive,
    signer: connectorAccount,
    clock: () => "2024-01-01T00:00:01.000Z",
  });
  const again = await resumed.ingestBatch(fillsBatch(drafts));
  assert.equal(again.length, 0, "no duplicate after restart");
});

test("fact-level re-verification: same window, different pagination and order, same facts", () => {
  const fills = [fill(2, 2000, "7"), fill(1, 1000, "5"), fill(3, 3000, "-1")];
  const reordered = [fill(3, 3000, "-1"), fill(1, 1000, "5"), fill(2, 2000, "7")];
  const a = normalizeFillsResponse("alice", "0xABC", fills);
  const b = normalizeFillsResponse("alice", "0xAbC", reordered); // case-different address too
  assert.deepEqual(
    a.map((draft) => [draft.source_event_id, draft.facts.realized_pnl_usd]),
    b.map((draft) => [draft.source_event_id, draft.facts.realized_pnl_usd]),
    "immutable fill identifiers and normalized facts match regardless of response envelope"
  );
});

test("replay source drives a scripted session deterministically", async () => {
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  const source = new ReplaySource({
    connector,
    batches: [
      { at_ms: 1000, address: "0xA", participant: "alice", kind: "baseline", payload: { marginSummary: { accountValue: "10000" } } },
      { at_ms: 2000, address: "0xB", participant: "bob", kind: "baseline", payload: { marginSummary: { accountValue: "10000" } } },
      { at_ms: 5000, address: "0xA", participant: "alice", kind: "fills", payload: [fill(1, 4000, "120.5")] },
      { at_ms: 9000, address: "0xB", participant: "bob", kind: "fills", payload: [fill(2, 8000, "-40")] },
    ],
  });
  await source.advanceTo(4000);
  assert.equal(store.count(), 2, "only due batches ingest");
  await source.advanceTo(10000);
  assert.equal(store.count(), 4);
  assert.equal(source.done, true);
  const verdict = await verifyChain(store.all(), { verifySignature: makeSignatureVerifier(connectorAccount.address) });
  assert.equal(verdict.ok, true);
});

test("heartbeats advance freshness without fabricating facts", async () => {
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  await connector.heartbeat("2024-01-01T00:00:00.000Z");
  const [beat] = store.all();
  assert.equal(beat.kind, "heartbeat");
  assert.equal(beat.participant, null);
  assert.deepEqual(beat.facts, {});
});

test("byte-identical responses from different queries get distinct raw refs", async () => {
  // Two participants can legitimately return identical payloads (equal
  // baselines). A content-only archive id would collide and silently drop the
  // second account's fact.
  const store = new MemoryEventStore();
  const connector = makeConnector(store);
  const identical = JSON.stringify({ marginSummary: { accountValue: "10000" } });
  for (const address of ["0xAAA", "0xBBB"]) {
    await connector.ingestBatch({
      rawBytes: identical,
      rawQuery: { endpoint: "info", type: "clearinghouseState", user: address, at: 1000 },
      drafts: [
        {
          source_event_id: `baseline:${address.toLowerCase()}`,
          participant: address === "0xAAA" ? "alice" : "bob",
          observed_at: "2024-01-01T00:00:00.000Z",
          kind: "baseline",
          facts: { account_value_usd: "10000" },
        },
      ],
    });
  }
  const events = store.all();
  assert.equal(events.length, 2, "both baselines recorded");
  assert.notEqual(events[0].raw_ref, events[1].raw_ref, "distinct refs for distinct queries");
  assert.equal(events[0].raw_hash, events[1].raw_hash, "identical content still hashes identically");
});
