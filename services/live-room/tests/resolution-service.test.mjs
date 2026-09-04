// The resolver's production loop.
//
// The Resolver Node knew how to rebuild one market's result from raw provider
// bytes and attest it. What it had no way to do was find out that a market
// needed resolving — that lived in the game-day script, so the operable
// resolver held a key, counted its own incidents, and resolved nothing.
//
// These pin the loop: discover closed markets from the chain, get the frozen
// condition document from the durable publication record, refuse to use it
// unless it hashes to the binding the chain actually holds, resolve, attest
// once, and record what it did.

import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { openDatabase, SqliteEventStore, SqliteRawArchive, SqliteResolutionLog } from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";
import { ResolutionService } from "../src/resolver/resolution.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../src/connector/hyperliquid.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";

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

function fill(tid, timeMs, closedPnl, fee = "0") {
  return { tid, time: timeMs, closedPnl, fee, coin: "ETH", side: "B", px: "1", sz: "1" };
}

/** A session whose raw bytes a resolver can rebuild the result from. */
async function seedSession(db) {
  const store = new SqliteEventStore(db);
  const rawArchive = new SqliteRawArchive(db);
  let tick = 0;
  const connector = new SourceConnector({
    roomId: "room-1",
    source: "hyperliquid-testnet",
    store,
    rawArchive,
    signer: privateKeyToAccount(generatePrivateKey()),
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

/**
 * A room with two published, closed markets and the durable publication
 * records the resolver reads its condition documents out of.
 */
async function publishedRoom(db, { headlineDoc = HEADLINE, thresholdDoc = THRESHOLD, recordDocs = true } = {}) {
  const chain = new FakeRoomChain();
  const queue = new SqlitePublicationQueue(db, "room-1");
  const markets = [];
  for (const [index, doc] of [headlineDoc, thresholdDoc].entries()) {
    const market = `0x${(index + 1).toString(16).padStart(40, "0")}`;
    chain.addSlot(market, index, conditionHash(doc));
    chain.slots[index].closed = true;
    markets.push(market);
    if (!recordDocs) continue;
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

test("the resolver finds a closed market and attests what the raw bytes say", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue, markets } = await publishedRoom(db);

  const result = await service(db, chain, queue, rawArchive).tick();

  assert.equal(result.attested.length, 2, JSON.stringify(result));
  const attestations = chain.calls.filter((call) => call[0] === "attestResult");
  assert.equal(attestations.length, 2, "both closed markets were attested on chain");
  assert.deepEqual(
    attestations.map((call) => call[1]).sort(),
    [...markets].sort()
  );
});

test("a condition document that does not hash to the chain's binding is refused", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);

  // Someone edited the stored document after publication. The chain still
  // holds the hash of what was actually published.
  const record = (await queue.published())[1];
  await queue._transition(record.id, "published", {
    conditionDocument: { ...THRESHOLD, params: { ...THRESHOLD.params, value: "99" } },
  });

  const result = await service(db, chain, queue, rawArchive).tick();

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestResult").length,
    1,
    "the tampered market is not attested; the intact one still is"
  );
  const refusal = result.refused.find((entry) => entry.market === record.market);
  assert.ok(refusal, "the refusal is reported, not swallowed");
  assert.match(refusal.reason, /condition hash/i);
});

test("a closed market with no publication record is an incident, not an attestation", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db, { recordDocs: false });

  const result = await service(db, chain, queue, rawArchive).tick();

  assert.equal(chain.calls.filter((call) => call[0] === "attestResult").length, 0);
  assert.equal(result.refused.length, 2);
  assert.match(result.refused[0].reason, /no condition document/i);
});

test("a market this resolver already attested is not attested again", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);
  const resolution = service(db, chain, queue, rawArchive);

  await resolution.tick();
  await resolution.tick();

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestResult").length,
    2,
    "the contract rejects a duplicate; a resolver that forgets pays gas to be told so"
  );
});

test("what the resolver did survives its own restart", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);

  const account = privateKeyToAccount(generatePrivateKey());
  const build = () =>
    new ResolutionService({
      resolver: new ResolverNode({
        name: "resolver:restart",
        rawArchive,
        participants: PARTICIPANTS,
        signerChain: chain,
      }),
      chain,
      queue,
      log: new SqliteResolutionLog(db, "room-1", account.address),
      eventLog: new SqliteEventStore(db),
      participants: PARTICIPANTS,
    });

  await build().tick();
  await build().tick(); // a fresh process, same durable log

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestResult").length,
    2,
    "a restarted resolver must not re-attest what it already attested"
  );
});

