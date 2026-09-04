// P1: the portfolio, prediction, transaction, payout and settlement history.
//
// Every number here is an indexed chain fact. That constraint decides the shape
// of this module more than anything else:
//
//   - An open position has a size and a side, and no payout or profit field.
//     The market has not settled, so any figure we printed there would be a
//     forecast wearing the clothes of a receipt.
//   - "Claimed" and "claimable" are kept apart. Redeeming zeroes the holding on
//     chain, so a settled market where the holding survives is money genuinely
//     still waiting for its owner.
//   - An Invalid market is a return of collateral, not a loss, and says so.
//
// Amounts stay BigInt scale-6 all the way to the HTTP boundary, where the
// server serializes them as strings.

const OUTCOME_LABEL = { 0: "unset", 1: "outcome_a", 2: "outcome_b", 3: "tie", 4: "invalid" };

const CLAIM_LABEL = {
  redeem: "Winning position redeemed",
  lp_inventory: "LP inventory settled",
  lp_fees: "LP fees claimed",
  winner_reward: "Winning-participant reward",
  winner_fee_refund: "Winner-fee refund on an invalid market",
};

const lower = (value) => String(value ?? "").toLowerCase();

/** The contract's fee-per-share fixed-point scale. */
const FEE_SCALE = 10n ** 18n;

/**
 * Whether anything is actually owed on a settled market.
 *
 * Every claim on this contract is a separate transaction taken by its owner, so
 * "settled" is never one flag. Four rules decide it, and two of them cannot be
 * inferred from events at all:
 *
 *   - `redeemPositions` pays `_resolvedValue(amountA, amountB)`, zero for a
 *     purely losing holder — so nobody redeems and the losing holding survives
 *     on chain forever. Treating that as money waiting would show someone who
 *     lost every market a page of claim prompts. Only a tie and an Invalid
 *     market pay both sides.
 *   - `settleLpInventory` zeroes `lpSharesOf`, so LP shares alone under-report.
 *   - `claimLpFees` pays `lpFeeCredit`, which `settleLpInventory` *accrues into
 *     and never clears*. So "has claimed fees before" says nothing about now: an
 *     LP who claimed mid-market and then settled is still owed the accrual, and
 *     an LP of a market that never traded is owed nothing at all — the call
 *     reverts `NothingToClaim`. Only the balance itself answers this.
 *   - `claimInvalidWinnerFeeRefund` is gated on `winnerFeePaid > 0` alone: no
 *     position and no shares required. But `winnerFeePaid` only accrues where
 *     the market charges the fee, and a rate of zero bps is a valid
 *     configuration — so "made a buy" does not imply a refund exists either.
 *
 * Both are public per-account getters, so this reads them rather than guessing.
 * Where no reader is configured the answer is `null` — not known — because
 * "nothing owed" and "we cannot see" are different things to tell someone
 * looking for their money.
 */
function hasSomethingToClaim(outcome, positionA, positionB, lpShares, owed) {
  const positionsOwed =
    outcome === 3 || outcome === 4
      ? positionA > 0n || positionB > 0n
      : outcome === 1
        ? positionA > 0n
        : outcome === 2
          ? positionB > 0n
          : false;

  if (positionsOwed || lpShares > 0n) return true;
  if (!owed.known) return null;
  return owed.lp_fees > 0n || owed.winner_fee_refund > 0n;
}

/**
 * What the refund call would actually pay.
 *
 * `claimInvalidWinnerFeeRefund` reverts `InvalidState` unless the market
 * resolved Invalid — and `winnerFeePaid` is only ever zeroed by that same call.
 * So on every decisive outcome the balance stays permanently non-zero and
 * permanently unclaimable: reading it as owed would show every fee-paying
 * trader money that does not exist, forever, winner and loser alike.
 */
function refundableWinnerFee(outcome, winnerFeePaid) {
  return outcome === 4 ? winnerFeePaid : 0n;
}

/** Whether this holder backed the side that won. */
function heldTheLosingSide(outcome, positionA, positionB) {
  if (outcome === 1) return positionA === 0n && positionB > 0n;
  if (outcome === 2) return positionB === 0n && positionA > 0n;
  return false;
}

/** The market's winning-participant rate, as a percentage, when it is known. */
function rewardRate(bps) {
  if (bps === null || bps === undefined) return null;
  const value = Number(bps) / 100;
  return Number.isFinite(value) ? `${Number(value.toFixed(2))}%` : null;
}

/**
 * Why a settled market still shows a claim button, in the reader's terms.
 *
 * `claimable` is tri-state: true, false, or null for "this build cannot see the
 * per-account balances". The copy never names a fee rate the market did not
 * charge — the rate is per-market and zero is a valid setting.
 */
