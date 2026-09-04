---
status: accepted
amends: 0020, 0021
---

# Freeze the first Competition Template on Hyperliquid testnet

The first Competition Template will use **Hyperliquid testnet** as its Competition Source, with both Participants competing on that one source. Hyperliquid's public API exposes account state, fills, and WebSocket updates addressed by account, and a reconnecting subscription can be reconciled against the information endpoint to recover missed data. The first connector therefore reads a public address rather than a Participant's exchange credentials, which removes custody, secret-management, and liability problems from the least-hardened part of the stack and makes the Linked Competition Account boundary a public fact any resolver can independently re-fetch. This re-selects the direction ADR 0007 took before ADR 0019 superseded it, but as a single shared source rather than a source pair: a cross-source competition would require normalizing two fill semantics, two clocks, and two correction behaviours into one comparable Official Score, which is a research problem rather than a first template.

The template's live parameters are frozen as starting points to be measured and revised, not as protocol constants. The Forecasting Epoch is 10 seconds and the Source Finality Delay is 10 seconds, disclosed to Forecasters as "usually clears in about 20 seconds" in the ticket itself rather than in documentation. The maximum pending time is 90 seconds, after which an uncleared action refunds. A room runs the headline market plus at most one micro market, and a micro market cannot be published until the headline market is backed by liquidity. The Announce Delay minimum is 30 seconds and is bound into every Publication Permit. Participant-outcome and race slots carry the 1% Winner Reward Fee; threshold slots carry zero, because Yes and No are not Participants.

Access is a closed allowlist on a no-value testnet until legal review completes. This is an interface control and not a protocol control: the contracts remain permissionless apart from the restricted wallet list, so the allowlist restricts who uses TraderMarket's interface, not who can transact with a deployed market. The real containment in this phase is that the collateral is Circle test USDC with no real-world value, and no interface copy may describe the allowlist as a jurisdiction guarantee.

What remains open for this template is the exact Competition Metric over Hyperliquid fills — which fills count, how unrealized positions are treated at the terminal condition, precision, and the exact-tie band — the objectively detectable terminal condition for the headline slot, and whether a second independent connector runs over the same provider with divergence treated as unevaluable.
