---
status: accepted
amends: 0006, 0011, 0020, 0024
---

# Use canonical broadcast evidence for observable livestream events

TraderMarket will support a narrow **Livestream Event Market** template on testnet: a binary question about an objectively observable event in one exact official broadcast, such as which named guest first satisfies a frozen appearance rule. This extends the Live Competition model; it does not turn arbitrary stream commentary, audience opinion, or a creator announcement into a result.

The live player remains viewing context and never settles a market. For this template, the approved Official Result Source record is the **Canonical Stream Recording**: the complete archived MP4 covering the frozen Observation Window, its SHA-256 hash, the exact official stream URL, an absolute occurrence time, a focused review window, the immutable outcome and rule, and a resolver rationale. The canonical JSON for those fields is hashed with keccak256. That hash is the Evidence Bundle hash attested on chain.

A focused clip showing the apparent winning moment is not sufficient for a “first” question: it cannot prove that the other outcome did not occur earlier. Every resolver must review the complete observation interval, using the focused window only for wayfinding. If the recording is incomplete, unavailable, ambiguous, exceeds the MVP archive limit, or does not establish the frozen rule, the resolver must refuse to attest and the market follows its existing fail-closed Invalid path.

The evidence service is an archivist, not an oracle key. It accepts token-authenticated MP4 uploads, validates and hashes the immutable bundle, stores the recording durably, and serves the recording and bundle publicly with byte-range playback. It holds no chain key and cannot close forecasting, register a Provisional Result, decide a Resolution Challenge, or move Collateral.

Forecasting close and Resolution remain separate authorities. The isolated Source Gate Authority irreversibly closes forecasting with a monotonic evidence-event sequence when the Decisive Event is observed; the contract refunds the overlapping unsafe epoch. Then two distinct wallets in the frozen Resolver Set must independently inspect the same canonical recording and attest the same outcome and Evidence Bundle hash. One signer cannot reach quorum. A Provisional Result enters the contract's frozen Challenge Window, an evidence-backed bonded Resolution Challenge pauses finalization, two resolver verdicts are required, and an accepted or unanswered challenge produces an Invalid Market and returns the challenge bond as the contract specifies.

ADR 0024 still governs source-data competition templates: those resolvers independently reconstruct provider facts rather than copying the connector. For a Livestream Event Market there is no provider fact API to reconstruct; independence means reviewing the same immutable full recording and applying the frozen observation rule without copying another resolver's conclusion. Disagreement is not majority-scored into a winner. It prevents matching quorum and therefore fails closed.

The cost is centralization of evidence acquisition and the operational burden of retaining complete recordings. The safety boundary is explicit: a compromised uploader can publish misleading bytes but cannot make them a result without distinct resolver keys, while a compromised resolver cannot reach quorum alone. Production still requires independent resolver operators, external security review, durable object storage/CDN, provider provenance controls, and legal review; this ADR authorizes only the working testnet MVP.

