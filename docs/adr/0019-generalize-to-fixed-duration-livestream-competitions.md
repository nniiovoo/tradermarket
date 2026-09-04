---
status: superseded
superseded-by: 0020
supersedes: 0002, 0007, 0010, 0014
amends: 0004, 0006, 0011, 0013, 0017, 0018
---

# Generalize the product to fixed-duration livestream competitions

The product will generalize from trader-only contests to fixed-duration, objectively scored, one-versus-one Live Competitions that an audience can watch through a Livestream. A trading battle may return later as one Competition Template, but neither external trading accounts, Binance and Hyperliquid connectors, nor net-USD portfolio return remain universal MVP requirements.

The Livestream is a presentation surface and never an Official Result Source. Every approved Competition Template must freeze an independently verifiable Competition Source, Source Policy, Competition Metric, scheduled start and end, and invalidation rule before its Competition Market opens. Arbitrary subjective questions and competitions that can finish early are excluded from the MVP because the existing timestamp-based Forecasting Cutoff cannot prevent trading after an unpredictable decisive moment; those formats require a later event-driven suspension and latency-control design.

The existing on-chain market model remains: one binary Competition Market and independent Community-Funded FPMM per Live Session, permissionless eligible LP participation, native Polygon USDC Collateral, a 1% whole-market Winner Reward Fee on purchases, a 0.3% Liquidity Fee on purchases and sales, gas abstraction, participant and production-insider market prohibitions, objective Resolution, and a Forecasting Cutoff exactly 60 seconds before the scheduled end.

ADR 0020 retains the livestream generalization but replaces the fixed-duration restriction and timestamp cutoff with variable-duration, event-driven market gating.
