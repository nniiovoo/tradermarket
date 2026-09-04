// Evidence archive for human-reviewed livestream event questions.
//
// This service never chooses a result and holds no chain key. It turns one
// exact clip plus its immutable rule and timing metadata into a canonical
// evidence bundle. Two independent resolver wallets still have to inspect the
// bundle and attest its hash to the market contract; an audience member may
// then challenge that provisional result on chain.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, keccak256, toBytes } from "viem";

export const MAX_PROOF_BYTES = 250 * 1024 * 1024;
export const MAX_CLIP_DURATION_MS = 120_000;

function inputError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw inputError(`${label} is required`);
  if (text.length > maxLength) throw inputError(`${label} exceeds ${maxLength} characters`);
  return text;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw inputError(`${label} must be an integer`);
  return number;
}

/**
 * Builds the exact JSON whose keccak256 is attested on chain.
 *
 * Object insertion order is deliberate and versioned. Do not alphabetize or
 * add presentation fields: changing one committed fact must change the hash,
 * while changing a database id or API URL must not.
 */
export function buildLivestreamEvidenceBundle(input) {
  const market = String(input.market ?? "").toLowerCase();
  if (!isAddress(market)) throw inputError("market must be a valid contract address");

  const outcome = integer(input.outcome, "outcome");
  if (![1, 2, 3, 4].includes(outcome)) {
    throw inputError("outcome must be Participant A (1), Participant B (2), Tie (3), or Invalid (4)");
  }

  const sourceSequence = integer(input.sourceSequence, "source sequence");
  if (sourceSequence <= 0) throw inputError("source sequence must be positive");

  const streamUrl = requiredText(input.streamUrl, "stream URL", 2048);
  let parsedStream;
  try {
    parsedStream = new URL(streamUrl);
  } catch {
    throw inputError("stream URL must be an absolute HTTPS URL");
  }
  if (parsedStream.protocol !== "https:") throw inputError("stream URL must use HTTPS");

  const occurred = new Date(requiredText(input.occurredAt, "occurrence time", 80));
  if (!Number.isFinite(occurred.getTime())) throw inputError("occurrence time must be a valid ISO timestamp");

  const clipStartMs = integer(input.clipStartMs, "clip start");
  const clipEndMs = integer(input.clipEndMs, "clip end");
  if (clipStartMs < 0) throw inputError("clip start cannot be negative");
  if (clipEndMs <= clipStartMs) throw inputError("clip end must be after clip start");
  if (clipEndMs - clipStartMs > MAX_CLIP_DURATION_MS) {
    throw inputError(`clip duration exceeds ${MAX_CLIP_DURATION_MS / 1000} seconds`);
  }

  const clipSha256 = String(input.clipSha256 ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(clipSha256)) throw inputError("clip SHA-256 is invalid");

  const bundle = {
    schema: "tradermarket.livestream-evidence.v1",
    market,
    outcome,
    source_sequence: sourceSequence,
    stream_url: parsedStream.toString(),
    occurred_at: occurred.toISOString(),
    clip_start_ms: clipStartMs,
    clip_end_ms: clipEndMs,
    rule: requiredText(input.rule, "rule", 2000),
    rationale: requiredText(input.rationale, "rationale", 4000),
    recording_sha256: clipSha256,
  };
  const canonicalJson = JSON.stringify(bundle);
  return { bundle, canonicalJson, evidenceHash: keccak256(toBytes(canonicalJson)) };
}

export class LivestreamOracle {
  constructor({ store, proofDir, maxBytes = MAX_PROOF_BYTES, clock = () => new Date() }) {
    if (!store) throw new Error("livestream oracle needs a durable proof store");
    if (!proofDir) throw new Error("livestream oracle needs a proof directory");
    this.store = store;
    this.proofDir = proofDir;
    this.maxBytes = maxBytes;
    this.clock = clock;
  }

