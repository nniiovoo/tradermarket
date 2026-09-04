// Resolver Node (issue 14, ADR 0024): reconstructs every result independently
// from RAW provider data. Never reads the connector's `facts` or `derived`
// fields, or any Coordinator state, as a resolution input — the log's raw
// pointers (raw_ref / raw_query / raw_hash) are its only bridge, and the raw
// bytes are re-verified against raw_hash before use.
//
// Fail-closed rules:
// - A reconstruction that cannot be evaluated produces NO attestation.
// - A reconstruction that diverges from the archived log at fact level
//   produces NO attestation and a loud divergence report: the gate acted on a
//   log the raw data does not support, so the market must fail to Invalid
//   rather than resolve to either side.

import { keccak256, toHex } from "viem";
import { canonicalize } from "../domain/eventlog.mjs";
import { normalizeFillsResponse, normalizeBaseline } from "../connector/hyperliquid.mjs";
import { addDecimal, compareDecimal, percentOf } from "../domain/decimal.mjs";
import { EVALUATOR_VERSION, undecidedAtSessionEnd } from "../domain/conditions.mjs";

export const OUTCOME_ENUM = { a: 1, b: 2, yes: 1, no: 2, tie: 3, invalid: 4 };

export class ResolverNode {
  /**
   * @param options.name          operator label (three independent operators)
   * @param options.rawArchive    RawArchive port (or a re-fetching adapter)
   * @param options.participants  [{ key, address }] frozen linked accounts
   * @param options.signerChain   port with attestResult(market, outcomeEnum, evidenceHash)
   */
  constructor({ name, rawArchive, participants, signerChain }) {
    this.name = name;
    this.rawArchive = rawArchive;
    this.participants = participants;
    this.signerChain = signerChain;
    this.incidents = [];
  }

  _participantKeyFor(address) {
    const entry = this.participants.find(
      (participant) => participant.address.toLowerCase() === String(address).toLowerCase()
    );
    return entry ? entry.key : null;
  }

  /**
   * Rebuilds the session's fact set from raw payloads alone. `logEvents` is
   * used ONLY for its raw pointers and, afterwards, as a comparison target.
   */
  async reconstructFacts(logEvents) {
    const facts = new Map(); // source_event_id -> draft
    const baselines = new Map();
    const divergence = [];
    const seenRefs = new Set();

    for (const event of logEvents) {
      if (event.kind === "heartbeat") continue;
      if (seenRefs.has(event.raw_ref)) continue;
      seenRefs.add(event.raw_ref);

      let rawBytes;
      try {
        rawBytes = await this.rawArchive.get(event.raw_ref);
      } catch (error) {
        divergence.push({ kind: "missing_raw", ref: event.raw_ref });
        continue;
      }
      if (keccak256(toHex(rawBytes)) !== event.raw_hash) {
        divergence.push({ kind: "raw_hash_mismatch", ref: event.raw_ref });
        continue;
      }
      const query = event.raw_query;
      const participantKey = this._participantKeyFor(query.user);
      if (!participantKey) {
        divergence.push({ kind: "unknown_account", ref: event.raw_ref, user: query.user });
        continue;
      }
      const payload = JSON.parse(rawBytes);
      if (query.type === "clearinghouseState") {
        const draft = normalizeBaseline(participantKey, query.user, payload, query.at);
        baselines.set(participantKey, draft.facts.account_value_usd);
      } else if (query.type === "userFillsByTime" || query.type === "userFills") {
        for (const draft of normalizeFillsResponse(participantKey, query.user, payload)) {
          facts.set(draft.source_event_id, draft);
        }
      }
    }

    // Independent ordering: provider fill time, then trade id. Never the
    // connector's sequence numbers.
    const ordered = [...facts.values()].sort((a, b) => {
      const at = Date.parse(a.observed_at) - Date.parse(b.observed_at);
      return at !== 0 ? at : String(a.facts.tid).localeCompare(String(b.facts.tid));
    });
    return { ordered, baselines, divergence };
  }

