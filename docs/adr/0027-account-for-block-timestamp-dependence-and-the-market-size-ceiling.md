---
status: accepted
---

# Account for block-timestamp dependence and the market size ceiling

Two facts about the contracts that constrain everything built on them, recorded
because neither was written down and both change what later work is allowed to
do.

## 1. `LivePredictionMarket` has 398 bytes of headroom

Measured by `forge build --sizes`:

```
LivePredictionMarket   runtime 24,178 B   margin   398 B   (EIP-170 limit 24,576)
LiveRoom               runtime 18,673 B   margin 5,903 B
LiveMarketFactory      runtime  6,656 B   margin 17,920 B
```

Assume the market contract cannot grow. Several planned requirements imply logic
inside it — exposure caps, slippage and deadline protection, self-exclusion,
sanctions gating — and none of them fit.

### Decision

New constraints on trading are added **outside** `LivePredictionMarket`, in this
order of preference:

1. **A periphery contract** that wraps `submitBuy`/`submitSell`, enforces the
   limit, and delegates. The market stays exactly as tested, which is what ADR
   0004 and every later ADR have relied on. Existing callers keep working; the
   limit applies to callers routed through the periphery, which is an
   enforcement question the deployment answers, not the contract.
2. **`LiveRoom`**, which has 5,903 bytes free, for anything room-scoped rather
   than market-scoped.
3. **A library**, for pure logic with no storage.
4. **An off-chain pre-trade check paired with an on-chain invariant.** Only where
   the on-chain half is sufficient on its own — an off-chain check with no
   on-chain backstop is a suggestion, not a limit.

Explicitly rejected: making room by deleting existing checks, and making the
deadline or any other frozen constant configurable purely to satisfy a
documentation mismatch. Both trade a tested safety property for a byte count.

### Consequence

Any issue that proposes changing `LivePredictionMarket` must state its size cost
first. A change that fits today may not fit alongside the next one, and the order
in which they land decides which is possible — which is a bad property to
discover late.

## 2. Nineteen `block.timestamp` dependencies, and why each is safe

`forge lint` reports 19 `block-timestamp` warnings in `contracts/src`. They are
inherent to a time-gated market and none is being suppressed. They are
enumerated here so a security reviewer has an answer for each rather than a
category, and so a *new* one has to be justified rather than absorbed into a
count nobody reads.

The common argument: a validator can nudge `block.timestamp` by a small amount,
bounded in practice by seconds. **Every window below is measured in minutes or
hours**, so a few seconds of drift cannot move an outcome — it can only move an
event marginally earlier or later within a window whose purpose survives that.

| Where | Window it governs | Why drift cannot decide anything |
|---|---|---|
| `LivePredictionMarket:499` | market opens at `opensAt` | Announce Delay is ≥30 s and set per publication; opening a second early changes nothing about who may trade. |
| `:500` | caller's own `deadline` | Supplied by the trader. Drift can only reject a trade the trader already marked as expiring; it cannot execute an expired one at a worse price. |
| `:505` | epoch end + `sourceFinalityDelay` (15 s default) | Guards *earliest* clearance. Clearing seconds early would still require a gate signature over a source sequence, which is the actual safety property. |
| `:523` | epoch end + `maxPendingTime` (900 s default) | Decides refund vs execute. 15 minutes; seconds of drift cannot flip an action that was not already at the boundary, and the boundary case refunds — the safe direction. |
| `:532` | action's own `deadline` | As `:500`. |
| `:718` | `resolutionDueAt` (30 min) | Attestation cutoff. Drift moves it by seconds inside half an hour; past it the market invalidates and refunds, which is fail-closed. |
| `:740`, `:775` | `provisionalAt + challengeWindow` (600 s default) | Challenge window open/close. 10 minutes. A challenger who waits until the final second is choosing that risk; nothing an adversary gains by shifting it seconds. |
| `:781` | `challengedAt + challengeTimeout` (1800 s default) | Unanswered challenge times out to Invalid. 30 minutes, fail-closed. |
| `:791` | `resolutionDueAt` for permissionless invalidation | Symmetric to `:718`; both sides of the same boundary, and the outcome past it is Invalid. |
| `LiveRoom:432`, `:433`, `:437` | permit `issuedAt`/`expiresAt`/`maxPermitLifetime` (300 s) | Permit freshness. 5 minutes. The permit is single-use, nonce-bound and signed over the exact question; drift cannot make a stale permit valid for a *different* question, only extend a specific one by seconds. |
| `LiveRoom:606` | `lastGateActivityAt + gateStallTimeout` (21600 s) | Permissionless recovery from a lost gate key. **6 hours.** |
| `LiveRoom:710`, `:732` | `roomClosedAt + integrityClaimWindow` (3600 s) | Integrity-claim filing window. 1 hour. |
| `LiveRoom:755`, `:779` | `claim.filedAt + integrityClaimTimeout` (3600 s) | Adjudication deadline; expiry returns both bonds. 1 hour, fail-closed. |
| `RoomLiquidityCommitments:126` | commitment `expiresAt` | Set by the committer. Drift can only expire their own commitment marginally early, returning their own funds. |

### Decision

- These 19 are accepted and justified as above. None is suppressed with a lint
  directive, because a suppressed warning is invisible to the next reviewer.
- **A new `block.timestamp` use must add a row to this table.** If the window it
  governs is measured in seconds rather than minutes, it does not belong on
  `block.timestamp` at all.
- The 65 `unsafe-typecast` warnings are all `bytes32` string-literal casts in
  `contracts/test` and `contracts/script`. None is in deployed code, and none is
  a value that can truncate at runtime — they are compile-time literals. They are
  left as-is rather than annotated, since annotating a test fixture teaches a
  reviewer nothing.
