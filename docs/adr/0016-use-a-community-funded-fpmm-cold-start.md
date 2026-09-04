---
status: superseded
superseded-by: 0017
supersedes: 0015
amends: 0004, 0010, 0013
---

# Use a community-funded FPMM cold start

The MVP will use a Polymarket-style AMM-first cold start without Protocol Operator liquidity capital. After both Competitors complete readiness, a Community-Funded FPMM enters Awaiting Liquidity at the template's Reference Probability; any eligible wallet except a Competitor or controlled or related wallet may supply native Polygon USDC, and immediate AMM execution begins only after real deposits meet the frozen Liquidity Activation Threshold.

Liquidity Providers may continue adding USDC through the Forecasting Window until the immutable Round start, but every accepted deposit and its non-transferable LP Position remain locked through Resolution or invalidation unless the market never activates and executes its frozen failed-bootstrap refund. Initial deposits establish backed reserves, while later deposits preserve the current reserve ratio and carry any required LP Adjustment Position; fee checkpoints prevent a new provider from claiming fees earned before entry. All 0.3% Liquidity Fees belong to eligible LP Share holders, no protocol vault receives an LP Share, and neither a Reference Probability nor virtual reserves create redeemable claims.

The CLOB remains deferred for the cold start, but all Outcome Positions and Collateral boundaries must remain reusable by a later hybrid router that checks resting orders before the FPMM. This avoids protocol treasury exposure and lets public capital scale with demand, at the cost that an underfunded market cannot promise immediate AMM execution or good depth before community liquidity arrives.

ADR 0017 removes the separate Liquidity Activation Threshold and bootstrap deadline. Under the replacement decision, the first valid public LP deposit makes the per-market FPMM executable immediately, while the Trader Competition's start no longer depends on liquidity arriving.
