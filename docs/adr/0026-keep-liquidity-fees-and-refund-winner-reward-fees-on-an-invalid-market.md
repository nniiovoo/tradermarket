---
status: accepted
amends: 0013
---

# Keep Liquidity Fees and refund Winner Reward Fees on an Invalid Market

ADR 0013 recorded the Liquidity Fee treatment for an Invalid Market as
"deliberately deferred and must be frozen before implementation". It was in fact
already decided in code, and had been for some time. This ADR freezes the
implemented rule and states its reasoning, because a money rule that exists only
as a code path is a rule nobody agreed to.

## Decision

When a market settles `Invalid`, the two fees are treated differently:

- **The 1% Winner Reward Fee is refunded** to whoever paid it, through
  `claimInvalidWinnerFeeRefund`. It is drawn from `winnerRewardPool`, which only
  exists to pay a winner. An Invalid market has no winner, so the pool funds
  nothing and the money goes back.
- **The 0.3% Liquidity Fee is retained by the Liquidity Providers.**
  `claimLpFees` has no dependence on `finalOutcome`; accrued fees remain
  claimable in full.

Outcome Positions themselves settle at `(amountA + amountB) / 2` per pair, which
is the refund: every forecaster is made whole on the collateral they committed,
minus the liquidity fee they paid at the time of the trade.

## Why the two differ

The Winner Reward Fee is a **prepayment for an outcome**. It buys a share of a
reward pool contingent on a result. No result, no service rendered, so it is
returned.

The Liquidity Fee is a **payment for a service already delivered**. The LP
supplied collateral, took the other side of every trade, and carried inventory
risk for the whole life of the market. A forecaster who bought and sold at a
profit during a market that was later invalidated keeps that profit; the LP who
made those trades possible carried the matching risk. Clawing the fee back would
mean the LP financed the market for free, and would make providing liquidity to
any market with invalidation risk strictly worse than not providing it — which
is precisely the liquidity a source-gated market most needs and is least likely
to attract.

Invalidation is also not rare by design. ADR 0011 makes it the fail-closed
outcome whenever source data cannot be verified. A fee rule that punished LPs for
the safety mechanism firing would put LP incentives directly against the
protocol's own honesty.

## Consequences

- LPs are paid for markets that resolve to nothing. This is intended.
- A forecaster refunded on an Invalid Market receives slightly less than they
  committed, by the liquidity fee they paid. **This must be disclosed in the
  interface wherever an Invalid refund is explained**, so a refunded forecaster
  learns it from the product rather than by reconciling against the contract.
- The rule is pinned by
  `testInvalidMarketRefundsTheWinnerFeeAndRetainsTheLiquidityFee`, which asserts
  both halves together. Either alone reads as an oversight; together they are a
  rule.
- ADR 0013's deferral is superseded.
