export const EMPTY_CREATOR_DRAFT = Object.freeze({
  marketType: "trader_battle",
  participantA: "",
  participantAAccount: "",
  participantB: "",
  participantBAccount: "",
  subject: "",
  outcomeA: "YES",
  outcomeB: "NO",
  question: "",
  streamUrl: "",
  approvedSource: "Hyperliquid account data",
  winningRule: "",
});

/**
 * A user-requested event market, kept as a reviewable draft until an operator
 * freezes one exact broadcast and its evidence policy. It is deliberately not
 * inserted into the chain-derived market list and carries no invented price.
 */
export const CATCHPHRASE_COUNT_MARKET = Object.freeze({
  marketType: "stream_event",
  subject: "Example Creator",
  outcomeA: "YES — 21 or more",
  outcomeB: "NO — 20 or fewer",
  question: "Will the creator say their catchphrase more than 20 times during this livestream?",
  streamUrl: "https://www.youtube.com/@example/live",
  approvedSource:
    "The complete archived recording of the exact official creator livestream, its content hash, and a canonical timestamp list reviewed by independent resolvers.",
  winningRule:
    "Count each distinct, audible utterance of the frozen catchphrase by the creator during the broadcast window. Multiple clearly distinguishable utterances in one sequence count separately. Replays, clips, soundboards, and other speakers do not count. YES wins at 21 or more; NO wins at 20 or fewer. If the recording is incomplete or two resolvers cannot approve the same canonical timestamp evidence, resolve the market Invalid.",
});

/**
 * A guest-arrival race on a creator's official channel. The market has no
 * arbitrary timer: it resolves on the first qualifying appearance, or is
 * Invalid if the frozen broadcast ends without a unique winner.
 */
export const GUEST_RACE_MARKET = Object.freeze({
  marketType: "stream_event",
  subject: "Example Creator",
  outcomeA: "First guest appears first",
  outcomeB: "Second guest appears first",
  question: "Which guest appears first on the creator's livestream?",
  streamUrl: "https://www.twitch.tv/example",
  approvedSource:
    "The complete archived recording of the exact official creator broadcast, its content hash, and canonical first-appearance timestamps approved by independent resolvers.",
  winningRule:
    "Observation begins at the market's frozen opening watermark. A person qualifies only when their live face is clearly visible in the creator's physical broadcast location for at least three continuous seconds. Photos, prerecorded clips, overlays, reflections, voice-only appearances, and phone or video calls do not count. The first guest wins if they reach the three-second threshold before the second; the second wins if they reach it first. If both first qualify within the same whole-second timestamp, neither appears before the frozen broadcast ends, the recording is incomplete, or two resolvers cannot approve the same canonical evidence, resolve the market Invalid and refund positions under the market's invalid-settlement rules.",
});

export function creatorDraftSeed(preset = null) {
  return { ...EMPTY_CREATOR_DRAFT, ...(preset ?? {}) };
}

export function validateCreatorDraft(draft, stream) {
  const question = draft.question.trim();
  const winningRule = draft.winningRule.trim();
  if (!question || !winningRule || !stream?.watchUrl) {
    return "Add the audience question, a secure stream link, and an objective winning rule.";
  }

  if (draft.marketType === "stream_event") {
    if (!draft.subject.trim() || !draft.outcomeA.trim() || !draft.outcomeB.trim() || !draft.approvedSource.trim()) {
      return "Add the subject, both outcomes, and the approved evidence source.";
    }
    if (draft.outcomeA.trim().toLowerCase() === draft.outcomeB.trim().toLowerCase()) {
      return "The two outcomes must be different.";
    }
    return null;
  }

  if (
    !draft.participantA.trim() ||
    !draft.participantAAccount.trim() ||
    !draft.participantB.trim() ||
    !draft.participantBAccount.trim()
  ) {
    return "Complete both participants and source accounts.";
  }
  if (draft.participantA.trim().toLowerCase() === draft.participantB.trim().toLowerCase()) {
    return "The two participants must be different.";
  }
  return null;
}

export function buildReviewableDraft(draft, stream, createdAt = new Date().toISOString()) {
  const common = {
    version: "tradermarket-market-draft-v2",
    created_at: createdAt,
    market_type: draft.marketType,
    audience_question: draft.question.trim(),
    stream_url: stream.watchUrl,
    stream_provider: stream.label,
    approved_source: draft.approvedSource.trim(),
    objective_winning_rule: draft.winningRule.trim(),
    resolution: {
      resolver_quorum: "2-of-3 independent resolvers approve identical canonical evidence",
      challenge_required: true,
      challenge_window_seconds: 600,
      unresolved_result: "Invalid",
    },
    status: "operator_review_required",
  };

  if (draft.marketType === "stream_event") {
    return {
      ...common,
      subject: draft.subject.trim(),
      outcomes: [
        { key: "a", label: draft.outcomeA.trim() },
        { key: "b", label: draft.outcomeB.trim() },
      ],
      fees: { liquidity_provider_bps: 30, winning_participant_bps: 0 },
      evidence: {
        schema: "tradermarket.livestream-evidence.v1",
        complete_observation_recording_required: true,
        focused_review_window_max_seconds: 120,
      },
      launch_blockers: [
        "freeze the exact official broadcast session and Observation Window",
        "configure durable evidence storage and operator authentication",
        "archive and hash the complete Observation Window recording",
      ],
    };
  }

  return {
    ...common,
    participants: [
      { label: draft.participantA.trim(), source_account: draft.participantAAccount.trim() },
      { label: draft.participantB.trim(), source_account: draft.participantBAccount.trim() },
    ],
    fees: { liquidity_provider_bps: 30, winning_participant_bps: 100 },
  };
}
