---
status: accepted
amends: 0006, 0011, 0020
amended-by: 0025
---

# Require independent resolver reconstruction from raw source data

The Resolver Set will reconstruct every result from raw Competition Source data rather than attesting to a score the protocol's own pipeline derived. A resolver that signs the connector's `derived` fields, or the Coordinator's view of them, adds no independent information, and two of three resolvers agreeing on a number they all copied from one connector is one source with three signatures rather than a quorum.

This matters because the off-chain tier is not uniformly trusted. The Live Room Coordinator is harmless when compromised: it holds no key, receives no order, and can only misdescribe state that the chain already fixes. The **Source Connector is not harmless**. A connector that fabricates, omits, delays, or reorders facts can trigger an early Decisive Event, suspend a Market Gate indefinitely, or drive a room to Invalid, and it sits above the gate in the authority ladder. Independent reconstruction is the control that detects it.

Every normalized event therefore retains the raw provider payload or a verifiable reference to it, its hash, and the query that produced it, so a resolver — or any third party — can re-fetch the same window from the provider and re-derive the event. The normalized log is hash-chained and signed with a connector key held separately from the gate key. Resolver Nodes run on separate infrastructure with separate credentials, reconstruct Performance Records, Official Scores, and payout vectors from the re-fetched raw data using the frozen Competition Metric, and use our derived values only as a post-hoc comparison to be reported when it diverges.

Conflict is not resolved by majority. A reconstruction that disagrees with a peer's, or with the archived log, makes the result `unevaluable`: no attestation is submitted, an incident is raised, and the market follows the Performance Recovery Window and then invalidation. This extends the fail-closed rule in ADR 0011 from missing data to contradicted data, and it is the reason a compromised connector produces a refund rather than a confident payment to the wrong side.

The cost is real: three independent reconstruction pipelines, raw-payload retention and archival for every event, and one resolution per slot in a room that may run many. Resolution work grows linearly with program length and is the practical ceiling on how many questions a room can ask.
