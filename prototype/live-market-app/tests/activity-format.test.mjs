import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatTimelineMoment,
  honestTimeline,
  settlementResultLabel,
} from "../src/views/activity-format.js";

test("an opened Unix timestamp is rendered as an explicit UTC date", () => {
  assert.equal(formatTimelineMoment("opened", "1787192264"), "Aug 20, 2026, 2:17 AM UTC");
});

test("non-time evidence stays verbatim and unknown time stays unknown", () => {
  assert.equal(formatTimelineMoment("closed", "source sequence 23"), "source sequence 23");
  assert.equal(formatTimelineMoment("final", "block 73"), "block 73");
  assert.equal(formatTimelineMoment("opened", null), null);
  assert.equal(formatTimelineMoment("opened", "not recorded"), "not recorded");
});

test("an impossible final-after-credit chronology fails closed", () => {
  const stages = honestTimeline(
    [
      { stage: "final", reached: true, at: "block 73" },
      { stage: "credited", reached: true, at: "block 70" },
    ],
    [{ block_number: 70 }]
  );
  assert.equal(stages[0].at, null);
  assert.equal(stages[1].at, "block 70");
});

test("a settlement names the human winner when the API has frozen evidence", () => {
  assert.equal(
    settlementResultLabel(
      { outcome_label: "outcome_a", winner_name: "Alice" },
      { a: "Alice", b: "Bob" }
    ),
    "Alice won"
  );
});

test("the same formatter names winners in the recent-resolution feed", () => {
  assert.equal(
    settlementResultLabel(
      { outcome_label: "outcome_b", winner_name: "Bob" },
      { a: "Alice", b: "Bob" }
    ),
    "Bob won"
  );
});

test("a missing participant label is never guessed", () => {
  assert.equal(settlementResultLabel({ outcome_label: "outcome_a", winner_name: null }, {}), "Outcome A");
  assert.equal(settlementResultLabel({ outcome_label: "tie" }, {}), "Tie — both sides redeem at 0.5");
  assert.equal(settlementResultLabel({ outcome_label: "invalid" }, {}), "Invalid — collateral returned");
});
