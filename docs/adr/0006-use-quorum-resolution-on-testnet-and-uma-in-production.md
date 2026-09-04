---
status: accepted
amended-by: 0019, 0020, 0024, 0025
---

# Use quorum Resolution on testnet and UMA in production

The Polygon Amoy MVP will register a Provisional Result and privacy-safe Evidence Bundle hash after any two matching signatures from a frozen, versioned three-role Resolver Set: an automated Primary Resolver, a separately deployed Independent Verifier, and a two-of-three human Recovery Resolver Safe. Quorum is due within 30 minutes and starts a 10-minute Challenge Window; a well-formed bonded challenge pauses finalization, and either verdict requires the Recovery Safe plus another frozen resolver, while an accepted challenge or 30-minute review timeout makes the market Invalid and a rejected challenge preserves the result. Resolver rotation affects only later markets, privacy-safe evidence remains publicly reviewable for 365 days while encrypted raw payloads normally delete after 30 days, and production replaces the quorum adapter with Polygon UMA OOV3 using `ASSERT_TRUTH2`, default DVM escalation, two-hour liveness, native-USDC bonds sized to the greater of UMA's minimum, 750 USDC, or 1% of the frozen Collateral ceiling, and a fail-closed Invalid outcome whenever the frozen Official Result Source cannot provide independently reviewable evidence or UMA cannot choose a replacement result.

Under ADR 0019, each Competition Template supplies its own Official Result Source and evidence adapter. The Livestream is never sufficient oracle evidence, and any source that UMA cannot independently review must still fail closed to Invalid.

## Amendment 2026-08-23: the contract treats all three resolvers alike

The body above describes a three-role Resolver Set — an automated Primary
Resolver, a separately deployed Independent Verifier, and a two-of-three human
Recovery Resolver Safe — and states that "either verdict requires the Recovery
Safe plus another frozen resolver".

The contract does not implement that distinction and never has.
`LivePredictionMarket.initialize` grants the identical `RESOLVER_ROLE` to all
three configured addresses, and stores nothing that marks one of them as the
Safe. `attestChallengeVerdict` is `onlyRole(RESOLVER_ROLE)` and finalizes as soon
as two *distinct* holders agree. The two automated resolvers can therefore accept
a bonded challenge — forcing the market Invalid — or reject one, preserving a
disputed result, with the human Safe never involved.

ADR 0025 already describes the implemented rule correctly ("two distinct wallets
in the frozen Resolver Set must independently inspect…"), and amends this ADR.
This note records the discrepancy explicitly, because 0025 restating the truth
elsewhere did not stop 0006 and `CONTEXT.md` from continuing to assert the
stronger guarantee in the present tense.

**The implemented rule is: any two distinct `RESOLVER_ROLE` holders.** Whether a
human co-signature should be *required* is a separate, still-open question. It
would be a contract change to a size-constrained path — `LivePredictionMarket`
has 398 bytes of headroom — so it is tracked with that cost acknowledged rather
than assumed cheap.