function settledDetail({ outcome, claimable, lost = false, owed, rewardBps, refunded = false, claimed = 0n }) {
  const rate = rewardRate(rewardBps);
  const feePhrase = rate ? `the ${rate} winning-participant reward you paid` : "any winning-participant reward you paid";

  if (claimable === null) {
    return "Resolved. Whether anything is still owed to you here cannot be read by this build, so it is not stated either way — open the market to check.";
  }

  if (outcome === 4) {
    if (claimable) {
      return owed?.winner_fee_refund > 0n
        ? `Invalid market: ${feePhrase} is waiting to be refunded. Positions redeem at half each and the refund is claimed separately — claiming one does not claim the other.`
        : "Invalid market: your collateral is waiting to be returned — positions redeem at half each.";
    }
    // Only what this account actually did. "Collateral was returned" and
    // "everything owed has been claimed" are both claims about claims — with a
    // claimed total of zero they contradict the row they sit in.
    if (refunded) {
      return `Invalid market: collateral was returned and ${feePhrase} was refunded. A missing result never becomes a default win.`;
    }
    return claimed > 0n
      ? "Invalid market: everything owed here has been claimed. A missing result never becomes a default win."
      : "Invalid market: nothing is owed to this address here. A missing result never becomes a default win.";
  }
  if (outcome === 3) {
    if (claimable) return "Tie: both sides redeem at 0.5. Your redemption has not been claimed yet.";
    return claimed > 0n
      ? "Tie: your redemption at 0.5 has been claimed."
      : "Tie: both sides redeem at 0.5. Nothing is owed to this address here.";
  }
  if (outcome === 0) return "This market has not been resolved.";
  if (lost) {
    return "Resolved against this position: it did not win, so there is nothing to claim. Nothing further is owed here.";
  }
  if (!claimable) return "Resolved and settled.";
  if (owed?.lp_fees > 0n) {
    return "Resolved. Your liquidity fee credit is still unclaimed — it survives inventory settlement and is claimed separately.";
  }
  return "Resolved. Anything owed to you is still unclaimed — claims are always made by their owner.";
}

export class Portfolio {
  /**
   * @param options.store         ProjectionStore
   * @param options.accountReader optional port:
   *        `readAccountState(market, account) => { lpFeeCredit, winnerFeePaid }`
   *        Both are public per-account getters on the market contract and no
   *        event carries them, so without this port those balances are reported
   *        as unknown rather than as zero.
   */
  constructor({ store, accountReader = null }) {
    this.store = store;
    this.accountReader = accountReader;
  }

  /**
   * The two per-account balances that decide what is still owed.
   *
   * `known: false` where no reader is configured: "nothing owed" and "we cannot
   * see" are different things to tell someone looking for their money.
   */
  async _owed(market, account, outcome) {
    if (!this.accountReader) return { known: false, lp_fees: 0n, winner_fee_refund: 0n };
    try {
      // Normalised: a caller's casing must not decide whether anyone's balances
      // can be read, and a mixed-case address that is not valid EIP-55 makes
      // the chain client throw.
      const state = await this.accountReader.readAccountState(market, lower(account));
      const credit = BigInt(state?.lpFeeCredit ?? 0n);
      // `claimLpFees` calls `_accrueLp` *first*, moving
      // `shares * feePerShare / SCALE - debt` into the credit before paying it.
      // Reading only the stored credit reports nothing owed while the call
      // would transfer real collateral.
      const shares = BigInt(state?.lpShares ?? 0n);
      const feePerShare = BigInt(state?.feePerShare ?? 0n);
      const debt = BigInt(state?.lpFeeDebt ?? 0n);
      const accumulated = (shares * feePerShare) / FEE_SCALE;
      const pending = accumulated > debt ? accumulated - debt : 0n;
      return {
        known: true,
        lp_fees: credit + pending,
        winner_fee_refund: refundableWinnerFee(outcome, BigInt(state?.winnerFeePaid ?? 0n)),
      };
    } catch {
      // A failed read is unknown, never zero.
      return { known: false, lp_fees: 0n, winner_fee_refund: 0n };
    }
  }

