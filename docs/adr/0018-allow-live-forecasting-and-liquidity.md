---
status: superseded
superseded-by: 0020
supersedes: 0009
amends: 0004, 0013, 0017
---

# Allow live forecasting and liquidity until the final cutoff

The MVP will keep Forecaster purchases, AMM sales, permitted Outcome Position transfers, and permissionless price-preserving LP additions open before and while a fixed-duration Live Session is running, then lock all four exactly 60 seconds before its immutable scheduled end at the Forecasting Cutoff. Live markets let prices incorporate observed performance and later market makers earn future 0.3% Liquidity Fees; the final cutoff limits result-latency and last-second information advantages without pretending to eliminate them.

Every successful purchase continues to allocate 1% to the whole-market Winner Reward Pool and 0.3% to LPs. Every successful AMM sale deducts a 0.3% Liquidity Fee from its gross USDC output and creates no Winner Reward. An LP joining during the Live Session must enter at the current reserve ratio, receives any required LP Adjustment Position and a fee checkpoint, earns only fees generated after entry, and cannot remove principal before final Resolution or invalidation. Participants, production insiders, and their controlled or related wallets remain prohibited from forecasting or providing liquidity in the connected Competition Market.

The Live Session start still freezes the Participant set, Linked Competition Accounts, performance baseline, rules, and Resolution configuration; it no longer locks the audience market. A transaction submitted before the Forecasting Cutoff but mined at or after it is rejected using the on-chain cutoff timestamp. A postponed Live Session still invalidates its existing Competition Market rather than extending the live market after information has been revealed.

ADR 0019 retains this timestamp model only for Live Competitions that cannot finish early. The corresponding Live Session freezes Participants, Linked Competition Accounts, the Competition Metric, sources, baseline, and schedule; early-ending or unpredictable formats remain out of scope until event-driven suspension exists.

ADR 0020 replaces the scheduled Forecasting Cutoff with a source-driven Market Gate and oracle-cleared Forecasting Epochs for variable-duration Live Competitions.
