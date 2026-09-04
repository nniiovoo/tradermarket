---
status: superseded
superseded-by: 0018
---

# Close the Forecasting Window before the Round

Every MVP Winner Market will allow Outcome Position purchases, sales, and transfers only before its immutable Round start, then lock those actions and all liquidity changes until Resolution or invalidation. Although live trading could improve volume and price discovery during longer Horizons, one pre-Round rule keeps all four Horizons consistent, prevents partial live performance and source latency from becoming tradable advantages, and makes the first market and AMM substantially easier to secure; a postponed competition invalidates the market instead of extending the window after information has been revealed.

ADR 0018 replaces this pre-Round-only rule with live forecasting and permissionless liquidity additions through the immutable Forecasting Cutoff 60 seconds before the Round ends.
