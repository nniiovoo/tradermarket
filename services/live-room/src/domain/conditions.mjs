// Condition evaluation: a pure function (condition, log window) -> Decision.
// Versioned, deterministic, side-effect free, reproducible from the archived
// log by any third party. Its version and the condition hash are recorded in
// the Evidence Bundle so a challenger can rerun it.
//
// The evaluator accumulates from per-event FACTS only. It never reads an
// event's `derived` fields — those are display projections, and trusting them
// here would collapse the resolver's independence (ADR 0024).
//
// Decision: { status: 'undecided' }
//         | { status: 'decided', outcome, seq }
//         | { status: 'unevaluable', reason }
// outcome: participant key | 'yes' | 'no' | 'tie'

import { keccak256, toHex } from "viem";
import { canonicalize } from "./eventlog.mjs";
import { addDecimal, compareDecimal, percentOf } from "./decimal.mjs";

export const EVALUATOR_VERSION = "1.0.0";

export function conditionHash(condition) {
  return keccak256(toHex(canonicalize(condition)));
}

function satisfies(operator, left, right) {
  const cmp = compareDecimal(left, right);
  switch (operator) {
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    default:
      throw new Error(`unknown operator ${operator}`);
  }
}

/**
 * Folds the event window into per-participant metric state from facts alone.
 * baseline (kind=baseline, facts.account_value_usd) enables return_pct.
 * trade_closed (facts.realized_pnl_usd) accumulates realized PnL.
 */
/**
 * The session's timeline: corrections applied in place, ordered by when things
 * actually happened.
 *
 * Two different orders exist here and conflating them decides markets wrongly.
 * The log's sequence records the order facts REACHED US — append-only, gap-free,
 * the basis of the hash chain. The provider's timestamps record the order they
 * HAPPENED. They come apart constantly: an indexing lag on one account, a window
 * re-asked after a failure, and above all the reconciliation sweep, whose entire
 * job is to append facts late.
 *
 * Every condition here is "the FIRST participant to…" or "the first time X
 * exceeds…". Order is not a detail of those questions, it IS those questions. So
 * the timeline is the provider's, exactly as a resolver rebuilding from raw bytes
 * orders it (ADR 0024) — otherwise the gate can close a room on one participant
 * while both resolvers attest the other, with no divergence to show for it,
 * because every fact matches and only the order differed.
 *
 * Corrections are applied in place: a restated fact takes the position of the
 * fact it supersedes, and the correction event itself leaves the timeline.
 *
 * Order matters as much as arithmetic here. Every template decides at the FIRST
 * event that satisfies it, so a correction merely counted at the end would let
 * a threshold be crossed by a figure the provider has since withdrawn and never
 * be re-examined. Put back where the fact happened, the crossing never happened
 * either — which is what a resolver rebuilding from raw bytes concludes, and the
 * two must not disagree about what a market pays.
 *
 * The superseded event stays in the log. This is a read-side view of it.
 */
export function rectify(events) {
  const slotOf = new Map(); // event hash -> index in the rectified timeline
  const timeline = [];
  for (const event of events) {
    const supersedes = event.corrects ? slotOf.get(event.corrects) : undefined;
    if (supersedes === undefined) {
      slotOf.set(event.hash, timeline.length);
      timeline.push(event);
      continue;
    }
    // Keep the superseded event's seq and observed_at: the fact happened when
    // it happened. Only what the provider says about it has changed.
    const original = timeline[supersedes];
    timeline[supersedes] = { ...original, facts: event.facts, derived: event.derived, corrected_by: event.hash };
    slotOf.set(event.hash, supersedes); // a correction of a correction lands here too
  }

  // Stable sort into provider order. Baselines carry the session-start
  // timestamp, so they keep their place ahead of the fills they scale.
  // Ties break on the immutable trade id, then on sequence, so the order is
  // total and identical on every replay and in every resolver.
  return timeline
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const at = Date.parse(a.event.observed_at) - Date.parse(b.event.observed_at);
      if (at !== 0) return at;
      const tid = String(a.event.facts?.tid ?? "").localeCompare(String(b.event.facts?.tid ?? ""));
      if (tid !== 0) return tid;
      return a.index - b.index;
    })
    .map((entry) => entry.event);
}