  async record({ body, metadata }) {
    if (!body || typeof body[Symbol.asyncIterator] !== "function") {
      throw inputError("an MP4 request body is required");
    }
    if (String(metadata?.contentType ?? "").split(";", 1)[0].trim().toLowerCase() !== "video/mp4") {
      throw inputError("evidence recording must be video/mp4", 415);
    }

    // Validate every field that does not depend on the bytes before accepting a
    // potentially large upload. A placeholder hash is replaced after streaming.
    buildLivestreamEvidenceBundle({ ...metadata, clipSha256: `0x${"0".repeat(64)}` });

    await mkdir(this.proofDir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const temporaryPath = join(this.proofDir, `.${id}.upload`);
    const finalPath = join(this.proofDir, `${id}.mp4`);
    const file = await open(temporaryPath, "wx", 0o600);
    const digest = createHash("sha256");
    let size = 0;
    let prefix = Buffer.alloc(0);

    try {
      for await (const value of body) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > this.maxBytes) throw inputError(`evidence recording exceeds ${this.maxBytes} bytes`, 413);
        if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk]).subarray(0, 16);
        digest.update(chunk);
        await file.write(chunk);
      }
      await file.sync();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    await file.close();

    if (size < 12 || prefix.subarray(4, 8).toString("ascii") !== "ftyp") {
      await unlink(temporaryPath).catch(() => {});
      throw inputError("evidence recording is not a recognizable MP4 file", 415);
    }

    const clipSha256 = `0x${digest.digest("hex")}`;
    const { bundle, canonicalJson, evidenceHash } = buildLivestreamEvidenceBundle({
      ...metadata,
      clipSha256,
    });
    const existing = await this.store.byEvidenceHash(evidenceHash);
    if (existing) {
      await unlink(temporaryPath).catch(() => {});
      return this._public(existing);
    }

    const createdAt = this.clock().toISOString();
    await rename(temporaryPath, finalPath);
    let stored;
    try {
      stored = await this.store.put({
        id,
        market: bundle.market,
        outcome: bundle.outcome,
        stream_url: bundle.stream_url,
        occurred_at: bundle.occurred_at,
        clip_start_ms: bundle.clip_start_ms,
        clip_end_ms: bundle.clip_end_ms,
        rule: bundle.rule,
        rationale: bundle.rationale,
        clip_sha256: bundle.recording_sha256,
        evidence_hash: evidenceHash,
        canonical_json: canonicalJson,
        // Relative to proofDir so a backup can be restored under another
        // TM_DATA_DIR without retaining an absolute path to the old host.
        video_path: `${id}.mp4`,
        byte_length: size,
        mime_type: "video/mp4",
        created_at: createdAt,
      });
    } catch (error) {
      await unlink(finalPath).catch(() => {});
      throw error;
    }
    return this._public(stored);
  }

  async latestForMarket(market) {
    if (!isAddress(String(market ?? ""))) return null;
    return this._public(await this.store.latestForMarket(market));
  }

  async byEvidenceHash(evidenceHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(evidenceHash ?? ""))) return null;
    return this._public(await this.store.byEvidenceHash(evidenceHash));
  }

  async registerChallenge({ market, evidence, evidenceHash, transactionHash, challenger }) {
    const normalizedMarket = String(market ?? "").toLowerCase();
    if (!isAddress(normalizedMarket)) throw inputError("challenge market must be a valid contract address");
    const reference = requiredText(evidence, "challenge evidence", 4096);
    const normalizedHash = String(evidenceHash ?? "").toLowerCase();
    const expectedHash = /^0x[0-9a-fA-F]{64}$/.test(reference)
      ? reference.toLowerCase()
      : keccak256(toBytes(reference));
    if (normalizedHash !== expectedHash) throw inputError("challenge evidence does not match its on-chain hash");
    const normalizedTransaction = String(transactionHash ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalizedTransaction)) throw inputError("challenge transaction hash is invalid");
    const normalizedChallenger = String(challenger ?? "").toLowerCase();
    if (!isAddress(normalizedChallenger)) throw inputError("verified challenger address is invalid");

    const existing = await this.store.challengeByEvidenceHash(normalizedHash);
    if (existing) {
      if (
        existing.market !== normalizedMarket
        || existing.evidence !== reference
        || existing.transaction_hash !== normalizedTransaction
      ) {
        throw inputError("this challenge evidence hash is already registered to another record", 409);
      }
      return this._publicChallenge(existing);
    }
    return this._publicChallenge(await this.store.putChallenge({
      evidence_hash: normalizedHash,
      market: normalizedMarket,
      evidence: reference,
      transaction_hash: normalizedTransaction,
      challenger: normalizedChallenger,
      created_at: this.clock().toISOString(),
    }));
  }

  async challengeForMarket(market) {
    if (!isAddress(String(market ?? ""))) return null;
    return this._publicChallenge(await this.store.latestChallengeForMarket(market));
  }

  async video(id) {
    const row = await this.store.byId(id);
    return row
      ? {
          path: join(this.proofDir, row.video_path),
          size: row.byte_length,
          mimeType: row.mime_type,
          etag: row.evidence_hash,
        }
      : null;
  }

  _public(row) {
    if (!row) return null;
    return {
      id: row.id,
      market: row.market,
      outcome: row.outcome,
      evidence_hash: row.evidence_hash,
      recording_sha256: row.clip_sha256,
      byte_length: row.byte_length,
      mime_type: row.mime_type,
      created_at: row.created_at,
      bundle: JSON.parse(row.canonical_json),
      video_url: `/v1/oracle/proofs/${encodeURIComponent(row.id)}/video`,
    };
  }

  _publicChallenge(row) {
    if (!row) return null;
    return {
      market: row.market,
      evidence: row.evidence,
      evidence_hash: row.evidence_hash,
      transaction_hash: row.transaction_hash,
      challenger: row.challenger,
      created_at: row.created_at,
    };
  }
}