  async of(account) {
    const key = lower(account);
    const holdings = this.store.listAccountHoldings(account);
    const claims = this.store.listClaims(account);
    const trades = this.store.listTrades().filter((row) => lower(row.account) === key);

    const claimedByMarket = new Map();
    const refundedByMarket = new Set();
    for (const claim of claims) {
      const market = lower(claim.market_address);
      claimedByMarket.set(market, (claimedByMarket.get(market) ?? 0n) + BigInt(claim.amount ?? 0n));
      if (claim.kind === "winner_fee_refund") refundedByMarket.add(market);
    }

    const open = [];
    const settled = [];
    const liquidity = [];

    // A settled market can appear here through a holding that survived
    // settlement or through a claim already taken; both belong in the history.
    const marketIds = new Set([
      ...holdings.map((row) => lower(row.market_address)),
      ...claims.map((row) => lower(row.market_address)),
      ...trades.map((row) => lower(row.market_address)),
    ]);

    for (const market of marketIds) {
      const row = this.store.getMarket(market);
      const outcome = Number(row?.final_outcome ?? 0);
      const holding = holdings.find((entry) => lower(entry.market_address) === market) ?? null;
      const positionA = BigInt(holding?.position_a ?? 0n);
      const positionB = BigInt(holding?.position_b ?? 0n);
      const lpShares = BigInt(holding?.lp_shares ?? 0n);
      const question = row?.question ?? "";

      if (lpShares > 0n) {
        liquidity.push({ market, question, lp_shares: lpShares, room_id: row?.room_id ?? null });
      }

      if (outcome === 0) {
        // Unresolved: report the position, and nothing that looks like a result.
        for (const [size, side] of [
          [positionA, "outcome_a"],
          [positionB, "outcome_b"],
        ]) {
          if (size > 0n) {
            open.push({
              market,
              question,
              room_id: row?.room_id ?? null,
              slot_index: row?.slot_index ?? null,
              side,
              size,
              implied_prob_a: row?.implied_prob_a ?? null,
              route: `/activity/${market}`,
            });
          }
        }
        continue;
      }

      // The two balances no event carries, read from the contract when a
      // reader is configured.
      const owed = await this._owed(market, account, outcome);
      const claimable = hasSomethingToClaim(outcome, positionA, positionB, lpShares, owed);
      const held = positionA > 0n || positionB > 0n || lpShares > 0n;
      // A position that lost is still part of this address's history. It has
      // nothing to claim, but dropping it would make someone's prediction
      // disappear from their own record.
      if (!held && !claimedByMarket.has(market) && !trades.some((t) => lower(t.market_address) === market)) {
        continue;
      }
      settled.push({
        market,
        question,
        room_id: row?.room_id ?? null,
        slot_index: row?.slot_index ?? null,
        outcome_label: OUTCOME_LABEL[outcome] ?? "unknown",
        held_a: positionA,
        held_b: positionB,
        claimed: claimedByMarket.get(market) ?? 0n,
        claimable,
        owed: owed.known ? { lp_fees: owed.lp_fees, winner_fee_refund: owed.winner_fee_refund } : null,
        detail: settledDetail({
          outcome,
          claimable,
          lost:
            heldTheLosingSide(outcome, positionA, positionB) &&
            lpShares === 0n &&
            owed.known &&
            owed.lp_fees === 0n &&
            owed.winner_fee_refund === 0n,
          owed,
          rewardBps: row?.winner_reward_bps ?? null,
          refunded: refundedByMarket.has(market),
          claimed: claimedByMarket.get(market) ?? 0n,
        }),
        route: `/activity/${market}`,
      });
    }

    const transactions = [
      ...trades.map((trade) => ({
        type: "trade",
        block_number: Number(trade.block_number ?? 0),
        market: lower(trade.market_address),
        kind: trade.is_buy ? "buy" : "sell",
        side: trade.outcome_a ? "outcome_a" : "outcome_b",
        amount_in: BigInt(trade.amount_in ?? 0n),
        amount_out: BigInt(trade.amount_out ?? 0n),
        summary: trade.is_buy
          ? `Bought ${trade.outcome_a ? "Outcome A" : "Outcome B"}`
          : `Sold ${trade.outcome_a ? "Outcome A" : "Outcome B"}`,
        route: `/activity/${lower(trade.market_address)}`,
      })),
      ...claims.map((claim) => ({
        type: "claim",
        block_number: Number(claim.block_number ?? 0),
        market: lower(claim.market_address),
        kind: claim.kind,
        amount: BigInt(claim.amount ?? 0n),
        summary: CLAIM_LABEL[claim.kind] ?? claim.kind,
        route: `/activity/${lower(claim.market_address)}`,
      })),
    ].sort((a, b) => b.block_number - a.block_number);

    const byKind = new Map();
    for (const claim of claims) {
      const kind = claim.kind;
      byKind.set(kind, (byKind.get(kind) ?? 0n) + BigInt(claim.amount ?? 0n));
    }
    const totalCredited = [...byKind.values()].reduce((sum, amount) => sum + amount, 0n);
    const feesClaimed = byKind.get("lp_fees") ?? 0n;

    return {
      account: key,
      predictions: {
        open: open.sort((a, b) => (b.size === a.size ? 0 : b.size > a.size ? 1 : -1)),
        open_note:
          "These markets have not settled. The size shown is the position you hold, not a payout: nothing is owed until the approved source decides the question.",
        settled: settled.sort((a, b) => Number(b.slot_index ?? 0) - Number(a.slot_index ?? 0)),
        // Only what is provably claimable. An unknown is not a prompt.
        claimable_count: settled.filter((row) => row.claimable === true).length,
        unknown_count: settled.filter((row) => row.claimable === null).length,
      },
      transactions,
      payouts: {
        total_credited: totalCredited,
        by_kind: [...byKind.entries()].map(([kind, amount]) => ({
          kind,
          amount,
          label: CLAIM_LABEL[kind] ?? kind,
        })),
        note: "Credited totals come from claim events on chain. Nothing is counted before its owner claims it.",
      },
      liquidity: {
        positions: liquidity,
        fees_claimed: feesClaimed,
        note: "Liquidity earns the 0.3% fee on every trade and carries inventory risk: an LP position can settle for less than it cost.",
      },
      empty_reason:
        open.length === 0 && settled.length === 0 && transactions.length === 0
          ? "No positions, trades or claims are recorded on chain for this address yet."
          : null,
    };
  }
}
