// The REAL event and getter shapes, loaded from the compiled artifacts.
//
// The indexer was originally written against hand-invented log shapes and every
// test passed, because the tests fed it the same inventions. Against real chain
// logs it projected nothing: `RoomCreated` is a factory event, not a room one;
// `SlotsClosed` carries a count rather than a markets array; `ActionSubmitted`
// has no outcome field; and `MarketState` does not exist at all. Reading the
// ABI from the build output makes that class of drift impossible: if a contract
// event changes, decoding fails loudly instead of silently projecting nothing.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_OUT =
  process.env.TM_CONTRACTS_OUT ?? join(HERE, "..", "..", "..", "..", "contracts", "out");

function artifact(name) {
  const path = join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing artifact ${path}. Run \`forge build\` in contracts/ first.`);
  }
  return JSON.parse(readFileSync(path, "utf8")).abi;
}

let cache = null;

export function abis() {
  if (!cache) {
    cache = {
      room: artifact("LiveRoom"),
      market: artifact("LivePredictionMarket"),
      factory: artifact("LiveMarketFactory"),
      commitments: artifact("RoomLiquidityCommitments"),
    };
  }
  return cache;
}

/** Every event the indexer projects, so a log source can filter precisely. */
export const INDEXED_EVENTS = {
  factory: ["RoomCreated", "MarketCreated"],
  room: [
    "SlotPublished",
    "RoomSuspended",
    "RoomReopened",
    "SlotsClosed",
    "RoomClosed",
    "RoomClosedByGateStall",
    "RoomEpochsMarkedSafe",
    "SlotCallSkipped",
    "IntegrityBondPosted",
    "IntegrityBondClaimed",
    "IntegrityBondForfeited",
    "IntegrityClaimFiled",
    "IntegrityClaimAdjudicated",
    "IntegrityClaimExpired",
  ],
  market: [
    "ActionSubmitted",
    "ActionExecuted",
    "ActionRefunded",
    "EpochMarkedSafe",
    "GateSuspended",
    "GateReopened",
    "ForecastingClosed",
    "Trade",
    "PositionTransferred",
    "LiquidityAdded",
    "LpFeesClaimed",
    "PositionsRedeemed",
    "LpInventorySettled",
    "ResultAttested",
    "ProvisionalResultRegistered",
    "ResultChallenged",
    // The chain records whether a challenge was upheld. Without this, a
    // settlement record could say a market was challenged but never how it
    // went — and an Invalid market's reason stayed "unknown" when the chain
    // knew it.
    "ChallengeVerdictAttested",
    "ResultFinalized",
    "WinnerRewardClaimed",
    "InvalidWinnerFeeRefunded",
  ],
};

/** Public getters the indexer reads for state a log cannot carry. */
export const MARKET_STATE_GETTERS = [
  // Immutable display labels frozen into each market at initialization. They
  // are settlement evidence, not presentation copy: a result saying only
  // "Outcome A" does not tell an audience which competitor actually won.
  "participantAName",
  "participantBName",
  // The winning-participant rate is per-market and zero is a valid setting, so
  // it must be read rather than assumed: every surface that quotes "1%" from a
  // constant is guessing on a market configured differently.
  "winnerRewardBps",
  "gateState",
  "reserveA",
  "reserveB",
  "spotPriceA",
  "totalLpShares",
  "winnerRewardPool",
  "pendingCollateral",
  "collateralBacking",
  "unclaimedLpFees",
  "currentEpoch",
  "lastSafeSequence",
  "finalOutcome",
  "provisionalAt",
];

/** Asserts that every event the indexer projects still exists in the ABI. */
export function verifyEventCoverage() {
  const all = abis();
  const missing = [];
  for (const [contract, names] of Object.entries(INDEXED_EVENTS)) {
    const present = new Set(all[contract].filter((entry) => entry.type === "event").map((entry) => entry.name));
    for (const name of names) {
      if (!present.has(name)) missing.push(`${contract}.${name}`);
    }
  }
  const marketFns = new Set(all.market.filter((entry) => entry.type === "function").map((entry) => entry.name));
  for (const getter of MARKET_STATE_GETTERS) {
    if (!marketFns.has(getter)) missing.push(`market.${getter}()`);
  }
  return { ok: missing.length === 0, missing };
}
