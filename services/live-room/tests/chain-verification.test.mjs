// Issue 48: verify the hash chain before resolving on it.
//
// `verifyChain` has been fully implemented since the event log existed — gaps,
// prev_hash linkage, hash recomputation, signature recovery — and had NO
// production caller. The resolver read `eventLog.all()` bare and attested from
// whatever came back.
//
// That matters because every operator role opens the same SQLite file, so
// anyone who can write it can insert an event with a self-consistent raw_hash
// and both resolvers will agree — they are reading the same tampered bytes.
// Agreement between two readers of one corrupted source is not independence,
// and it is exactly the threat ADR 0024 claims independent reconstruction
// detects.
//
// The mechanism existed. Nothing ran it. These tests run it.

import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { openDatabase, SqliteEventStore, SqliteRawArchive, SqliteResolutionLog } from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";
import { ResolutionService } from "../src/resolver/resolution.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";
import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";
import { verifyChain, ChainVerifier } from "../src/domain/eventlog.mjs";

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

const fill = (tid, timeMs, closedPnl) => ({
  tid, time: timeMs, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1",
});

/** A signed session, and the connector key that signed it. */
async function seedSession(db) {
  const key = generatePrivateKey();
  const signer = privateKeyToAccount(key);
  const store = new SqliteEventStore(db);
  const rawArchive = new SqliteRawArchive(db);
  let tick = 0;
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer,
    clock: () => new Date(1_700_000_000_000 + ++tick * 1000).toISOString(),
  });
  for (const participant of PARTICIPANTS) {
    const state = { marginSummary: { accountValue: "10000" } };
    await connector.ingestBatch({
      rawBytes: JSON.stringify(state),
      rawQuery: { endpoint: "info", type: "clearinghouseState", user: participant.address, at: 1000 },
      drafts: [normalizeBaseline(participant.key, participant.address, state, 1000)],
    });
  }
  const aliceFills = [fill(21, 5000, "600"), fill(22, 7000, "400")];
  await connector.ingestBatch({
    rawBytes: JSON.stringify(aliceFills),
    rawQuery: { endpoint: "info", type: "userFillsByTime", user: PARTICIPANTS[0].address, startTime: 0, endTime: 8000 },
    drafts: normalizeFillsResponse("alice", PARTICIPANTS[0].address, aliceFills),
  });
  return { store, rawArchive, signerAddress: signer.address };
}

async function publishedRoom(db) {
  const chain = new FakeRoomChain();
  const queue = new SqlitePublicationQueue(db, "room-1");
  const markets = [];
  for (const [index, doc] of [HEADLINE, THRESHOLD].entries()) {
    const market = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    chain.addSlot(market, index, conditionHash(doc));
    chain.slots[index].closed = true;
    markets.push(market);
    const { id } = await queue.submit({ slotIndex: index, templateId: "tpl", params: {} });
    await queue.markAwaitingPermit(id, { request: {}, restricted: [], conditionDocument: doc });
    await queue.markPermitted(id, {
      permit: { conditionHash: conditionHash(doc), nonce: BigInt(index + 1) },
      signature: "0x00",
      request: {},
    });
    await queue.markPublished(id, { market });
  }
  return { chain, queue, markets };
}

function service(db, chain, queue, rawArchive, overrides = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  return new ResolutionService({
    resolver: new ResolverNode({
      name: `resolver:${account.address.slice(0, 10)}`,
      rawArchive,
      participants: PARTICIPANTS,
      signerChain: chain,
    }),
    chain,
    queue,
    log: new SqliteResolutionLog(db, "room-1", account.address),
    eventLog: new SqliteEventStore(db),
    participants: PARTICIPANTS,
    ...overrides,
  });
}

// ------------------------------------------------- the incremental verifier

test("a verified prefix is not re-verified, so the cost stays linear over a session", async () => {
  const db = openDatabase(":memory:");
  try {
    const { store, signerAddress } = await seedSession(db);
    let recoveries = 0;
    const verifySignature = (event) => {
      recoveries += 1;
      return makeSignatureVerifier(signerAddress)(event);
    };

    const verifier = new ChainVerifier({ verifySignature });
    const events = await store.all();
    const first = await verifier.verify(events);
    assert.equal(first.ok, true, JSON.stringify(first.failures));
    const afterFirst = recoveries;
    assert.ok(afterFirst > 0, "the first pass actually verified signatures");

    // Same log, nothing appended.
    const second = await verifier.verify(await store.all());
    assert.equal(second.ok, true);
    assert.equal(recoveries, afterFirst, "a second pass over an unchanged log verifies nothing again");
  } finally {
    db.close();
  }
});

