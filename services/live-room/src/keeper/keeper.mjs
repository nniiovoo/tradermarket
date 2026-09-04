// The keeper: the process that finalizes markets so people can be paid.
//
// Every payout path on the market contract is `onlyFinal` — `redeemPositions`,
// `settleLpInventory`, `claimWinnerReward`, `claimInvalidWinnerFeeRefund` and
// `claimIntegrityBond` all revert until `finalOutcome != Unset`. Three
// permissionless functions move a market to final, and until this role existed
// nothing in production called any of them: the only callers in the repository
// were two game-day harnesses, the prototype's manual buttons, and a
// break-glass CLI. A market whose challenge window had elapsed sat unresolved
// with everyone's collateral behind it until a human noticed.
//
// Nothing was ever *trapped* — the functions are permissionless, so a stranger
// could always have called them. It was *unattended*, which in a settlement
// system is its own kind of broken: the time from "the result is known" to "the
// money is claimable" had no upper bound and no owner.
//
// A keeper is a LIVENESS role, not an authority. It holds a key only because
// sending a transaction costs gas, and its allow-list contains nothing that
// decides anything: it cannot attest a result, publish a market, gate an epoch,
// or close a room. If this key leaks, the worst an attacker can do is finalize
// markets that were already finalizable — which is the keeper's whole job.
//
// The governing rule, and the reason this file is mostly a single pure
// function: THE CONTRACT DECIDES WHEN. The keeper only ever calls a function
// the contract would already accept, computes nothing the contract does not
// compute, and treats a revert as a normal answer to "is it time yet?" rather
// than an incident. A keeper that decided timing for itself would be a second,
// weaker implementation of the same rule, and the two would eventually
// disagree.

/** Outcome enum values shared with the contract. `Unset` is the only one this needs. */
const UNSET = 0;

/**
 * Which finalization call, if any, the contract would accept for this market
 * right now.
 *
 * Mirrors `LivePredictionMarket.sol:772-793` exactly, in the same order and
 * with the same comparisons. Kept pure and exported so the decision can be
 * tested against every boundary without a chain, and so the correspondence to
 * the contract can be read side by side rather than inferred from behaviour.
 *
 * @param state from `chain.settlementStateOf(market)`
 * @param nowS  CHAIN time in seconds, never wall-clock — the contract compares
 *              against `block.timestamp`, and a keeper reading its own clock
 *              would send transactions that revert every time the two drifted.
 * @returns the method name to call, or null when nothing is due
 */
export function dueAction(state, nowS) {
  // Already settled. `closedSlots()` filters these out on both ports, so this
  // is belt-and-braces — but the cost of being wrong here is a wasted
  // transaction on every tick, forever.
  if (Number(state.finalOutcome) !== UNSET) return null;

  // Challenged markets first, and they are exclusive: a challenged market can
  // NEVER be finalized on its provisional outcome, only expired to Invalid.
  // Checking `provisionalOutcome` first would finalize the market that the
  // bonded challenge exists to dispute — the audience's bond would buy them
  // nothing, and the contract's own `!challenged` guard is the only thing that
  // would have stopped it.
  if (state.challenged) {
    return nowS >= Number(state.challengedAt) + Number(state.challengeTimeout) ? "expireChallenge" : null;
  }

  // Quorum was reached and nobody disputed it inside the window.
  if (Number(state.provisionalOutcome) !== UNSET) {
    return nowS >= Number(state.provisionalAt) + Number(state.challengeWindow) ? "finalizeUnchallenged" : null;
  }

  // Closed, but no result was ever registered — nobody attested, or the
  // resolvers never agreed. Past the deadline this fails closed to Invalid and
  // everyone gets their collateral back.
  //
  // `resolutionDueAt > 0` is not redundant. The contract sets it when the
  // market closes, so a real closed market always has one — but a zero here
  // means the read did not tell us what we think it did, and `nowS >= 0` is
  // always true. Invalidating a market destroys its outcome and refunds every
  // position; doing that because a getter returned a default would be the worst
  // bug this file could contain.
  const dueAt = Number(state.resolutionDueAt);
  if (state.gateState === "closed" && dueAt > 0 && nowS >= dueAt) return "invalidateUnresolved";

  return null;
}

export class KeeperService {
  /**
   * @param options.chain    a room chain port, with its OWN key
   * @param options.chainNow async () => chain time in seconds
   */
  constructor({ chain, chainNow }) {
    if (!chain) throw new Error("the keeper needs a chain port");
    if (typeof chainNow !== "function") throw new Error("the keeper needs a chain clock");
    this.chain = chain;
    this.chainNow = chainNow;
  }

  /**
   * One pass over every closed, unfinalized market in the room.
   *
   * Returns what it did rather than logging, so the operator runner decides how
   * to report and the tests can assert on it. A market that reverted appears in
   * the same list with an `error` — it is an outcome, not an exception, and one
   * market refusing must never stop the rest of the room from settling.
   */
  async tick() {
    const nowS = Number(await this.chainNow());
    // Both chain ports filter this to closed markets with no final outcome, so
    // a finalized market leaves the work set on its own and is never revisited.
    const slots = await this.chain.closedSlots();
    const actions = [];

    for (const slot of slots) {
      let state;
      try {
        state = await this.chain.settlementStateOf(slot.market);
      } catch (error) {
        actions.push({ market: slot.market, action: null, error: oneLine(error) });
        continue;
      }

      const action = dueAction(state, nowS);
      if (!action) continue;

      try {
        await this.chain[action](slot.market, nowS);
        actions.push({ market: slot.market, action });
      } catch (error) {
        // Expected often enough to be unremarkable: another keeper, a resolver,
        // or any passer-by may have got there first, and a chain a second
        // behind our read will simply say TooEarly. Recorded, retried next
        // tick, never fatal.
        actions.push({ market: slot.market, action, error: oneLine(error) });
      }
    }

    return { actions };
  }
}

/** A revert reason belongs in a log line, not a stack trace repeated every 5s. */
function oneLine(error) {
  return String(error?.shortMessage ?? error?.message ?? error ?? "unknown failure").split("\n")[0].trim();
}