  /** Fact-level comparison against the archived log (post-hoc only). */
  compareWithLog(reconstruction, logEvents) {
    const divergence = [...reconstruction.divergence];
    const logFacts = new Map();
    for (const event of logEvents) {
      if (event.kind === "trade_closed") logFacts.set(event.source_event_id, event.facts.realized_pnl_usd);
    }
    for (const draft of reconstruction.ordered) {
      const logged = logFacts.get(draft.source_event_id);
      if (logged === undefined) {
        divergence.push({ kind: "log_missing_fact", id: draft.source_event_id });
      } else if (compareDecimal(logged, draft.facts.realized_pnl_usd) !== 0) {
        divergence.push({
          kind: "fact_mismatch",
          id: draft.source_event_id,
          logged,
          reconstructed: draft.facts.realized_pnl_usd,
        });
      }
      logFacts.delete(draft.source_event_id);
    }
    for (const id of logFacts.keys()) divergence.push({ kind: "log_extra_fact", id });
    return divergence;
  }

  /**
   * Evaluates one slot's condition over the raw-reconstructed, time-ordered
   * facts. `headlineCondition` defines the session's terminal boundary.
   */
  evaluateSlot(condition, headlineCondition, reconstruction) {
    const { ordered, baselines } = reconstruction;
    const cum = new Map();
    let terminalIndex = null;
    let headlineOutcome = null;

    const valueOf = (participant, metric) => {
      const pnl = cum.get(participant) ?? "0";
      if (metric === "realized_pnl_usd") return pnl;
      if (metric === "return_pct") {
        const baseline = baselines.get(participant);
        if (baseline === undefined) throw new Error(`no baseline for ${participant}`);
        return percentOf(pnl, baseline);
      }
      throw new Error(`unknown metric ${metric}`);
    };

    let slotDecision = null;
    try {
      for (let index = 0; index < ordered.length; index++) {
        const draft = ordered[index];
        cum.set(draft.participant, addDecimal(cum.get(draft.participant) ?? "0", draft.facts.realized_pnl_usd));

        if (terminalIndex === null && headlineDecides(headlineCondition, draft, valueOf)) {
          terminalIndex = index;
          headlineOutcome = draft.participant;
        }
        if (slotDecision === null) {
          const decided = slotDecides(condition, draft, valueOf);
          if (decided) slotDecision = { outcome: decided, at: index, fill: draft.facts.tid };
        }
        if (terminalIndex !== null) break; // nothing after the terminal fill counts
      }
    } catch (error) {
      return { status: "unevaluable", reason: error.message };
    }

    // `decidedAt` is the index of the fact that determined the answer. Facts
    // after it cannot change the answer, and so must not change the evidence
    // either — see buildEvidence.
    if (condition === headlineCondition) {
      if (headlineOutcome === null) return { status: "unevaluable", reason: "terminal condition never met in raw data" };
      return {
        status: "decided",
        outcome: headlineOutcome,
        terminalFill: ordered[terminalIndex].facts.tid,
        decidedAt: terminalIndex,
      };
    }
    if (slotDecision !== null && (terminalIndex === null || slotDecision.at <= terminalIndex)) {
      return {
        status: "decided",
        outcome: slotDecision.outcome,
        terminalFill: slotDecision.fill,
        decidedAt: slotDecision.at,
      };
    }
    if (terminalIndex === null) return { status: "unevaluable", reason: "session terminal not reached in raw data" };
    const fallback = undecidedAtSessionEnd(condition);
    if (fallback === null) return { status: "unevaluable", reason: "no session-end rule" };
    return {
      status: "decided",
      outcome: fallback,
      terminalFill: ordered[terminalIndex].facts.tid,
      decidedAt: terminalIndex,
    };
  }

  /**
   * Builds the canonical Evidence Bundle and its hash.
   *
   * The bundle stops at the fact that determined the answer. This is not a
   * detail: quorum is two resolvers producing the SAME evidence hash, and they
   * run as separate processes against a log the connector is still appending
   * to. Neither ever sees byte-identical input — one reads before a late fill
   * lands, the other after.
   *
   * Facts after the deciding one cannot change the outcome, and including them
   * made the hash a function of WHEN a resolver happened to look. Two honest
   * resolvers agreeing on the result then produced two different hashes, and
   * the market — needing two attestations of the same one — sat unresolved
   * until it timed out to Invalid. Only separate processes show this; in one
   * process every resolver is handed the same array.
   */
  buildEvidence({ market, conditionHash, decision, reconstruction }) {
    const through =
      typeof decision.decidedAt === "number" ? decision.decidedAt + 1 : reconstruction.ordered.length;
    const bundle = {
      market,
      condition_hash: conditionHash,
      evaluator_version: EVALUATOR_VERSION,
      outcome: decision.outcome,
      terminal_fill: decision.terminalFill ?? null,
      fact_ids: reconstruction.ordered.slice(0, through).map((draft) => draft.source_event_id),
      baselines: Object.fromEntries(reconstruction.baselines),
    };
    return { bundle, evidenceHash: keccak256(toHex(canonicalize(bundle))) };
  }