export function foldMetrics(events, upToSeq = Number.POSITIVE_INFINITY) {
  const state = new Map();
  // Contributions are held per fact id, not accumulated as they arrive.
  //
  // A provider can restate a fill it already reported, and the connector
  // appends that restatement as a correction rather than dropping it. Adding
  // both would count the trade twice; ignoring the second would keep the stale
  // figure. Keyed by fact id and summed at the end, a corrected fact counts
  // once, at whatever the provider last said it was.
  const contributions = new Map(); // participant -> Map(source_event_id -> pnl)

  for (const event of rectify(events)) {
    // `continue`, not `break`: the timeline is in provider order, so sequence
    // numbers no longer ascend through it and stopping at the first
    // out-of-order event would silently drop the rest of the session.
    if (event.seq > upToSeq) continue;
    if (!event.participant) continue;
    let participant = state.get(event.participant);
    if (!participant) {
      participant = { baseline: null, cumRealizedPnlUsd: "0" };
      state.set(event.participant, participant);
      contributions.set(event.participant, new Map());
    }
    if (event.kind === "baseline") {
      participant.baseline = event.facts.account_value_usd;
    } else if (event.kind === "trade_closed") {
      contributions.get(event.participant).set(event.source_event_id, event.facts.realized_pnl_usd);
    }
  }

  for (const [key, participant] of state) {
    let total = "0";
    for (const value of contributions.get(key).values()) total = addDecimal(total, value);
    participant.cumRealizedPnlUsd = total;
  }
  return state;
}

function metricValue(state, participant, metric) {
  const entry = state.get(participant);
  if (!entry) return null;
  if (metric === "realized_pnl_usd") return entry.cumRealizedPnlUsd;
  if (metric === "return_pct") {
    if (entry.baseline === null) throw new Error(`no baseline for ${participant}`);
    return percentOf(entry.cumRealizedPnlUsd, entry.baseline);
  }
  throw new Error(`unknown metric ${metric}`);
}

/** The outcome a template resolves to when the session ends first, or null. */
export function undecidedAtSessionEnd(condition) {
  if (condition.template === "participant_metric_threshold") return "no";
  if (condition.template === "first_to_metric") return "tie";
  return null; // the headline's decision IS the session end
}

/**
 * Supported templates (frozen for the first Competition Template, ADR 0023):
 *
 * first_to_realized_pnl { target }
 *   headline: the first participant whose accumulated realized PnL reaches
 *   `target` wins at that event's sequence; undecided until then.
 * participant_metric_threshold { participant, metric, operator, value }
 *   Yes at the first satisfying event; No when the session ends first.
 * first_to_metric { metric, operator, value }
 *   race: first participant to satisfy wins; Tie when the session ends first.
 *
 * Two different bounds, and they are not the same thing.
 *
 * `terminalSeq` bounds what the log HAD BY THEN — the room's closed sequence
 * from chain. It is a replay bound: it stops a record from being re-derived
 * with facts that arrived after the fact.
 *
 * `headlineCondition` bounds WHEN THE SESSION ENDED — the terminal fill, the
 * moment the headline was met on the provider's timeline. That is the bound a
 * resolver uses, and nothing after that fill counts for any slot.
 *
 * They coincide until they don't, and this build creates the case where they
 * part: when a restatement decides the headline retroactively, the room must
 * close at a sequence the chain accepts, which is past the true decisive one.
 * Bounding a slot by that sequence includes fills the resolver dropped, and the
 * published record then states an outcome the market did not pay. So when the
 * headline is known, it — not the sequence — ends the session.
 */
export function evaluateCondition(condition, events, { terminalSeq = null, headlineCondition = null, participants = null } = {}) {
  const roster = participants && participants.length > 0
    ? new Set([...participants].map((entry) => String(entry?.key ?? entry).toLowerCase()))
    : null;
  const timeline = rectify(events);
  const known = terminalSeq === null ? timeline : timeline.filter((event) => event.seq <= terminalSeq);

  // The session's end, computed the way a resolver computes it.
  let window = known;
  let terminalIndex = null;
  if (headlineCondition && headlineCondition !== condition) {
    const terminal = evaluateWindow(headlineCondition, known, roster);
    if (terminal.status === "decided") {
      terminalIndex = known.findIndex((event) => event.seq === terminal.seq);
      if (terminalIndex >= 0) window = known.slice(0, terminalIndex + 1);
    }
  }

  const decision = evaluateWindow(condition, window, roster);
  if (decision.status !== "undecided") return decision;

  const ended = terminalIndex !== null && terminalIndex >= 0;
  if (ended || terminalSeq !== null) {
    const fallback = undecidedAtSessionEnd(condition);
    if (fallback !== null) {
      return { status: "decided", outcome: fallback, seq: ended ? window.at(-1).seq : terminalSeq };
    }
  }
  return decision;
}

