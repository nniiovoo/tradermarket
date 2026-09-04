// Issue 43: the question text is never checked against the rule that settles it.
//
// The question string and the condition params were independent operator
// inputs that nothing reconciled. The gate binds the text into `requestHash`
// but never reads it; the contract stores it with no validation. So this
// published, and was immutable on chain:
//
//   --question "Who reaches $5,000 first?"  --param target=10000
//
// Every forecaster reads a question about $5,000 and trades against a rule
// that settles at $10,000, and no component is in a position to notice because
// none of them was ever told the two are supposed to correspond.
//
// Worth being precise about the failure this mirrors. A live market elsewhere
// shipped with a literal unsubstituted "{name}" placeholder in its question —
// visibly broken, and therefore self-reporting. TraderMarket cannot leak a
// placeholder, but only because it had no substitution engine at all. The
// divergence here is invisible rather than obvious, which is worse.

import { test } from "node:test";
import assert from "node:assert/strict";

import { firstTemplateCatalog, renderQuestion } from "../src/publisher/publisher.mjs";

const ROSTER = ["alice", "bob"];

test("a templated question is rendered from the params that settle it", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  const text = renderQuestion(catalog, "tpl-participant-v1", { target: "10000" });

  assert.match(text, /10,?000/, "the number in the question is the number in the rule");
  assert.doesNotMatch(text, /\{|\}/, "and no placeholder survives into the published text");
});

test("every catalogue entry can render its own question", () => {
  // The gap this closes: the catalogue carried `shape`, `winnerRewardBps` and
  // `buildCondition` — everything needed to SETTLE a question and nothing
  // needed to STATE one.
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  const params = {
    "tpl-participant-v1": { target: "10000" },
    "tpl-threshold-v1": { participant: "alice", metric: "return_pct", operator: ">=", value: "2" },
    "tpl-race-v1": { metric: "return_pct", operator: ">=", value: "5" },
  };
  for (const [templateId, entry] of catalog) {
    assert.equal(typeof entry.renderQuestion, "function", `${templateId} must be able to state its own question`);
    const text = renderQuestion(catalog, templateId, params[templateId]);
    assert.ok(text.length > 0, `${templateId} rendered nothing`);
    assert.doesNotMatch(text, /\{|\}/, `${templateId} leaked a placeholder`);
    assert.doesNotMatch(text, /undefined|null|NaN/, `${templateId} rendered a missing value as text`);
  }
});

test("the rendered question names the participant the rule actually binds", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  const text = renderQuestion(catalog, "tpl-threshold-v1", {
    participant: "bob",
    metric: "return_pct",
    operator: ">=",
    value: "2",
  });
  assert.match(text, /bob/i);
  assert.doesNotMatch(text, /\balice\b/i, "and not the other one");
});

test("a question whose text disagrees with its params is refused", () => {
  // The $5,000/$10,000 case from the issue, which is the whole point.
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(
    () =>
      assertQuestionMatches(catalog, "tpl-participant-v1", { target: "10000" }, "Who reaches $5,000 first?"),
    /5,?000|10,?000|does not match/i
  );
});

test("a question that does match its params is accepted", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  const params = { target: "10000" };
  const text = renderQuestion(catalog, "tpl-participant-v1", params);
  assert.doesNotThrow(() => assertQuestionMatches(catalog, "tpl-participant-v1", params, text));
});

test("an empty question is refused rather than stored as an empty string on chain", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(() => assertQuestionMatches(catalog, "tpl-participant-v1", { target: "10000" }, "   "), /empty|required/i);
});

test("an unknown template cannot be rendered into a question", () => {
  const catalog = firstTemplateCatalog({ participants: ROSTER });
  assert.throws(() => renderQuestion(catalog, "tpl-not-in-the-catalogue", {}), /tpl-not-in-the-catalogue/);
});

// Imported after the tests that define what it must do, so the failing-first
// run names the missing export rather than crashing on module load.
const { assertQuestionMatches } = await import("../src/publisher/publisher.mjs");
