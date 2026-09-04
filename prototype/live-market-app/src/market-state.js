/**
 * Whether a market can accept a new position right now.
 *
 * This is the highest-consequence rendering decision in the app. Offering a buy
 * button on a market that cannot accept one takes someone's intent and produces
 * nothing; offering it on a settled market invites them to back a result that is
 * already known.
 *
 * So the rule is an allow-list of one: a slot the chain reports as `open`. A
 * state this build has never heard of — a new one added to the protocol later —
 * fails closed, because the alternative is a build that silently starts selling
 * positions in a state nobody has thought about.
 */

/** The only slot state in which the chain accepts a new action. */
const TRADABLE_SLOT_STATE = "open";

/** Gate states, for the standalone-market path that has no room slot. */
export const GATE_OPEN = 0;

export function marketIsTradable(market) {
  if (!market) return false;

  // A resolved market is closed regardless of anything else it reports.
  if (Number(market.finalOutcome ?? 0) !== 0) return false;

  if (typeof market.state === "string" && market.state.length > 0) {
    return market.state === TRADABLE_SLOT_STATE;
  }

  // Standalone market: no slot, so the gate state is what there is.
  if (market.gateState !== undefined && market.gateState !== null) {
    return Number(market.gateState) === GATE_OPEN;
  }

  return false;
}

/**
 * Adding liquidity is meaningful while a room question is waiting for its
 * first LP or is open. Once the source closes the question, a new queued
 * deposit can only be refunded, so the interface must not invite it.
 */
export function marketAcceptsLiquidity(market) {
  if (!market || Number(market.finalOutcome ?? 0) !== 0) return false;
  if (typeof market.state === "string" && market.state.length > 0) {
    return market.state === "awaiting-liquidity" || market.state === "open";
  }
  return Number(market.gateState) === GATE_OPEN;
}

/**
 * Copy for a room card must follow the chain state it represents. In
 * particular, a settled result must never be advertised as something a reader
 * can still predict.
 */
export function marketCardPresentation(market) {
  switch (market?.state) {
    case "open":
      return { category: "Live question", action: "Watch & predict" };
    case "final":
      return { category: "Final result", action: "View settlement" };
    case "invalid":
      return { category: "Invalid market", action: "View refund record" };
    case "announced":
    case "awaiting-liquidity":
      return { category: "Upcoming question", action: "View question" };
    case "suspended":
    case "recovering":
      return { category: "Paused question", action: "View status" };
    case "closed":
    case "provisional":
    case "challenged":
      return { category: "Forecasting closed", action: "View resolution" };
    default:
      return { category: "Market question", action: "View question" };
  }
}

/** A section heading that truthfully describes the cards below it. */
export function marketSectionTitle(markets = []) {
  if (markets.some((market) => marketIsTradable(market))) return "Happening now";
  if (markets.some((market) => ["announced", "awaiting-liquidity"].includes(market?.state))) {
    return "Upcoming questions";
  }
  if (markets.some((market) => ["final", "invalid"].includes(market?.state))) return "Recently settled";
  return "Live questions";
}