/**
 * @param participants optional Set of lowercase roster keys. Supplied, a
 *   condition naming somebody outside it is unevaluable rather than
 *   silently matching nothing; omitted, that check does not run.
 */
function evaluateWindow(condition, events, participants = null) {
  try {
    switch (condition.template) {
      case "first_to_realized_pnl":
        return scanning(events, (state, event) => {
          if (event.kind !== "trade_closed") return null;
          const value = metricValue(state, event.participant, "realized_pnl_usd");
          if (value !== null && satisfies(">=", value, condition.params.target)) {
            return { status: "decided", outcome: event.participant, seq: event.seq };
          }
          return null;
        });
      case "participant_metric_threshold": {
        // A question about somebody who is not in this room is not a question
        // that answered "no" — it is a question nobody can answer.
        //
        // Without this the short-circuit below silently matched no event, the
        // scan returned `undecided`, and `undecidedAtSessionEnd` then turned
        // that into a confident NO. A single mistyped participant paid the
        // wrong side, and every fail-closed path was bypassed because nothing
        // had decided the question was unanswerable.
        //
        // Checked against the ROSTER, never inferred from the log. A
        // participant who is genuinely in the room but has not traded yet is
        // absent from the log for the first part of every session, and treating
        // that absence as "not in the room" would suspend and eventually
        // invalidate perfectly healthy markets. Absence of evidence is exactly
        // what this must not read as evidence of absence.
        //
        // No roster supplied means no check here; publication-time validation
        // in the template catalogue is the other, earlier layer.
        if (participants && !participants.has(String(condition.params.participant).toLowerCase())) {
          return {
            status: "unevaluable",
            reason:
              `this question names participant "${condition.params.participant}", ` +
              `who is not in this room's roster: ${[...participants].join(", ")}`,
          };
        }
        return scanning(events, (state, event) => {
          if (event.kind !== "trade_closed" || event.participant !== condition.params.participant) return null;
          const value = metricValue(state, event.participant, condition.params.metric);
          if (value !== null && satisfies(condition.params.operator, value, condition.params.value)) {
            return { status: "decided", outcome: "yes", seq: event.seq };
          }
          return null;
        });
      }
      case "first_to_metric":
        return scanning(events, (state, event) => {
          if (event.kind !== "trade_closed") return null;
          const value = metricValue(state, event.participant, condition.params.metric);
          if (value !== null && satisfies(condition.params.operator, value, condition.params.value)) {
            return { status: "decided", outcome: event.participant, seq: event.seq };
          }
          return null;
        });
      default:
        return { status: "unevaluable", reason: `unknown template ${condition.template}` };
    }
  } catch (error) {
    return { status: "unevaluable", reason: error.message };
  }
}

/** Incremental fold + per-event predicate, deciding at the FIRST satisfying event. */
function scanning(events, decide) {
  const state = new Map();
  for (const event of events) {
    if (event.participant) {
      let participant = state.get(event.participant);
      if (!participant) {
        participant = { baseline: null, cumRealizedPnlUsd: "0" };
        state.set(event.participant, participant);
      }
      if (event.kind === "baseline") {
        participant.baseline = event.facts.account_value_usd;
      } else if (event.kind === "trade_closed") {
        participant.cumRealizedPnlUsd = addDecimal(participant.cumRealizedPnlUsd, event.facts.realized_pnl_usd);
      }
    }
    const decision = decide(state, event);
    if (decision) return decision;
  }
  return { status: "undecided" };
}

/** Maps a decision outcome to the market's Outcome enum value. */
export function outcomeToMarketEnum(outcome, participantAKey, participantBKey) {
  if (outcome === participantAKey || outcome === "yes") return 1; // ParticipantA / Yes
  if (outcome === participantBKey || outcome === "no") return 2; // ParticipantB / No
  if (outcome === "tie") return 3;
  throw new Error(`unmappable outcome ${outcome}`);
}
