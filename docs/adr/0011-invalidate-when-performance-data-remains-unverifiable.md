---
status: accepted
amended-by: 0019, 0020, 0024, 0025
---

# Invalidate when performance data remains unverifiable

A ready Live Session starts automatically, and missing Competition Source data receives a 30-minute Performance Recovery Window. If either Performance Record remains unverifiable, the Competition Market becomes Invalid instead of awarding a default win, because treating an external data failure as a loss would make source outages and data sabotage capable of selecting the Winner; this choice may increase invalidations and delays, so the Amoy resolver-quorum deadline is 60 minutes after the Live Session ends.

ADR 0019 retains this fail-closed rule for every Live Competition. The historical trading-specific flat-account and 0% return rules survive only in a future trading Competition Template.

## Amendment 2026-08-23: what is actually implemented

The deadline above describes a model this repository no longer runs, and the two
halves of the difference have different standing.

**The anchor moved, correctly.** ADR 0011 measures from "the Live Session ends".
ADR 0019 (fixed-duration livestream competitions) and ADR 0020 (event-driven
market gating) between them removed that moment: a room now closes when the gate
observes a decisive event, at a time nobody schedules. `closeForDecisiveEvent` is
the close, and the deadline is measured from it. Nothing needs to change here
except this sentence.

**The duration is an open question, and it is not a documentation question.**
`LivePredictionMarket.closeForDecisiveEvent` sets
`resolutionDueAt = block.timestamp + 30 minutes`, hardcoded and not configurable.
Past it `attestResult` reverts and `invalidateUnresolved` opens, so the market
becomes Invalid and refundable.

ADR 0011 budgeted **two** windows — a 30-minute Performance Recovery Window for
missing source data, *and* a 60-minute resolver-quorum deadline. The contract has
one window of 30 minutes covering both. In the precise scenario this ADR exists
to handle — Competition Source data missing — a 30-minute outage consumes the
entire budget, and the market invalidates even if the provider returns at minute
31 and a quorum was reachable. Invalidating is the fail-closed direction, so this
is a safety-preserving discrepancy rather than a dangerous one, but it makes
invalidation likelier than this ADR intended.

Resolving it is tracked as an open issue. It is a policy
decision with a cost: `LivePredictionMarket` has 398 bytes of headroom under the
EIP-170 limit, so making the deadline configurable is not free.

Until it is resolved, the implemented rule is the one above, pinned by
`testResolutionDeadlineIsThirtyMinutesFromDecisiveClose` so it cannot drift
silently.
