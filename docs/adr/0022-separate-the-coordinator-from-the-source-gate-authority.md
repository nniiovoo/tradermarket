---
status: accepted
amends: 0020
---

# Separate the Live Room Coordinator from the Source Gate Authority

The off-chain system will be split by authority rather than by feature. The **Source Gate Authority** is a small, deterministic, separately deployed service that consumes the Session Event Log, evaluates each open market's frozen conditions, and holds the only key that can mark a Forecasting Epoch safe, suspend or reopen the Market Gate, and close forecasting for a Decisive Event. The **Live Room Coordinator** is the operational service that composes room state, sequences the Room Program, serves snapshots and real-time updates, and runs chat, playback status, and notifications. The Coordinator holds no market key.

The dividing invariant is that **anything the Coordinator publishes can be wrong, late, or missing without anyone losing money**. It is a projection of on-chain state plus source status; it never receives a Forecaster's order, never holds collateral, never clears an epoch, never selects a Winner, and never signs anything a market contract will honor. A Forecaster's transaction goes from their own wallet to the market contract, so a compromised or offline Coordinator degrades the product to the wallet-and-RPC path the app already supports rather than putting funds at risk.

Market creation is the one privileged action the live product needs, so it moves to a third signer, the **Program Publisher**. Publication then requires two authorities at once. The Publisher chooses which approved Question Template to instantiate and when; the Gate Authority signs a **Publication Permit** attesting that the question's Closing Condition was undecided through a named source sequence. The permit is an EIP-712 message binding the room, slot index, template and parameter hash, condition hash, undecided-through sequence, Announce Delay, expiration, and a single-use nonce, and `LiveRoom.publishSlot` verifies the publisher's role and the gate's signature together.

Be exact about what this achieves. A contract cannot inspect the Session Event Log, so it cannot itself determine that a question is still open; a monotonically increasing sequence number proves ordering, not undecidedness. What the chain verifies is that the only authority able to evaluate the log signed a fresh, bound, single-use statement about this exact question. Undecidedness is enforced off chain by the Gate Authority, which refuses to sign for a condition that is decided or unevaluable and logs every permit signed and refused. The property delivered is that no single compromised key can open a question whose answer is already known, and that every publication leaves a replayable record of the claim it rested on. Resolution stays with the frozen Resolver Set. Four separate key domains result: gate signer, program publisher, resolvers, and nothing at all for the Coordinator.

**Amendment 2026-08-23 — there is a fifth.** The count above omitted
`integrityAdjudicator`, and had done since this ADR was written. It is not a
minor omission: `LiveRoom.adjudicateIntegrityClaim` is gated on that address
alone, and upholding a claim transfers a Participant's entire 100 USDC Integrity
Bond to `bondRecipient` and returns the claimant's 10 USDC. No quorum, no permit,
no second signature — one key, one call, one bond moved.

So the key domains are five: gate signer, program publisher, resolvers, integrity
adjudicator, and nothing at all for the Coordinator.

The separation requirements follow from what the power is. The adjudicator must
not be the gate signer (it would gate a room and seize a bond in it), nor the
publisher (it would write a market and seize a bond in it), nor any resolver (it
would decide the result *and* the bond), nor `bondRecipient` (it would decide a
forfeiture and receive it), nor either Participant (it would rule on claims
against itself and its opponent). None of that was checked anywhere until
2026-08-23; `CreateAmoyRoom._requireDistinctAuthorities` and the deployment
preflight now both enforce all of it, and `CreateAmoyRoomAuthorities.t.sol`
covers each case.

It should be held by a human, or a multisig, and must not be an automated process
sharing a host or an operator with the resolvers — the whole point of the
separation is that the party who decides a competitor cheated is not the party
who decides who won.

The `LiveRoom` contract also batches gating so one transaction serves every open slot in a room, and exposes permissionless epoch processing and post-close slot closing so a stalled or censoring operator cannot trap pending actions. Batching must not create a worse failure than the cost it removes: an atomic batch in which one child market reverts would stop every other slot from clearing, so batches are bounded by `MAX_BATCH`, each child call is isolated in `try`/`catch` with a gas stipend, and a failing market is skipped with an explicit `SlotCallSkipped` event rather than reverting its peers. One broken slot cannot freeze the Live Room. Replay protection survives isolation because the room-level observed sequence is non-decreasing while each market's safe sequence is strictly increasing, which lets a skipped market be retried at the same room sequence. Missing gate transactions still fail closed: uncleared actions refund after the frozen maximum pending time, and an unresolvable market becomes Invalid.

This costs an extra deployment boundary, a second signing service, and cross-service reconciliation that would be unnecessary in a single process. It buys a blast radius small enough to run the Coordinator like ordinary product software, with fast iteration, restarts, and horizontal scaling, while the money-critical path stays deterministic, replayable, and auditable from the Session Event Log alone.