test("history rewritten below the watermark is caught, not skipped past", async () => {
  // The dangerous failure mode for an incremental verifier: trusting the
  // cached tip. If the prefix is rewritten underneath the process, resuming
  // from the watermark would verify only the untouched suffix and report ok.
  const db = openDatabase(":memory:");
  try {
    const { store, signerAddress } = await seedSession(db);
    const verifier = new ChainVerifier({ verifySignature: makeSignatureVerifier(signerAddress) });
    assert.equal((await verifier.verify(await store.all())).ok, true);

    // Rewrite an already-verified event in place.
    const events = await store.all();
    const tampered = events.map((event, index) =>
      index === 0 ? { ...event, facts: { ...event.facts, account_value_usd: "999999" } } : event
    );

    const result = await verifier.verify(tampered);
    assert.equal(result.ok, false, "a rewritten prefix must fail rather than be assumed still good");
  } finally {
    db.close();
  }
});

test("verifyChain can start from a known-good point", async () => {
  const db = openDatabase(":memory:");
  try {
    const { store, signerAddress } = await seedSession(db);
    const events = await store.all();
    const cut = 2;
    const from = { seq: events[cut - 1].seq, hash: events[cut - 1].hash };

    const suffix = await verifyChain(events.slice(cut), {
      verifySignature: makeSignatureVerifier(signerAddress),
      from,
    });
    assert.equal(suffix.ok, true, JSON.stringify(suffix.failures));

    // And a suffix that does NOT link to the stated point is refused.
    const wrong = await verifyChain(events.slice(cut), {
      from: { seq: events[cut - 1].seq, hash: "0x" + "ab".repeat(32) },
    });
    assert.equal(wrong.ok, false, "a suffix must link to the point it claims to continue from");
  } finally {
    db.close();
  }
});

// ------------------------------------------------------- the resolver path

test("a tampered event makes the resolver refuse rather than attest", async () => {
  const db = openDatabase(":memory:");
  try {
    const { rawArchive, signerAddress } = await seedSession(db);
    const { chain, queue } = await publishedRoom(db);

    // Tamper AFTER the connector wrote it: rewrite the stored body so its
    // recomputed hash no longer matches. This is exactly what a writer with
    // access to the shared database file can do.
    db.prepare("update session_event set body = replace(body, '\"600\"', '\"60000\"') where seq = 3").run();

    const result = await service(db, chain, queue, rawArchive, {
      verifySignature: makeSignatureVerifier(signerAddress),
    }).tick();

    assert.equal(result.attested.length, 0, "nothing may be attested on a log that does not verify");
    assert.ok(result.refused.length > 0, "and the refusal is reported, not silent");
    assert.match(
      result.refused.map((entry) => entry.reason).join(" "),
      /chain|verif|tamper/i,
      `the reason must name the real cause: ${JSON.stringify(result.refused)}`
    );
  } finally {
    db.close();
  }
});

test("an event signed by the wrong key is refused", async () => {
  const db = openDatabase(":memory:");
  try {
    const { rawArchive } = await seedSession(db);
    const { chain, queue } = await publishedRoom(db);

    // A different connector address than the one that actually signed.
    const impostor = privateKeyToAccount(generatePrivateKey()).address;
    const result = await service(db, chain, queue, rawArchive, {
      verifySignature: makeSignatureVerifier(impostor),
    }).tick();

    assert.equal(result.attested.length, 0, "a log signed by an unexpected key is not evidence");
    assert.ok(result.refused.length > 0);
  } finally {
    db.close();
  }
});

test("a clean, correctly signed log still resolves normally", async () => {
  // The guard must not break the working path — a verifier that refuses
  // everything is not safer, it is just broken.
  const db = openDatabase(":memory:");
  try {
    const { rawArchive, signerAddress } = await seedSession(db);
    const { chain, queue } = await publishedRoom(db);

    const result = await service(db, chain, queue, rawArchive, {
      verifySignature: makeSignatureVerifier(signerAddress),
    }).tick();

    assert.ok(result.attested.length > 0, `expected attestations, got ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
});

test("without a verifier configured the resolver still checks structure", async () => {
  // No signature verifier means signatures cannot be checked — but gaps,
  // broken links and hash mismatches need no key at all, and refusing to
  // check them because one thing is unavailable would be the wrong trade.
  const db = openDatabase(":memory:");
  try {
    const { rawArchive } = await seedSession(db);
    const { chain, queue } = await publishedRoom(db);
    db.prepare("update session_event set body = replace(body, '\"600\"', '\"60000\"') where seq = 3").run();

    const result = await service(db, chain, queue, rawArchive).tick();
    assert.equal(result.attested.length, 0, "a hash mismatch is detectable without any key");
  } finally {
    db.close();
  }
});