test("a market past its resolution deadline is recorded as missed rather than attempted", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);
  for (const slot of chain.slots) slot.resolutionDueAt = 1_000;

  const result = await service(db, chain, queue, rawArchive).tick({ nowMs: 5_000_000 });

  assert.equal(chain.calls.filter((call) => call[0] === "attestResult").length, 0);
  assert.equal(result.refused.length, 2);
  assert.match(result.refused[0].reason, /deadline|due/i);
});

test("an unusable headline document stops every resolution in the room", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);

  // The headline defines the session's terminal boundary: without it, no slot
  // can be evaluated, because "before the session ended" is undefined.
  const headline = (await queue.published())[0];
  await queue._transition(headline.id, "published", {
    conditionDocument: { ...HEADLINE, params: { target: "1" } },
  });

  const result = await service(db, chain, queue, rawArchive).tick();

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestResult").length,
    0,
    "a resolver that cannot trust the terminal condition must attest nothing"
  );
  assert.equal(result.refused.length, 2);
  assert.ok(result.refused.every((entry) => /headline|condition hash/i.test(entry.reason)), JSON.stringify(result.refused));
});

// ---------------------------------------------------------------- challenges
//
// `attestChallengeVerdict` has always existed on the market, and no service ever
// called it — the function was not even in the chain port's ABI. So a bonded
// audience challenge was adjudicated by nothing: the challenger posted a bond,
// the market paused, and the only outcome available was the timeout, which
// invalidates. A well-founded challenge and a frivolous one reached the same
// place by the same route, and the resolvers whose judgement is supposed to
// decide it were never asked.

test("a challenge contradicted by the resolver's own reconstruction is rejected", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue, markets } = await publishedRoom(db);

  const svc = service(db, chain, queue, rawArchive);
  const first = await svc.tick();
  const attested = first.attested[0];
  assert.ok(attested, "a market was attested to begin with");

  // The audience challenges the outcome this resolver itself derived.
  chain.challenge(attested.market, { provisionalOutcome: Number(attested.outcome) });

  const result = await svc.tick();

  const verdicts = chain.calls.filter((call) => call[0] === "attestChallengeVerdict");
  assert.equal(verdicts.length, 1, `expected one verdict, got ${JSON.stringify(result)}`);
  assert.equal(verdicts[0][1], attested.market);
  assert.equal(verdicts[0][2], false, "the raw bytes still say the provisional outcome, so the challenge fails");
});

test("a challenge the resolver's reconstruction supports is accepted, invalidating the market", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);

  const svc = service(db, chain, queue, rawArchive);
  const first = await svc.tick();
  const attested = first.attested[0];

  // The provisional result on chain is NOT what the raw bytes support. That is
  // exactly the case a challenge exists for, and the resolver must side with
  // the evidence rather than with the standing result.
  const wrong = Number(attested.outcome) === 1 ? 2 : 1;
  chain.challenge(attested.market, { provisionalOutcome: wrong });

  await svc.tick();

  const verdicts = chain.calls.filter((call) => call[0] === "attestChallengeVerdict");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0][2], true, "the reconstruction contradicts the provisional outcome, so the challenge stands");
});

test("a resolver that cannot reconstruct refuses to vote rather than rejecting the challenge", async (t) => {
  // Fail-closed. A resolver with no usable evidence has no opinion, and an
  // unanswered challenge times out to Invalid — which is the safe direction.
  // Voting "reject" because it could not check would let a market finalize on a
  // result nobody verified, using a resolver's silence as agreement.
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue, markets } = await publishedRoom(db, { recordDocs: false });

  chain.challenge(markets[0], { provisionalOutcome: 1 });
  const result = await service(db, chain, queue, rawArchive).tick();

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestChallengeVerdict").length,
    0,
    "no verdict is attested when the resolver cannot rebuild the result"
  );
  assert.ok(result.refused.length > 0, "and the refusal is visible");
});

test("a resolver does not vote twice on the same challenge", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const { rawArchive } = await seedSession(db);
  const { chain, queue } = await publishedRoom(db);

  const svc = service(db, chain, queue, rawArchive);
  const first = await svc.tick();
  const attested = first.attested[0];
  chain.challenge(attested.market, { provisionalOutcome: Number(attested.outcome) });

  await svc.tick();
  await svc.tick();

  assert.equal(
    chain.calls.filter((call) => call[0] === "attestChallengeVerdict").length,
    1,
    "quorum means two resolvers, not one resolver voting twice"
  );
});
