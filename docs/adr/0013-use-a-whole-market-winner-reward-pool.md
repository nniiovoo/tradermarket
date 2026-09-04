---
status: accepted
supersedes: 0008
amended-by: 0016, 0017, 0018, 0019, 0020, 0021
---

# Use a whole-market Winner Reward Pool

Every successful AMM purchase charges a 1% Winner Reward Fee and a separate 0.3% Liquidity Fee. Every successful AMM sale deducts a 0.3% Liquidity Fee from gross USDC output and creates no Winner Reward. The Winner Reward Fee from purchases of either Participant's Outcome Position enters one market-level Winner Reward Pool; it is not attributed to the selected side. After final Resolution, the final Winner receives the whole pool, and an exact tie divides it using the same 50/50 payout vector used for Outcome Position Redemption. No reward can be claimed from a Provisional Result. An Invalid Market returns the Winner Reward Fees to their original fee payers.

The 0.3% Liquidity Fee belongs proportionally to eligible community LP Share holders under ADRs 0017 and 0018; the Protocol Operator supplies no liquidity capital, receives no LP Share, and takes no separate platform trading fee. For a 100 USDC total purchase budget, 98.70 USDC enters the Outcome Position trade, 1.00 USDC enters the Winner Reward Pool, and 0.30 USDC enters the Liquidity Fee bucket; the separately quoted USDC Gas Charge remains outside this market-fee calculation. The Liquidity Fee treatment when a market is invalid was deferred here and is now frozen by [ADR 0026](0026-keep-liquidity-fees-and-refund-winner-reward-fees-on-an-invalid-market.md): the Winner Reward Fee is refunded because it funded a reward nobody won, and the Liquidity Fee is retained because it paid for liquidity that was supplied and inventory risk that was borne regardless of how the market ended.

Winner Reward funds remain separate from Outcome Position backing, Liquidity Provider capital, Integrity Bonds, gas reimbursement, and Participant assets. Paying the reward must never reduce Forecaster Redemption or refund entitlements. Participants, production insiders, and their disclosed controlled or related wallets may hold no direct or indirect Outcome Position or LP Share in the connected Competition Market. Each Participant must still post the separate Integrity Bond, which may be forfeited only for an objectively proven, pre-published violation rather than suspected intent or poor performance.

ADR 0019 also prohibits disclosed production insiders from Outcome Positions and LP Shares in the connected Live Competition. The fee percentages and whole-market reward logic are unchanged.
