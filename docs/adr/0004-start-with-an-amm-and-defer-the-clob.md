---
status: accepted
amended-by: 0016, 0017, 0018, 0019, 0020
---

# Start with an AMM and defer the CLOB

The MVP will use a simple on-chain fixed-product AMM for Outcome Position liquidity and price discovery, while a Polymarket-style CLOB is deferred until user volume and professional liquidity justify its matching, relayer, and market-maker infrastructure. This reduces prototype complexity and keeps trading auditable on Polygon, at the cost of greater slippage and less capital-efficient pricing than a mature order book, plus a later liquidity-migration path when the CLOB is introduced.

ADRs 0017 and 0020 contain the current cold-start and live-execution model: every market has an independent FPMM, the protocol supplies no liquidity capital, the first cleared eligible community deposit makes AMM execution available, and later price-preserving additions may enter source-cleared Forecasting Epochs while the Market Gate is Open. The same Outcome Positions and Collateral boundary must support a later hybrid router when a CLOB is introduced.

ADR 0020 applies this mechanism to each variable-duration Live Session's Competition Market; the market engine is no longer specific to trader competitions.
