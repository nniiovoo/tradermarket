import test from "node:test";
import assert from "node:assert/strict";
import {
  GUEST_RACE_MARKET,
  CATCHPHRASE_COUNT_MARKET,
  buildReviewableDraft,
  creatorDraftSeed,
  validateCreatorDraft,
} from "../src/market-drafts.js";

const stream = {
  watchUrl: "https://www.youtube.com/@example/live",
  label: "YouTube",
};

test("the catchphrase-count event means more than 20, never 20 or more", () => {
  const draft = creatorDraftSeed(CATCHPHRASE_COUNT_MARKET);
  assert.match(draft.question, /more than 20/i);
  assert.match(draft.outcomeA, /21 or more/i);
  assert.match(draft.outcomeB, /20 or fewer/i);
  assert.match(draft.winningRule, /YES wins at 21 or more/i);
});

test("the Alice guest race has two observable outcomes and refunds an unresolved race", () => {
  const draft = creatorDraftSeed(GUEST_RACE_MARKET);
  assert.match(draft.question, /which guest appears first/i);
  assert.match(draft.outcomeA, /first guest appears first/i);
  assert.match(draft.outcomeB, /second guest appears first/i);
  assert.match(draft.streamUrl, /twitch\.tv\/example/i);
  assert.match(draft.winningRule, /three continuous seconds/i);
  assert.match(draft.winningRule, /same whole-second timestamp.*Invalid/i);
  assert.match(draft.winningRule, /neither.*Invalid/i);
});

test("stream-event drafts use evidence outcomes and do not invent a participant reward", () => {
  const draft = creatorDraftSeed(CATCHPHRASE_COUNT_MARKET);
  assert.equal(validateCreatorDraft(draft, stream), null);

  const reviewable = buildReviewableDraft(draft, stream, "2026-08-22T00:00:00.000Z");
  assert.equal(reviewable.market_type, "stream_event");
  assert.deepEqual(reviewable.outcomes.map((outcome) => outcome.key), ["a", "b"]);
  assert.equal(reviewable.fees.liquidity_provider_bps, 30);
  assert.equal(reviewable.fees.winning_participant_bps, 0);
  assert.equal(reviewable.resolution.unresolved_result, "Invalid");
  assert.equal(reviewable.resolution.challenge_window_seconds, 600);
  assert.equal(reviewable.evidence.complete_observation_recording_required, true);
  assert.ok(!("participants" in reviewable));
});

test("the event draft requires an approved evidence source", () => {
  const draft = creatorDraftSeed({ ...CATCHPHRASE_COUNT_MARKET, approvedSource: "" });
  assert.match(validateCreatorDraft(draft, stream), /approved evidence source/i);
});
