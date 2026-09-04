---
status: accepted
supersedes: 0018, 0019
amends: 0004, 0006, 0011, 0013, 0017
amended-by: 0021, 0022, 0023, 0024, 0025
---

# Use event-driven market gating for variable-duration livestream competitions

The MVP will support objectively resolved, one-versus-one Live Competitions whose end time is unknown. Each Competition Template freezes an Official Result Source, terminal condition, monotonic source sequence, data-freshness rule, Source Finality Delay, Forecasting Epoch policy, and Market Gate before forecasting opens; the Livestream remains non-authoritative, and trading does not depend on a scheduled end or 60-second cutoff.

Purchases, sales, permitted Outcome Position transfers, and price-preserving LP additions submitted while the Market Gate is Open remain pending within a short Forecasting Epoch. After the frozen Source Finality Delay, the FPMM applies them in deterministic submission order only when a signed Safe Event Watermark proves that no Decisive Event occurred through that epoch; minimum-output protection still applies, and any action that cannot clear receives its escrowed assets back without a Winner Reward Fee or Liquidity Fee.

A stale source suspends the Market Gate and accepts no new actions. When the Official Result Source reports a Decisive Event, Forecasting Close becomes irreversible, the overlapping and later uncleared epochs are voided and refunded, and only previously cleared market state proceeds to Resolution. This adds execution delay, escrow, source-attestation, and batch-finalization complexity, but it prevents an audience member from receiving an irreversible AMM trade after seeing the winning moment and before the result oracle reaches Polygon.
