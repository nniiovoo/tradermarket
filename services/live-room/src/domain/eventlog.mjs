// Session Event Log domain rules: append-only, gap-free, hash-chained, signed.
// Pure logic — storage and signing are injected. The log is the single ordering
// authority for every Competition Market in a Live Room and the only permitted
// input to condition evaluation.

import { keccak256, toHex } from "viem";

export const GENESIS_HASH = "0x" + "00".repeat(32);

/** Canonical serialization: stable key order, no floats, decimals as strings. */
export function canonicalize(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("non-integer numbers are banned from the event log; use decimal strings");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  throw new Error(`unserializable value of type ${typeof value}`);
}

/** The event fields covered by the chain hash, in canonical form. */
export function eventHash(event) {
  const covered = {
    room_id: event.room_id,
    seq: event.seq,
    source: event.source,
    source_event_id: event.source_event_id,
    participant: event.participant,
    observed_at: event.observed_at,
    ingested_at: event.ingested_at,
    kind: event.kind,
    facts: event.facts,
    derived: event.derived,
    raw_ref: event.raw_ref,
    raw_hash: event.raw_hash,
    raw_query: event.raw_query,
    // Covered by the hash: a correction that could be re-pointed at a different
    // superseded event without breaking the chain would not be evidence of
    // anything.
    corrects: event.corrects ?? null,
    prev_hash: event.prev_hash,
  };
  return keccak256(toHex(canonicalize(covered)));
}

/**
 * Builds the next chained event. Throws unless it extends the tip exactly:
 * seq must be tip.seq + 1 (gap-free, no rewind) and prev_hash must match.
 */
export function buildEvent({ tip, draft, ingestedAt }) {
  const seq = tip ? tip.seq + 1 : 1;
  const prevHash = tip ? tip.hash : GENESIS_HASH;
  const event = {
    room_id: draft.room_id,
    seq,
    source: draft.source,
    source_event_id: draft.source_event_id,
    participant: draft.participant ?? null,
    observed_at: draft.observed_at,
    ingested_at: ingestedAt,
    kind: draft.kind,
    facts: draft.facts ?? {},
    derived: draft.derived ?? {},
    raw_ref: draft.raw_ref,
    raw_hash: draft.raw_hash,
    raw_query: draft.raw_query,
    // Set when this event restates a fact the log already carries: the hash of
    // the event it supersedes. A correction is an append, never a mutation —
    // the chain is the point — so the superseded event stays and this names it.
    corrects: draft.corrects ?? null,
    prev_hash: prevHash,
  };
  event.hash = eventHash(event);
  return event;
}

/**
 * Verifies a full log replay: gap-free ascending seq, hash chain integrity,
 * recomputed hashes, and (via injected verifier) signatures.
 * Returns { ok, failures: [{seq, reason}] }.
 */
export async function verifyChain(events, { verifySignature, from = null, signaturesAfterSeq = null } = {}) {
  const failures = [];
  // Two independent knobs, because the two checks cost wildly different things.
  //
  // `from` verifies only a suffix, seeded at a known-good point — the suffix
  // must still LINK to it, or a caller could skip past rewritten history.
  //
  // `signaturesAfterSeq` keeps the CHEAP checks (recompute the hash, follow the
  // links) running over every event while skipping the EXPENSIVE one (an ECDSA
  // recovery per event) for events already verified. That split is what makes
  // incremental verification safe rather than merely fast: content tampering
  // anywhere is caught by re-hashing, which costs a keccak; and an attacker who
  // repairs the hashes to hide it must rewrite every later hash too, which
  // breaks the signatures they cannot forge without the connector key.
  let prevHash = from ? from.hash : GENESIS_HASH;
  let prevSeq = from ? from.seq : 0;
  for (const event of events) {
    if (event.seq !== prevSeq + 1) failures.push({ seq: event.seq, reason: `gap: expected ${prevSeq + 1}` });
    if (event.prev_hash !== prevHash) failures.push({ seq: event.seq, reason: "broken chain" });
    const recomputed = eventHash(event);
    if (event.hash !== recomputed) failures.push({ seq: event.seq, reason: "hash mismatch" });
    if (verifySignature && (signaturesAfterSeq === null || event.seq > signaturesAfterSeq)) {
      const ok = await verifySignature(event);
      if (!ok) failures.push({ seq: event.seq, reason: "bad signature" });
    }
    prevHash = event.hash;
    prevSeq = event.seq;
  }
  return { ok: failures.length === 0, failures };
}

/** Deduplication key: one source fact enters the log once. */
export function dedupeKey(draft) {
  return `${draft.source}:${draft.source_event_id}`;
}

/**
 * Identity of a fact's *content*.
 *
 * Deduplicating on `source_event_id` alone is right for the retries and window
 * overlaps that make polling reconnect-safe, and wrong for a restatement: a
 * provider that corrects a fill it already reported would have that correction
 * silently dropped, leaving the log with a stale figure while the raw bytes a
 * resolver reconstructs from carry the new one.
 */
export function contentKey(draft) {
  return `${dedupeKey(draft)}:${canonicalize(draft.facts ?? {})}`;
}

/** Freshness in milliseconds at `now`, measured on observed_at of the tip. */
export function freshnessAgeMs(tip, nowMs) {
  if (!tip) return Number.POSITIVE_INFINITY;
  return nowMs - Date.parse(tip.observed_at);
}

/**
 * Verifies an append-only log incrementally, holding a watermark.
 *
 * Exists because `verifyChain` had no production caller: the resolver read the
 * log bare and attested from whatever came back. Every operator role opens the
 * same SQLite file, so a writer with access to it could insert an event with a
 * self-consistent `raw_hash` and both resolvers would agree — agreement between
 * two readers of one corrupted source, which is not the independence ADR 0024
 * claims. The mechanism existed; this is what runs it.
 *
 * The watermark is an optimisation, and the check that it is still valid is the
 * safety property. Resuming from a cached tip without re-checking the prefix
 * would verify only the untouched suffix and report ok on a log whose history
 * had been rewritten underneath the process — turning the guard into a
 * blindfold. So the event AT the watermark is re-hashed every pass: cheap (one
 * event, no signature recovery), and it is exactly the thing an attacker would
 * have to alter.
 */
export class ChainVerifier {
  constructor({ verifySignature = null } = {}) {
    this.verifySignature = verifySignature;
    this.verifiedSeq = 0;
    this.verifiedHash = GENESIS_HASH;
  }

  /**
   * @param events the whole log, in append order
   * @returns { ok, failures } exactly as verifyChain does
   */
  async verify(events) {
    const all = [...events];
    // Structure over EVERYTHING, every pass. Skipping the prefix here was the
    // tempting optimisation and it is wrong: an event rewritten below the
    // watermark leaves every later link intact — the attacker altered content,
    // not the stored hash — so a verifier that resumed from its watermark would
    // check only the untouched suffix and report a tampered log as clean.
    // Re-hashing is a keccak per event; the thing worth skipping is the ECDSA.
    const result = await verifyChain(all, {
      verifySignature: this.verifySignature,
      signaturesAfterSeq: this.verifiedSeq === 0 ? null : this.verifiedSeq,
    });

    // The watermark only advances on a clean pass. A log that failed is
    // re-checked in full next time rather than resumed from inside the damage.
    if (result.ok && all.length > 0) {
      const tip = all.at(-1);
      this.verifiedSeq = tip.seq;
      this.verifiedHash = tip.hash;
    }
    return result;
  }
}
