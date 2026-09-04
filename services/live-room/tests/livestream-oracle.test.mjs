import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { encodeFunctionData, keccak256, parseAbi, toBytes } from "viem";
import { verifyChallengeTransaction } from "../src/app.mjs";

import { RoomApiServer } from "../src/api/server.mjs";
import {
  LivestreamOracle,
  buildLivestreamEvidenceBundle,
} from "../src/oracle/livestream-oracle.mjs";
import {
  openDatabase,
  SqliteOracleProofStore,
} from "../src/ports/sqlite-stores.mjs";

const MARKET = "0x1111111111111111111111111111111111111111";
const TOKEN = "operator-token-that-is-long-enough";
const CHALLENGE_TX = `0x${"b".repeat(64)}`;
const CHALLENGER = "0x2222222222222222222222222222222222222222";
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from("isomiso2"),
  Buffer.from("proof-frame"),
]);

const metadata = {
  market: MARKET,
  outcome: 1,
  sourceSequence: 42,
  streamUrl: "https://www.twitch.tv/example",
  occurredAt: "2026-08-22T20:15:04.000Z",
  clipStartMs: 12_000,
  clipEndMs: 32_000,
  rule: "the first guest is visibly present in the official stream before the second guest.",
  rationale: "the first guest enters frame at 00:20; the second guest has not appeared before that frame.",
  contentType: "video/mp4",
};

function fixture(maxBytes) {
  const directory = mkdtempSync(join(tmpdir(), "tm-livestream-oracle-"));
  const database = openDatabase(join(directory, "room.db"));
  const store = new SqliteOracleProofStore(database);
  const oracle = new LivestreamOracle({
    store,
    proofDir: join(directory, "oracle-proofs"),
    ...(maxBytes ? { maxBytes } : {}),
    clock: () => new Date("2026-08-22T20:16:00.000Z"),
  });
  return {
    directory,
    database,
    oracle,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the evidence hash is deterministic and commits to the rule, timing, outcome, and clip bytes", () => {
  const input = { ...metadata, clipSha256: `0x${"a".repeat(64)}` };
  const first = buildLivestreamEvidenceBundle(input);
  const second = buildLivestreamEvidenceBundle({ ...input });
  assert.equal(first.evidenceHash, second.evidenceHash);
  assert.match(first.evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(
    first.evidenceHash,
    buildLivestreamEvidenceBundle({ ...input, outcome: 2 }).evidenceHash,
    "changing the proposed winner must change the on-chain evidence hash"
  );
  assert.notEqual(
    first.evidenceHash,
    buildLivestreamEvidenceBundle({ ...input, rule: `${input.rule} Changed.` }).evidenceHash,
    "changing the published rule must change the on-chain evidence hash"
  );
  assert.notEqual(
    first.evidenceHash,
    buildLivestreamEvidenceBundle({ ...input, sourceSequence: 43 }).evidenceHash,
    "changing the gate's event sequence must change the on-chain evidence hash"
  );
});

test("a proof is durably archived and identical resubmission is idempotent", async () => {
  const context = fixture();
  try {
    const first = await context.oracle.record({ body: Readable.from([MP4]), metadata });
    const second = await context.oracle.record({ body: Readable.from([MP4]), metadata });

    assert.equal(second.id, first.id);
    assert.equal(second.evidence_hash, first.evidence_hash);
    assert.equal((await context.oracle.latestForMarket(MARKET)).id, first.id);
    assert.equal((await context.oracle.byEvidenceHash(first.evidence_hash)).id, first.id);
    const video = await context.oracle.video(first.id);
    assert.deepEqual(readFileSync(video.path), MP4);
    assert.equal(video.size, MP4.length);
    assert.equal(first.bundle.market, MARKET.toLowerCase());
    assert.equal(first.bundle.rule, metadata.rule);
    assert.match(first.bundle.recording_sha256, /^0x[0-9a-f]{64}$/);
  } finally {
    context.close();
  }
});

test("invalid, oversized, and ambiguous evidence is refused before publication", async () => {
  const context = fixture(24);
  try {
    await assert.rejects(
      context.oracle.record({ body: Readable.from([Buffer.from("not an mp4")]), metadata }),
      /MP4/i
    );
    await assert.rejects(
      context.oracle.record({ body: Readable.from([MP4]), metadata: { ...metadata, clipEndMs: 12_000 } }),
      /end.*after.*start/i
    );
    await assert.rejects(
      context.oracle.record({ body: Readable.from([MP4]), metadata: { ...metadata, rule: "" } }),
      /rule/i
    );
    await assert.rejects(
      context.oracle.record({ body: Readable.from([MP4, MP4]), metadata }),
      /exceeds/i
    );
    assert.equal(await context.oracle.latestForMarket(MARKET), null);
  } finally {
    context.close();
  }
});

async function apiFixture() {
  const context = fixture();
  const coordinator = {
    snapshot: () => ({ health: { source: "healthy", indexer: "healthy" }, seq: 0, source: { last_seq: 0 } }),
  };
  const server = new RoomApiServer({
    coordinator,
    edge: null,
    chat: null,
    playback: { health: "live" },
    store: { cursorBlock: 0 },
    eventLog: null,
    oracle: context.oracle,
    oracleToken: TOKEN,
    oracleChallengeVerifier: async ({ transactionHash }) => transactionHash === CHALLENGE_TX
      ? { verified: true, challenger: CHALLENGER }
      : { verified: false, reason: "transaction is not a confirmed challenge" },
  });
  const address = await server.listen(0);
  return { ...context, server, base: `http://127.0.0.1:${address.port}` };
}

function uploadUrl(base) {
  const query = new URLSearchParams({
    market: metadata.market,
    outcome: String(metadata.outcome),
    source_sequence: String(metadata.sourceSequence),
    stream_url: metadata.streamUrl,
    occurred_at: metadata.occurredAt,
    clip_start_ms: String(metadata.clipStartMs),
    clip_end_ms: String(metadata.clipEndMs),
    rule: metadata.rule,
    rationale: metadata.rationale,
  });
  return `${base}/v1/oracle/proofs?${query}`;
}

test("the oracle HTTP flow is token-protected for writes and public for evidence review", async () => {
  const context = await apiFixture();
  try {
    const refused = await fetch(uploadUrl(context.base), {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: MP4,
    });
    assert.equal(refused.status, 401);

    const uploaded = await fetch(uploadUrl(context.base), {
      method: "POST",
      headers: { "content-type": "video/mp4", "x-tm-oracle-token": TOKEN },
      body: MP4,
    });
    assert.equal(uploaded.status, 201);
    const proof = await uploaded.json();

    const byMarket = await fetch(`${context.base}/v1/oracle/markets/${MARKET}`);
    assert.equal(byMarket.status, 200);
    assert.equal((await byMarket.json()).evidence_hash, proof.evidence_hash);

    const byHash = await fetch(`${context.base}/v1/oracle/evidence/${proof.evidence_hash}`);
    assert.equal(byHash.status, 200);
    assert.equal((await byHash.json()).id, proof.id);

    const video = await fetch(`${context.base}${proof.video_url}`, {
      headers: { range: "bytes=4-11" },
    });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await video.arrayBuffer()), MP4.subarray(4, 12));
  } finally {
    await context.server.close();
    context.close();
  }
});