  /**
   * Full pipeline for one closed slot: reconstruct, compare, evaluate, attest.
   * Attests ONLY when the reconstruction is clean and evaluable.
   */
  /**
   * Rebuilds one slot's result from raw provider bytes, and signs nothing.
   *
   * Split out of `resolveSlot` so that attesting a result and adjudicating a
   * bonded challenge derive the answer the same way. Two derivations that were
   * supposed to agree but were written twice is precisely how a resolver ends up
   * rejecting a challenge against a result its own evidence does not support.
   *
   * @returns {Promise<{outcomeEnum: number|null, evidenceHash?: string, bundle?: object, reason?: string}>}
   */
  async reconstructSlot({ market, condition, conditionHash, headlineCondition, logEvents, participantAKey, participantBKey }) {
    const reconstruction = await this.reconstructFacts(logEvents);
    const divergence = this.compareWithLog(reconstruction, logEvents);
    if (divergence.length > 0) {
      this.incidents.push({ market, divergence });
      return { outcomeEnum: null, reason: "divergence", divergence };
    }
    const decision = this.evaluateSlot(condition, headlineCondition, reconstruction);
    if (decision.status !== "decided") {
      this.incidents.push({ market, unevaluable: decision.reason });
      return { outcomeEnum: null, reason: decision.reason };
    }
    const { bundle, evidenceHash } = this.buildEvidence({ market, conditionHash, decision, reconstruction });
    const outcomeEnum =
      decision.outcome === participantAKey
        ? OUTCOME_ENUM.a
        : decision.outcome === participantBKey
          ? OUTCOME_ENUM.b
          : OUTCOME_ENUM[decision.outcome];
    if (!outcomeEnum) return { outcomeEnum: null, reason: `unmappable outcome ${decision.outcome}` };
    return { outcomeEnum, evidenceHash, bundle };
  }

  async resolveSlot(args) {
    const { market } = args;
    const rebuilt = await this.reconstructSlot(args);
    if (rebuilt.outcomeEnum === null) {
      return { attested: false, reason: rebuilt.reason, ...(rebuilt.divergence ? { divergence: rebuilt.divergence } : {}) };
    }
    await this.signerChain.attestResult(market, rebuilt.outcomeEnum, rebuilt.evidenceHash);
    return { attested: true, outcomeEnum: rebuilt.outcomeEnum, evidenceHash: rebuilt.evidenceHash, bundle: rebuilt.bundle };
  }
}

function headlineDecides(headlineCondition, draft, valueOf) {
  if (headlineCondition.template !== "first_to_realized_pnl") return false;
  return compareDecimal(valueOf(draft.participant, "realized_pnl_usd"), headlineCondition.params.target) >= 0;
}

function slotDecides(condition, draft, valueOf) {
  if (condition.template === "first_to_realized_pnl") {
    if (compareDecimal(valueOf(draft.participant, "realized_pnl_usd"), condition.params.target) >= 0) {
      return draft.participant;
    }
    return null;
  }
  if (condition.template === "participant_metric_threshold") {
    if (draft.participant !== condition.params.participant) return null;
    if (satisfies(condition.params.operator, valueOf(draft.participant, condition.params.metric), condition.params.value)) {
      return "yes";
    }
    return null;
  }
  if (condition.template === "first_to_metric") {
    if (satisfies(condition.params.operator, valueOf(draft.participant, condition.params.metric), condition.params.value)) {
      return draft.participant;
    }
    return null;
  }
  throw new Error(`unknown template ${condition.template}`);
}

function satisfies(operator, left, right) {
  const cmp = compareDecimal(left, right);
  if (operator === ">=") return cmp >= 0;
  if (operator === ">") return cmp > 0;
  if (operator === "<=") return cmp <= 0;
  if (operator === "<") return cmp < 0;
  throw new Error(`unknown operator ${operator}`);
}
