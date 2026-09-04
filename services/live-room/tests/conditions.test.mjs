// Issue 05 (evaluator half): deterministic, versioned condition evaluation
// from facts alone, with the session end coming from the chain, not the log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition, conditionHash, undecidedAtSessionEnd, EVALUATOR_VERSION } from "../src/domain/conditions.mjs";
import { addDecimal, compareDecimal, percentOf } from "../src/domain/decimal.mjs";

function event(seq, participant, kind, facts = {}) {
  return { seq, participant, kind, facts, derived: { poisoned: "do-not-read" } };
}

const HEADLINE = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };
const THRESHOLD = {
  condition_version: "1.0.0",
  template: "participant_metric_threshold",
  params: { participant: "bob", metric: "return_pct", operator: ">=", value: "2" },
};
const RACE = {
  condition_version: "1.0.0",
  template: "first_to_metric",
  params: { metric: "realized_pnl_usd", operator: ">=", value: "500" },
};

test("decimal arithmetic is exact", () => {
  assert.equal(addDecimal("0.1", "0.2"), "0.3");
  assert.equal(addDecimal("10.5", "-0.1"), "10.4");
  assert.equal(percentOf("250", "10000"), "2.5");
  assert.equal(compareDecimal("2.499999", "2.5"), -1);
});

test("headline decides for the first participant to reach the target, at that seq", () => {
  const events = [
    event(1, "alice", "trade_closed", { realized_pnl_usd: "6000" }),
    event(2, "bob", "trade_closed", { realized_pnl_usd: "9999.999999" }),
    event(3, "alice", "trade_closed", { realized_pnl_usd: "4000" }),
    event(4, "bob", "trade_closed", { realized_pnl_usd: "0.000001" }),
  ];
  const decision = evaluateCondition(HEADLINE, events);
  assert.deepEqual(decision, { status: "decided", outcome: "alice", seq: 3 });
});

test("headline stays undecided below the target", () => {
  const events = [event(1, "alice", "trade_closed", { realized_pnl_usd: "9999.999999" })];
  assert.equal(evaluateCondition(HEADLINE, events).status, "undecided");
});

test("threshold decides yes at the first satisfying event with a baseline", () => {
  const events = [
    event(1, "bob", "baseline", { account_value_usd: "10000" }),
    event(2, "bob", "trade_closed", { realized_pnl_usd: "150" }),
    event(3, "bob", "trade_closed", { realized_pnl_usd: "50" }),
  ];
  const decision = evaluateCondition(THRESHOLD, events);
  assert.deepEqual(decision, { status: "decided", outcome: "yes", seq: 3 }, "2% of 10000 reached at seq 3");
});

test("threshold without a baseline is unevaluable, not a guess", () => {
  const events = [event(1, "bob", "trade_closed", { realized_pnl_usd: "150" })];
  const decision = evaluateCondition(THRESHOLD, events);
  assert.equal(decision.status, "unevaluable");
  assert.match(decision.reason, /baseline/);
});

test("threshold resolves No at the on-chain terminal sequence, ignoring later events", () => {
  const events = [
    event(1, "bob", "baseline", { account_value_usd: "10000" }),
    event(2, "bob", "trade_closed", { realized_pnl_usd: "100" }),
    // After the terminal sequence, bob crosses the threshold — must not count.
    event(9, "bob", "trade_closed", { realized_pnl_usd: "5000" }),
  ];
  const decision = evaluateCondition(THRESHOLD, events, { terminalSeq: 5 });
  assert.deepEqual(decision, { status: "decided", outcome: "no", seq: 5 });
});

test("race decides for the first crosser, ties at session end", () => {
  const events = [
    event(1, "alice", "trade_closed", { realized_pnl_usd: "400" }),
    event(2, "bob", "trade_closed", { realized_pnl_usd: "499.999999" }),
    event(3, "bob", "trade_closed", { realized_pnl_usd: "0.000001" }),
  ];
  assert.deepEqual(evaluateCondition(RACE, events), { status: "decided", outcome: "bob", seq: 3 });
  assert.deepEqual(evaluateCondition(RACE, events.slice(0, 2), { terminalSeq: 7 }), {
    status: "decided",
    outcome: "tie",
    seq: 7,
  });
  assert.equal(undecidedAtSessionEnd(RACE), "tie");
  assert.equal(undecidedAtSessionEnd(HEADLINE), null);
});

test("evaluation never reads derived fields", () => {
  // Every event carries a poisoned derived block; only facts decide.
  const events = [
    event(1, "alice", "trade_closed", { realized_pnl_usd: "10000" }),
  ];
  const decision = evaluateCondition(HEADLINE, events);
  assert.equal(decision.outcome, "alice");
});

test("unknown template and corrupt facts fail closed to unevaluable", () => {
  assert.equal(evaluateCondition({ template: "nope", params: {} }, []).status, "unevaluable");
  const corrupt = [event(1, "alice", "trade_closed", { realized_pnl_usd: "not-a-number" })];
  assert.equal(evaluateCondition(HEADLINE, corrupt).status, "unevaluable");
});

test("condition hash is canonical and stable", () => {
  const reordered = {
    params: { target: "10000" },
    template: "first_to_realized_pnl",
    condition_version: "1.0.0",
  };
  assert.equal(conditionHash(HEADLINE), conditionHash(reordered));
  assert.equal(EVALUATOR_VERSION, "1.0.0");
});