test("counter-evidence is registered only after a confirmed on-chain bonded challenge", async () => {
  const context = await apiFixture();
  try {
    const reference = "https://evidence.example/second-guest-appeared-earlier.json";
    const evidenceHash = keccak256(toBytes(reference));
    const body = {
      market: MARKET,
      evidence: reference,
      evidence_hash: evidenceHash,
      transaction_hash: CHALLENGE_TX,
    };

    const refused = await fetch(`${context.base}/v1/oracle/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, transaction_hash: `0x${"c".repeat(64)}` }),
    });
    assert.equal(refused.status, 400);

    const registered = await fetch(`${context.base}/v1/oracle/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(registered.status, 201);
    const challenge = await registered.json();
    assert.equal(challenge.evidence_hash, evidenceHash);
    assert.equal(challenge.challenger, CHALLENGER.toLowerCase());

    const publicRecord = await fetch(`${context.base}/v1/oracle/markets/${MARKET}/challenge`);
    assert.equal(publicRecord.status, 200);
    assert.equal((await publicRecord.json()).evidence, reference);
  } finally {
    await context.server.close();
    context.close();
  }
});

test("challenge transaction verification decodes the actual call, market, and evidence hash", async () => {
  const evidenceHash = `0x${"d".repeat(64)}`;
  const input = encodeFunctionData({
    abi: parseAbi(["function challengeResult(bytes32 evidenceHash,uint256 bond)"]),
    functionName: "challengeResult",
    args: [evidenceHash, 10_000_000n],
  });
  const client = {
    getTransaction: async () => ({ to: MARKET, from: CHALLENGER, input }),
    getTransactionReceipt: async () => ({ status: "success" }),
  };
  assert.deepEqual(
    await verifyChallengeTransaction(client, { market: MARKET, evidenceHash, transactionHash: CHALLENGE_TX }),
    { verified: true, challenger: CHALLENGER }
  );
  assert.equal(
    (await verifyChallengeTransaction(client, {
      market: MARKET,
      evidenceHash: `0x${"e".repeat(64)}`,
      transactionHash: CHALLENGE_TX,
    })).verified,
    false
  );
});

test("a market with no evidence yet answers 200 with nothing, not 404", async () => {
  // "What evidence does this market have?" is a valid question about a real
  // market, and "none yet" is a complete, true answer to it — not a missing
  // resource. Answering 404 made the browser log a console error on every poll
  // for the whole pre-resolution life of every market, which is the window that
  // matters most: in production a genuine oracle failure was indistinguishable
  // from a market simply not having been resolved yet.
  //
  // 404 stays for a request that names no market this build can parse — that
  // route pattern does not match at all, and falls through to the generic 404.
  const context = await apiFixture();
  try {
    const unknown = "0x2222222222222222222222222222222222222222";

    const proof = await fetch(`${context.base}/v1/oracle/markets/${unknown}`);
    assert.equal(proof.status, 200, "no evidence yet is a successful answer");
    assert.equal(await proof.json(), null, "and the answer is nothing");

    const challenge = await fetch(`${context.base}/v1/oracle/markets/${unknown}/challenge`);
    assert.equal(challenge.status, 200, "no registered challenge is a successful answer too");
    assert.equal(await challenge.json(), null);

    // A malformed address is still a 404: that is a request this build cannot
    // answer, rather than a market with nothing to report.
    const malformed = await fetch(`${context.base}/v1/oracle/markets/not-an-address`);
    assert.equal(malformed.status, 404);
  } finally {
    context.server.close();
    context.close();
  }
});
