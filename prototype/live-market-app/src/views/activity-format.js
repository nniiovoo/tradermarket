const OUTCOME_COPY = {
  outcome_a: "Outcome A",
  outcome_b: "Outcome B",
  tie: "Tie — both sides redeem at 0.5",
  invalid: "Invalid — collateral returned",
  unset: "Not resolved",
};

/**
 * Turns the one Unix timestamp in the settlement timeline into an explicit UTC
 * date. Other timeline evidence (source sequences and block numbers) is already
 * human-readable and must remain byte-for-byte unchanged.
 */
export function formatTimelineMoment(stage, at) {
  if (at === null || at === undefined || at === "") return null;
  const value = String(at);
  if (stage !== "opened" || !/^\d+$/.test(value)) return value;

  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;

  return `${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function blockNumber(value) {
  const match = String(value ?? "").match(/^block\s+(\d+)$/i);
  return match ? Number(match[1]) : null;
}

/**
 * Old projections may not have the immutable finalization event yet. If their
 * guessed final block is later than a claim that necessarily happened after
 * finalization, hide the bad timestamp instead of drawing an impossible chain
 * chronology. A rebuilt projection restores the proven event block.
 */
export function honestTimeline(stages = [], claims = []) {
  const creditBlocks = [
    ...claims.map((claim) => Number(claim?.block_number)).filter(Number.isFinite),
    ...stages
      .filter((stage) => stage.stage === "credited")
      .map((stage) => blockNumber(stage.at))
      .filter(Number.isFinite),
  ];
  const earliestCredit = creditBlocks.length ? Math.min(...creditBlocks) : null;
  return stages.map((stage) => {
    const finalBlock = stage.stage === "final" ? blockNumber(stage.at) : null;
    return earliestCredit !== null && finalBlock !== null && finalBlock > earliestCredit
      ? { ...stage, at: null }
      : stage;
  });
}

/** A human winner name when the settlement API has evidence; protocol A/B otherwise. */
export function settlementResultLabel(resolution = {}, participants = {}) {
  const outcome = resolution.outcome_label ?? "unset";
  if (outcome === "outcome_a") {
    const winner = resolution.winner_name || participants.a;
    return winner ? `${winner} won` : OUTCOME_COPY.outcome_a;
  }
  if (outcome === "outcome_b") {
    const winner = resolution.winner_name || participants.b;
    return winner ? `${winner} won` : OUTCOME_COPY.outcome_b;
  }
  return OUTCOME_COPY[outcome] ?? "Unknown outcome";
}
