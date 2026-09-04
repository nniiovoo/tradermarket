---
status: accepted
supersedes: 0016
amends: 0004, 0010, 0013
amended-by: 0018, 0019, 0020, 0021
---

# Use per-market permissionless FPMM liquidity

Every accepted Live Competition will have one independent Community-Funded FPMM whose real reserves come from eligible public Liquidity Providers. After Participant readiness, the protocol freezes the Live Session timestamps and market terms and creates an empty FPMM at the Competition Template's non-executable Reference Probability. The Protocol Operator supplies no liquidity capital and receives no LP Share.

Any eligible wallet except either Participant, a production insider, or a controlled or related wallet may become the first LP by supplying native Polygon USDC. The first valid deposit creates fully backed equal complete-set reserves at the MVP's frozen 50/50 Reference Probability and makes audience AMM execution available immediately. There is no separate funding stage, bootstrap deadline, or Liquidity Activation Threshold. If no LP arrives, the Live Competition may still run and resolve, but its audience market remains non-executable.

Each later deposit must preserve the current reserve ratio, receives proportional non-transferable LP Shares and any required LP Adjustment Position, and starts earning only future Liquidity Fees through a fee checkpoint. Under ADR 0020, community additions may enter pending Forecasting Epochs while the Market Gate is Open and become effective only after a Safe Event Watermark clears the epoch; every cleared LP Position remains locked through Resolution or invalidation. LPs receive all 0.3% purchase and sale Liquidity Fees pro rata and bear the same proportion of resolved AMM inventory gains or losses. Neither fees nor the protocol guarantee principal or profit.

Pool size determines depth, not a hard cap on cumulative volume. A shallow FPMM quotes increasingly unfavorable prices for large one-sided trades. The contract therefore enforces each Forecaster's signed minimum output and deadline, while the UI discloses liquidity, average execution price, price impact, resulting Implied Probability, fees, and maximum loss. The MVP has no protocol-wide 5% price-impact rejection; unusually high impact requires explicit user confirmation.

The CLOB remains deferred. A later hybrid router may execute better-priced resting orders before routing residual quantity to the same market-specific FPMM and fully backed Outcome Positions.

Historical evidence and the complete reasoning are recorded in [Polymarket FPMM Liquidity Research and Livestream Competition Strategy](../product/polymarket-fpmm-liquidity-strategy.md).

ADR 0020 applies the same per-market liquidity model to one Competition Market per variable-duration Live Session. Participant and production-insider wallets remain prohibited.
