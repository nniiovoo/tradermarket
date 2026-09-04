// Issue 42: a mistyped participant silently settles the wrong side.
//
// Param validation was presence-only — `if (!params[key]) throw` — so nothing
// compared `params.participant` against the room's actual roster. The failure
// was not an error, it was a wrong payout:
//
//   1. `evaluateWindow`'s threshold branch short-circuits on
//      `event.participant !== condition.params.participant`, so no event ever
//      reaches the predicate.
//   2. The scan therefore returns `undecided`, which is the normal state of a
//      live question, so the gate signs it.
//   3. At session end `undecidedAtSessionEnd` returns "no" for this template.
//
// A question about a participant who does not exist settled NO with full
// confidence, and every fail-closed mechanism was bypassed because nothing
// decided the question was unanswerable. "Nothing happened" and "the thing did
// not happen" are different facts and the system conflated them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { firstTemplateCatalog } from "../src/publisher/publisher.mjs";
import { evaluateCondition } from "../src/domain/conditions.mjs";

const ROSTER = ["alice", "bob"];

/** A minimal closed-session log naming only the real participants. */
function sessionLog() {
  const trade = (seq, participant, pnl) => ({
    seq,
    participant,
    kind: "trade_closed",
    source_event_id: `t${seq}`,
    facts: { realized_pnl_usd: pnl },
    derived: {},
  });
  return [
    { seq: 1, participant: "alice", kind: "baseline", source_event_id: "b1", facts: { account_value_usd: "10000" }, derived: {} },
    { seq: 2, participant: "bob", kind: "baseline", source_event_id: "b2", facts: { account_value_usd: "10000" }, derived: {} },
    trade(3, "alice", "100"),
    trade(4, "bob", "50"),
  ];
}

// ------------------------------------------------------------ queue time

test("a participant who is not in the room is refused when the question is built", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(
    () =>
      catalog.get("tpl-threshold-v1").buildCondition({
        participant: "alicee", // one keystroke from "alice"
        metric: "return_pct",
        operator: ">=",
        value: "2",
      }),
    (error) => {
      assert.match(error.message, /alicee/, "the refusal names the value that was wrong");
      assert.match(error.message, /alice|bob/, "and the ones that would have been right");
      return true;
    }
  );
});

test("a participant who IS in the room is accepted", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  const condition = catalog.get("tpl-threshold-v1").buildCondition({
    participant: "alice",
    metric: "return_pct",
    operator: ">=",
    value: "2",
  });
  assert.equal(condition.params.participant, "alice");
});

test("a metric this build cannot compute is refused, not discovered at settlement", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(
    () =>
      catalog.get("tpl-threshold-v1").buildCondition({
        participant: "alice",
        metric: "sharpe_ratio",
        operator: ">=",
        value: "2",
      }),
    /sharpe_ratio/
  );
});

test("an operator that is not a comparison is refused", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(
    () =>
      catalog.get("tpl-threshold-v1").buildCondition({
        participant: "alice",
        metric: "return_pct",
        operator: "=~",
        value: "2",
      }),
    /=~/
  );
});

test("without a roster the catalogue still refuses an unknown metric", () => {
  // Backwards compatible for callers that genuinely have no roster — but the
  // checks that need no roster still run.
  const catalog = firstTemplateCatalog();
  assert.throws(
    () => catalog.get("tpl-threshold-v1").buildCondition({ participant: "anyone", metric: "nope", operator: ">=", value: "1" }),
    /nope/
  );
});

// ------------------------------------------------------- evaluation time

test("a condition naming a participant the log has never heard of is unevaluable, never 'no'", () => {
  // The load-bearing assertion. Before this, the session ending turned an
  // unanswerable question into a confident NO and paid the wrong side.
  const decision = evaluateCondition(
    {
      condition_version: "1.0.0",
      template: "participant_metric_threshold",
      params: { participant: "alicee", metric: "return_pct", operator: ">=", value: "2" },
    },
    sessionLog(),
    { participants: ROSTER }
  );

  assert.equal(decision.status, "unevaluable", `expected unevaluable, got ${JSON.stringify(decision)}`);
  assert.match(decision.reason, /alicee/, "and it says which participant it could not find");
});

test("a real participant who simply has not qualified yet stays undecided", () => {
  // The discriminator must not over-fire. "This participant exists and has not
  // hit the threshold" is the ordinary state of a live question, and calling it
  // unevaluable would suspend and eventually invalidate healthy markets.
  const decision = evaluateCondition(
    {
      condition_version: "1.0.0",
      template: "participant_metric_threshold",
      params: { participant: "bob", metric: "realized_pnl_usd", operator: ">=", value: "999999" },
    },
    sessionLog(),
    { participants: ROSTER }
  );
  assert.equal(decision.status, "undecided");
});

test("a rosterless caller still evaluates — the roster check is a layer, not a requirement", () => {
  const decision = evaluateCondition(
    {
      condition_version: "1.0.0",
      template: "participant_metric_threshold",
      params: { participant: "alice", metric: "return_pct", operator: ">=", value: "2" },
    },
    sessionLog()
  );
  // No roster supplied: publication-time validation is the layer that catches
  // this, and evaluation stays permissive rather than inventing a verdict.
  assert.equal(decision.status, "undecided");
});
