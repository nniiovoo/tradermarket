# Product Spec: Live Room Coordinator

Status: Draft

Extends: [On-Chain Livestream Prediction Markets](./livestream-prediction-markets.md)

Decisions: [ADR 0021 — One Live Room, many sequential markets](../adr/0021-run-one-live-room-with-many-sequential-markets.md), [ADR 0022 — Separate the Coordinator from the Source Gate Authority](../adr/0022-separate-the-coordinator-from-the-source-gate-authority.md)

ADR 0025 amendment: this document's source-data competition path remains unchanged. A narrow Livestream Event Market may use a complete hashed Canonical Stream Recording as its approved source record, while the live player, Stream Health, chat, and isolated clips remain non-authoritative. See [Livestream Event Resolution MVP](./livestream-oracle-mvp.md) for that adapter.

## Summary

Define the operating system that runs behind TraderMarket's interface: the services, state machines, data model, and real-time protocol that turn one Live Competition into a continuously operating **Live Room** carrying a Livestream, a rolling **Room Program** of short prediction questions, live prices, source health, chat, and a replayable settlement history.

The existing repository has the market protocol and a market page. It has no operating layer: markets are created by hand, the Market Gate is driven from a command line, the browser polls one contract address every twelve seconds, and every list, chat message, and activity card in the app is a fixture. This spec closes that gap without moving any authority off-chain.

The split is deliberate. **On-chain**: USDC custody, FPMM reserves, Outcome Positions, LP Shares, fees, Winner Reward Pools, Integrity Bonds, epoch clearance, Resolution, Redemption. **Off-chain**: playback, scheduling, chat, notifications, source collection, read models, and fast real-time delivery. **The verified bridge**: an approved Competition Source feeding a deterministic gate signer and a two-of-three Resolver Set that tell the contract what happened. Nothing in the off-chain tier can move collateral or choose a Winner.

## Product problem

One market page is not a live product. A viewer who arrives between questions sees nothing; a viewer who arrives during a question cannot tell whether the price is stale, whether the feed is healthy, or what happens next; a Forecaster who submits an action watches a spinner with no idea when it clears; and a market that resolves leaves no legible record of why. The Live Room Coordinator exists so that the room always has a current question, an honest health signal, a next thing to watch, and a settled past that can be replayed.

## Non-negotiable properties

1. The Coordinator never receives a Forecaster order. Wallets talk to market contracts directly.
2. The Coordinator holds no chain key. It cannot clear an epoch, close a market, resolve one, or move collateral.
3. Anything the Coordinator publishes may be wrong, late, or missing without changing a settlement outcome.
4. The live player and Stream Health are never inputs to the Market Gate, a Closing Condition, or a Resolution. Under ADR 0025, a separately archived complete Canonical Stream Recording may be the approved source record for a frozen Livestream Event template.
5. Every published number carries provenance: a chain reference, a source sequence, or an explicit presentation-only label.
6. Stream health, source freshness, and Coordinator connectivity are three independent signals and are never merged into one indicator.
7. Every off-chain read model is a projection that can be rebuilt from chain logs plus the Session Event Log.
8. A slot may not be published without a fresh, single-use **Publication Permit** signed by the Source Gate Authority attesting that its Closing Condition was undecided through a named source sequence. Publication requires two authorities and neither can act alone.
9. The Coordinator is harmless when compromised; the **Source Connector and the Gate Authority are not**. Their outputs are hash-chained, signed, retained with raw provider references, and independently reconstructible by the Resolver Set.
10. A Resolution never rests on a derived score alone. Resolvers reconstruct the result from raw source data, and conflicting reconstructions are `unevaluable` rather than a majority vote.
11. Failure is closed: no watermark means no execution, no permit means no publication, no quorum means Invalid, no reconstructible data means Invalid.
12. One broken slot cannot freeze the Live Room. Batched gating isolates per-market failure and reports it explicitly.

## Authority ladder

Each layer may only decide what the layer below it cannot decide for itself. Read downward for trust.

| Layer | Decides | Cannot decide | Key |
|---|---|---|---|
| Competition Source | Raw performance facts | Anything about markets | External |
| **Source Connector** | Normalization, deduplication, sequence assignment | Whether a condition is met | Connector signer |
| Session Event Log | The retained, ordered, hash-chained record | Anything | — |
| **Source Gate Authority** | Epoch safety, gate suspension, Decisive Event close, Publication Permits | Result, payouts, custody, which question is asked | `GATE_SIGNER_ROLE` |
| Program Publisher | Which approved Question Template becomes a market, and when | Whether it is publishable, gate state, result, custody | `PROGRAM_PUBLISHER_ROLE` |
| Market contracts | Execution, accounting, custody, payout vector | Their own inputs | None |
| Resolver Set | Provisional Result, challenge verdict | Custody rules, gate history | `RESOLVER_ROLE` ×3 |
| Live Room Coordinator | What the room *shows* and what is *scheduled* | Everything above | **None** |
| Edge and UI | Presentation | Everything above | None |

Two off-chain components are security-critical: the **Source Connector**, which can fabricate, omit, or delay facts, and the **Gate Authority**, which can close, suspend, or permit. Both are constrained by retention of raw provider references, signing, and independent resolver reconstruction. The Coordinator is not security-critical and is deliberately built to a lower standard of assurance so that product work can move quickly.

Publication is the one action requiring two of these authorities at once: the Publisher chooses the question and the moment, the Gate Authority attests that the question is still open. A rigged question needs both keys.

## Domain additions

New terms enter `CONTEXT.md` alongside the existing vocabulary.

- **Live Room** — the persistent surface for one Live Session carrying the Livestream, Participants, Official Scores, source status, and its Room Program.
- **Room Program** — the ordered, versioned set of Market Slots published for one Live Room.
- **Market Slot** — one position in a Room Program that materializes into exactly one Competition Market.
- **Question Template** — an approved, versioned, parameterized question type with a frozen Opening Condition, Closing Condition, outcome shape, tie rule, and Winner Reward setting.
- **Opening Condition** — the frozen rule that makes a Market Slot's Forecasting Window available.
- **Closing Condition** — the frozen predicate over the Session Event Log whose satisfaction is that market's Decisive Event.
- **Session Event Log** — the append-only, monotonically sequenced, signed record of normalized Competition Source facts for one Live Session; the single ordering authority for every market in a Live Room.
- **Source Connector** — the security-critical service that normalizes one Competition Source into the Session Event Log, retaining raw payloads and signing with its own key.
- **Source Gate Authority** — the isolated service that evaluates frozen conditions over the Session Event Log, holds the Market Gate role for every Competition Market in a Live Room, and signs Publication Permits.
- **Publication Permit** — a fresh, single-use, expiring EIP-712 attestation by the Source Gate Authority that one exact question's Closing Condition was undecided through a named source sequence.
- **Program Publisher** — the isolated signer that instantiates approved Question Templates through the room's `LiveRoom` contract; it cannot publish without a Publication Permit.
- **Liquidity Commitment** — a signed, cancellable policy pre-authorizing bounded per-slot liquidity for future slots matching approved templates; execution is permissionless and the capital enters only the matching slot's FPMM.
- **Live Room Coordinator** — the non-custodial service that composes Live Room state, sequences the Room Program, and delivers real-time updates; it holds no market key.
- **Room Snapshot** — the complete published state of a Live Room at one Room Sequence.
- **Room Sequence** — the gap-free monotonic counter for a Live Room's published state changes, distinct from the source sequence.
- **Announce Delay** — the frozen minimum interval between publishing a Market Slot and opening its Forecasting Window.
- **Stream Health** — the separately reported availability of the Livestream, never an input to the Market Gate.

## Architecture

### Services

| Service | Responsibility | State | Scales | Chain key |
|---|---|---|---|---|
| **Source Connector** | Poll or stream one approved Competition Source, normalize facts, deduplicate, assign sequence numbers | Append-only log | One per source per room | None |
| **Source Gate Authority** | Evaluate frozen conditions, emit watermarks, drive `LiveRoom` gating | Evaluator cursor | Single writer per room | `GATE_SIGNER_ROLE` |
| **Program Publisher** | Validate and publish Market Slots from approved templates | Publication cursor | Single writer per room | `PROGRAM_PUBLISHER_ROLE` |
| **Chain Indexer** | Project `LiveRoom`, factory, and market logs into read models | Block cursor | One writer, replayable | None |
| **Live Room Coordinator** | Compose room state, sequence the program, publish Room Sequence deltas | Room state, cached | Horizontal, one leader per room | **None** |
| **Realtime Edge** | WebSocket and SSE fanout, presence, backpressure | Connection state | Horizontal | None |
| **Chat Service** | Authenticated chat, moderation, pinned rules | Messages | Horizontal | None |
| **Playback Service** | Stream ingest or embed configuration, health polling, timecode mapping | Stream state | Horizontal | None |
| **Notification Service** | Push, email, and in-app notifications from the outbox | Outbox | Horizontal | None |
| **Resolver Node** | Re-fetch raw source data, reconstruct results independently, attest, answer challenges | Attestation cursor | Three independent operators | `RESOLVER_ROLE` |
| Commitment Executor | Execute signed LP commitments against newly published slots | None | Permissionless; we run one as a convenience | None |

Only four services hold a signing key, and the Coordinator is not one of them.

### Data flow

```text
Competition Source
        |  normalize, deduplicate, sequence, sign
        v
Session Event Log  ──────────────────────────────┐
        |                                        |
        |  evaluate frozen conditions            |  scores, freshness,
        v                                        |  decisive events
Source Gate Authority                            |
        |  markRoomEpochsSafe / suspendRoom       |
        |  reopenRoom / closeSlots / closeRoom    |
        v                                        |
   LiveRoom contract ── grants GATE_ROLE ──> Competition Markets
        ^                                        |
        |  publishSlot                           |  chain logs
   Program Publisher                             v
        ^                                   Chain Indexer
        |  requested slot                        |
        |                                        v
   Live Room Coordinator <───────────────────────┘
        |  Room Snapshot + Room Sequence deltas
        v
   Realtime Edge ──> UI          Wallet ──── transaction ────> Competition Market
```

The Coordinator sits downstream of everything that matters and upstream of nothing that matters. The Forecaster's own transaction path bypasses it entirely.

### Storage

- **PostgreSQL** — read models, program, rooms, chat, outbox. Single source of derived truth for the API.
- **Append-only event store** — the Session Event Log, retained per room with its signatures for replay and evidence. Postgres partitioned table in the MVP; object storage archive after finalization.
- **Redis** — room fanout channels, presence counts, rate limits, leader election per room, hot Room Snapshot cache.
- **Object storage** — Evidence Bundles, stream recordings, settlement replay manifests.

No user balance, position, or order ever lives in this tier as authority. Position and LP tables are caches keyed by chain block, and every one carries the block number it was derived from.

## The Live Room

### Room state machine

```text
draft ──> armed ──> live ──> closing ──> settling ──> final
   │        │         │          │           │
   └────────┴─────────┴──────────┴───────────┴────> invalid
```

| State | Entered when | Program behaviour | Market Gate |
|---|---|---|---|
| `draft` | Competition Offer accepted | Slots may be planned, none published | n/a |
| `armed` | Both Participants ready, room Integrity Bonds posted, `LiveRoom` deployed | Headline slot publishes first, then is announced | Open after Announce Delay |
| `live` | Scheduled Live Session start reached | Slots publish, open, close, and advance | Open, may suspend and reopen |
| `closing` | Terminal condition observed in the Session Event Log | No new slots; every open slot closed | Closed, irreversible |
| `settling` | All slots closed | Recovery, scoring, Provisional Results, Challenge Windows | Closed |
| `final` | Every slot reached Final or Invalid | Read-only, replay available | Closed |
| `invalid` | Room-level invalidation rule met | Every unresolved slot invalidated | Closed |

The room's own state never gates a market. It describes what has already happened on chain.

### Room Program and Market Slots

A Room Program is an ordered list of slots. Each slot names a Question Template, its bound parameters, its Opening Condition, its Closing Condition, and its Winner Reward setting. The headline slot — the participant-outcome question on the whole Live Competition — is slot `0`, is mandatory, and stays open for the entire session.

```text
Live Room: Alice vs Bob, session 0x91c3
├── slot 0  headline   Who wins the entire competition?          open until terminal condition
├── slot 1  micro      Will Alice lead after the next completed trade?   closed  · Yes
├── slot 2  micro      Will Bob's return exceed 2%?                   open    · closes on metric or session end
├── slot 3  race       Who reaches $10,000 profit first?               open    · ties if neither
└── slot 4  micro      planned, not yet published
```

Three outcome shapes are supported, all binary on the existing contract:

| Shape | Outcome A | Outcome B | Undecided at session end | Winner Reward |
|---|---|---|---|---|
| `participant` | Participant A | Participant B | Tie | 100 bps to the winning reward address |
| `threshold` | Yes | No | Resolves No, or Invalid if the metric is unverifiable | 0 bps |
| `race` | Participant A | Participant B | Tie | 100 bps |

Concurrency is capped by the Competition Template. The recommended MVP cap is the headline slot plus at most one open micro slot, so LP capital and audience attention are not split across an unbounded number of thin pools.

### Slot state machine

Slot states reuse the market states already named in the product spec and add only `planned` and `announced`.

```text
planned ─> announced ─> awaiting-liquidity ─> open ⇄ suspended
                                                │
                                                v
                                            closed ─> recovering ─> provisional ─> final
                                                                          │  ⇅
                                                                          │  challenged
                                                                          └────────────> invalid
```

- `planned` — in the Room Program, no contract, not visible as tradable.
- `announced` — market deployed, question and Closing Condition public, Announce Delay running, no action accepted.
- `awaiting-liquidity` — Market Gate Open, no backed reserves, first eligible LP deposit still pending.
- `open` — backed and executable; submissions enter Forecasting Epochs.
- `suspended` — source stale; existing pending actions still awaiting clearance, no new ones accepted.
- `closed` — Decisive Event recorded on chain; overlapping and later epochs refunded.
- `recovering` — Performance Recovery Window running for missing facts.
- `provisional` / `challenged` / `final` / `invalid` — as already specified.

The Coordinator derives every one of these from chain state plus source status. It never asserts one the chain does not support.

### Cost of a rolling program

Running many markets on one session is not free, and most of the cost lands on the contract rather than the service.

- **Integrity Bonds.** `isReady()` requires both Participants to have posted a 100 USDC Integrity Bond *into that market contract* before any action is accepted. A five-slot room would demand 1,000 USDC of bonds and a participant signature for every question published mid-session, which is impossible while they are competing. The bond therefore becomes room-scoped: posted once to `LiveRoom`, held for the whole Live Session, and released only after every slot reaches Final or Invalid. Each slot delegates readiness to the room.
- **Resolution load.** Every slot needs its own Evidence Bundle, two-of-three attestation, and Challenge Window. Resolver Nodes must build and submit these automatically from the archived log and evaluator, with the human Recovery Resolver reserved for disputes. Resolution work grows linearly with the number of slots and is the practical ceiling on program length.
- **Gate transactions.** Batched through `LiveRoom` so one transaction serves every open slot per epoch.
- **Liquidity.** Each slot funds itself. Short questions are structurally thin, which is why concurrency is capped, why a micro slot cannot open before the headline is backed, and why room liquidity commitments exist.

### Room liquidity commitments

A three-minute question cannot wait for an LP to notice it, open a wallet, and approve a transaction. But sharing reserves across slots would break the isolation the whole model rests on. The resolution is to automate the *decision*, not to pool the *capital*.

1. An LP grants one bounded USDC approval to the room's commitment contract. One approval, one known address, no per-slot approval and no future-address guessing.
2. The LP signs an EIP-712 **Liquidity Commitment** policy: room, allowed Question Templates and shapes, USDC per slot, maximum simultaneous exposure, maximum total, expiration, nonce.
3. When a slot is published at its deterministic address, **anyone** may execute the commitment against it. Execution is permissionless because the LP's signature, not the executor, is the authority.
4. The USDC enters that slot's own FPMM and nothing else. No reserve is shared, transferred, or migrated between slots.
5. The LP receives that slot's LP Position, its fee checkpoint, and its fees, and bears that slot's inventory risk. The executor receives nothing.

Execution needs one market-contract hook, because `submitAddLiquidity` credits `msg.sender` and the executor is not the LP. `submitAddLiquidityFor(address provider, uint256 amount, uint256 minimumShares, uint64 deadline)` pulls collateral from `msg.sender`, records the pending action with `user = provider`, and credits LP Shares, the fee checkpoint, and any refund to `provider`. It is callable only by a `LIQUIDITY_ROUTER_ROLE` frozen at initialization to the room's commitment contract, and the eligibility check applies to `provider`, so a Participant or insider still cannot become an LP through a router.

The policy is enforced by the commitment contract with an explicit accounting model, because "maximum simultaneous exposure" is meaningless unless something makes exposure go back down and unambiguous replay rules decide what one signature authorizes:

- `commitmentId = keccak256` of the signed policy's EIP-712 struct hash. One signature, one identity; re-signing the same terms with a new nonce is a new commitment.
- `executedSlot[commitmentId][market] -> amount` — set exactly once per market. A commitment executes at most once against any slot, so replay against the same slot is structurally impossible rather than merely checked.
- `totalExecuted[commitmentId]` — lifetime USDC drawn, checked against the policy's maximum total. Never decreases.
- `activeExposure[commitmentId]` — USDC currently locked in unresolved slots, checked against the policy's maximum simultaneous exposure. Increases on execution.
- `releaseExposure(commitmentId, market)` — **permissionless**: once that market reports Final or Invalid, anyone may decrement `activeExposure` by `executedSlot[commitmentId][market]`, once (the executed record is marked released). Without this, exposure ratchets upward and a commitment sized for three concurrent slots dies after its first three, even after all three settled.
- `cancel(nonce)` — the LP invalidates the nonce on chain at any time; execution against a cancelled or expired commitment reverts. Cancellation stops future draws and does not touch positions already held.

The contract holds LP allowances and can initiate USDC movement, so it is money-critical contract code regardless of which delivery phase it lands in, and it carries the same invariant-testing and audit expectations as the market contracts. Its saving structural property: it holds no balance between transactions — every draw goes straight from the LP's wallet into one slot's FPMM, and the LP Position lands on the LP.

This is deliberately not ERC-4337. Account abstraction stays in the plan for gas sponsorship, but the cold-start problem does not need a bundler, a paymaster policy, or a smart account to be solved, and starting there would put a much larger dependency on the critical path of a testnet.

### Publication rules and the Publication Permit

A contract cannot inspect the Session Event Log, so it cannot decide for itself whether a question is still open. A monotonically increasing sequence number proves ordering, not undecidedness. Publication therefore requires an attestation from the only authority that can evaluate the log, and the contract's job is to verify that the attestation is genuine, fresh, single-use, and bound to exactly this question.

A **Publication Permit** is an EIP-712 message signed by the Source Gate Authority:

```text
Publication Permit
  room                       address of the LiveRoom clone (also the EIP-712 verifyingContract)
  slotIndex                  uint32
  requestHash                keccak256 of the COMPLETE slot request and its restricted list:
                             templateId, templateParamsHash, conditionHash, announceDelay,
                             winnerRewardBps, question, streamUrl, imageUrl, and the per-slot
                             restricted-wallet array in order
  conditionHash              keccak256 of the frozen opening and closing condition document
  undecidedThroughSequence   uint256   the source sequence through which the gate evaluated the
                                       Closing Condition and found it undecided
  announceDelay              uint64
  issuedAt                   uint64    when the gate signed; permit age is measured from here
  expiresAt                  uint64
  nonce                      uint256
```

`requestHash` must cover everything the publisher supplies. Binding only the
template parameters and the condition would leave the template id, the winner
setting, the question text the audience reads, both media URLs, and the
restricted-wallet list free to change after the gate signed — so a publisher
could have a 0 bps question attested and publish a 100 bps one, or drop a
disclosed insider from the restricted list.

`LiveRoom.publishSlot(request, permit, signature, restricted)` verifies, in order:

1. `msg.sender` holds `PROGRAM_PUBLISHER_ROLE`.
2. The recovered EIP-712 signer holds `GATE_SIGNER_ROLE`. The domain separator binds the permit to this room, this contract, and this chain.
3. `permit.nonce` is unused, and it is consumed atomically.
4. Freshness, anchored to signed issuance in three parts: `permit.issuedAt <= block.timestamp` (not issued in the future), `permit.expiresAt > block.timestamp` (not expired), and `permit.expiresAt - permit.issuedAt <= MAX_PERMIT_LIFETIME` (a declared lifetime within the frozen maximum). A fourth check, `block.timestamp - permit.issuedAt <= MAX_PERMIT_LIFETIME`, is defense in depth: it is unreachable while the other three hold, and stays so a later refactor cannot silently reintroduce staleness.

   An **expiry-relative** bound is not sufficient and was the original error here. `expiresAt <= now + MAX_PERMIT_LIFETIME` accepts a permit issued hours ago whose expiry merely happens to be near, carrying an undecidedness claim that is long stale. Binding `issuedAt` is what closes it.
5. `permit.undecidedThroughSequence >= lastObservedSequence()`, so a permit cut earlier in the session cannot be held back and replayed later.
6. `permit.requestHash` equals the room's own `slotRequestHash(request, restricted)`, and `permit.conditionHash`, `permit.slotIndex`, and `permit.announceDelay` equal the request's. The gate attested *this* question with *this* restricted list, not a similar one.
7. `permit.slotIndex == slots().length`, so the program is dense: no gaps, no out-of-order publication, no second market at an index.
8. The deterministic address for `(roomId, slotIndex)` has no code. `cloneDeterministic` would revert on collision anyway; asserting it first turns a corrupted-state accident into a legible error.
9. The Question Template is in the room's frozen approved catalog and its parameters are within the template's declared bounds.
10. The Resolver Set, readiness source, gate, collateral, epoch duration, Source Finality Delay, maximum pending time, and Challenge Window match the room's frozen values.
11. `participantsReady()` is true, `roomClosedSequence()` is unset, and the open-slot count is below the room's frozen maximum. On-chain readiness, not the Coordinator's derived room state, is the check — the room contract cannot see the Coordinator and must not need to.
12. For any `slotIndex > 0`, slot 0 reports `hasLiquidity()`. A micro market cannot open before the headline market is backed.
13. The restricted wallet list carries both Participants, both reward addresses, disclosed related and insider wallets, the gate signer, the publisher, the liquidity router, and all three resolvers.

On success, `publishSlot` performs its state transitions in one atomic step: it consumes `permit.nonce`, advances `lastObservedSequence()` to `permit.undecidedThroughSequence` (the gate attested the log through that point, and the room's watermark must never trail an attestation it has accepted), appends the market at `slotIndex`, deploys the deterministic clone, grants it `GATE_ROLE` wiring, and emits the publication event. A permit is spent even if later gating never happens; nothing about a consumed nonce is reusable.

Be precise about what this buys. The chain does not verify that the condition was undecided; it verifies that the authority which *can* evaluate that question signed a fresh, bound, single-use statement saying so. Undecidedness itself is enforced off chain by the Gate Authority, which refuses to sign a permit for a condition that is `decided` or `unevaluable` at the requested sequence, and logs every permit it signs and every one it refuses. The property the pair delivers is that **no single compromised key can open a question whose answer is already known**, and that every publication leaves a signed, replayable record of the claim it rested on.

## Source pipeline

### Session Event Log

One Live Session has exactly one log. Every market in the room orders itself against the same sequence, which is what makes a shared gate coherent.

```json
{
  "room_id": "room_01J9F2",
  "seq": 918341,
  "source": "binance-futures",
  "source_event_id": "8f2c...",
  "participant": "alice",
  "observed_at": "2026-08-18T20:41:03.118Z",
  "ingested_at": "2026-08-18T20:41:03.402Z",
  "kind": "trade_closed",
  "facts": { "realized_pnl_usd": "1420.55", "return_pct": "2.41" },
  "derived": { "official_score": "2.41", "rank": 1 },
  "raw_ref": "s3://tm-source-archive/room_01J9F2/918341.json",
  "raw_hash": "0x4c…",
  "raw_query": { "endpoint": "info", "type": "userFills", "user": "0x…", "startTime": 1755549600000 },
  "prev_hash": "0x7d…",
  "hash": "0x1a…",
  "connector_signature": "0x…"
}
```

- `seq` is assigned by the ingest writer, is gap-free per room, and never rewinds.
- `observed_at` is the source's timestamp; `ingested_at` is ours. Freshness is measured on `observed_at`.
- `prev_hash` chains the log so a replay can prove no fact was inserted, removed, or reordered after the fact.
- Corrections are appended as new events referencing the corrected `source_event_id`. The log is never mutated.
- `raw_ref` and `raw_hash` archive the exact original response bytes and their canonical hash, and `raw_query` records a **closed** time or cursor window — never an open-ended one — so the same window can be re-queried later.
- Re-verification is at the fact level, not the byte level. A later query over the same window may paginate differently, serialize in a different order, or include fills that arrived after the original read; byte-for-byte equality of live responses is therefore not a meaningful check. What must match are the immutable fill identifiers, their per-fill contents, and the normalized facts derived from them. The archived bytes exist so the original read itself is beyond dispute.
- The log is the only permitted input to condition evaluation. Chat, stream, operator statements, and Coordinator state are not inputs.

### Source trust model

The Coordinator is harmless when compromised. The Source Connector is not. A connector that fabricates, omits, delays, or reorders facts can close a market early, suspend one indefinitely, or push a whole room to Invalid. It sits above the gate in the authority ladder and must be built to the standard that implies.

| Threat | Effect | Control |
|---|---|---|
| Fabricated event | Early Decisive Event, wrong Closing Condition trigger | Raw payload retained and hashed; resolvers re-fetch from the provider and reconstruct; divergence blocks Resolution |
| Omitted event | Market runs past its true close, or a score is wrong | Provider sequence and cursor continuity checks; gap detection suspends the gate rather than proceeding |
| Delayed event | Suspension, refunds | Freshness measured on `observed_at`; disclosed and alerted, never silently absorbed |
| Replayed event | Duplicate facts, wrong score | Deduplication by `source_event_id`; append-only hash chain; monotonic sequence |
| Provider correction after the fact | Result changes after a Provisional Result | Corrections append rather than mutate; a correction inside the Challenge Window is grounds for a Resolution Challenge |
| Connector key compromise | All of the above | Connector signing key separate from the gate key; resolver reconstruction is the detection mechanism |

Four rules follow, and they are the reason a compromised connector cannot quietly pay the wrong side:

1. Every normalized event retains a raw provider payload or a verifiable reference to one, plus the query that produced it.
2. The normalized log is hash-chained and signed by the connector, with its own key.
3. **Resolver Nodes reconstruct every result independently from raw source data.** A resolver that attests using our derived score, or using the Coordinator's view, has added nothing and defeats the quorum.
4. Conflicting reconstructions are `unevaluable`, not a vote. Unresolved conflict suspends, then invalidates. Two of three resolvers agreeing on a number they all copied from the same connector is not a quorum.

Where the Competition Source permits it, run two independent connectors over the same provider with different credentials and infrastructure, and treat divergence as `unevaluable`. This is a decision for the first template rather than a universal requirement.

### Condition evaluation

Opening and Closing Conditions are declarative, versioned, and hashed into the market at publication. They are not free-form code.

```json
{
  "condition_version": "1.0.0",
  "template": "participant_metric_threshold",
  "params": { "participant": "bob", "metric": "return_pct", "operator": ">=", "value": "2.0" },
  "decides_on": "first_event_satisfying",
  "undecided_at_session_end": "outcome_b",
  "freshness_seconds": 20
}
```

The evaluator is a pure function `(condition, log_window) -> Decision`, where `Decision` is `undecided`, `decided(outcome, seq)`, or `unevaluable(reason)`. It must be deterministic, side-effect free, and reproducible from the archived log by any third party. Its version and the condition hash are recorded in the Evidence Bundle so a challenger can rerun it.

`unevaluable` is not a failure to hide, and suspension is not a resting place.
It suspends immediately, but a room cannot hang there: Integrity Bonds would
never release and Forecasters would never learn where they stand. The handling is
durable and bounded:

1. On the first unevaluable tick the gate records the moment, persistently, and suspends.
2. If the condition becomes evaluable again inside the frozen grace period, the gate reopens and the session continues. Recovery is the expected outcome of a transient source problem.
3. If it is still unevaluable when the grace period expires, the market **closes**. A persistently unevaluable headline closes the whole room at the observed sequence; a persistently unevaluable micro condition closes only that slot, so one broken question never ends a session.
4. Closure hands the market to Resolution, which recovers the result if the facts can be reconstructed and reaches Invalid if they cannot — and either way the room reaches a terminal state and the bonds release.

The grace period is persisted, so a restart cannot restart the clock.

### Source Gate Authority

A single-writer loop per room, restartable from its cursor, with no dependency on the Coordinator:

1. Read the Session Event Log forward from the last evaluated sequence.
2. For every open market, evaluate its Closing Condition over the new window.
3. If a market's condition is decided, submit `closeSlots(decisiveSequence, [market])`.
4. If the room's terminal condition is decided, submit `closeRoom(decisiveSequence)`.
5. If freshness has lapsed, submit `suspendRoom(sequence)`; when it recovers with no decisive event in the gap, submit `reopenRoom(sequence)`.
6. Otherwise, once the Source Finality Delay has elapsed for a completed epoch, submit `markRoomEpochsSafe(sequence, markets, epochs)` for every open market whose condition was undecided through that sequence.
7. Submit `processRoom(...)` for cleared epochs holding pending actions, and let anyone else do the same.

It also serves Publication Permits. On a request from the Program Publisher it evaluates the candidate Closing Condition at the current sequence and signs a permit only when the result is `undecided`. A `decided` or `unevaluable` condition is refused with a reason. Every permit signed and every permit refused is written to the gate's own audit log with the evaluated sequence, the condition hash, and the evaluator version. The gate never chooses which question to ask; it only answers whether the proposed one is still open.

The gate is a single writer, so it must be **restart-safe**, and that is a
correctness property rather than an operational nicety:

- The permit nonce counter is persisted before a permit is handed out, so a
  crash between signing and saving cannot let the next start reissue a nonce.
- The audit log is persisted, so the record of what was attested survives the
  process that attested it.
- Suspension is read from **chain**, never from memory. A gate that dies while a
  room is suspended must still reopen it on restart, and must not re-suspend a
  room that is already suspended.
- The unevaluable clock is persisted, so a restart cannot reset a grace period
  that had already begun and leave a room suspended forever across a restart loop.

Safety rules the signer enforces before signing anything:

- Never mark an epoch safe past a sequence it has not fully evaluated for that exact market.
- Never mark safe a market whose condition was satisfied at or before the epoch's final sequence.
- Never sign a non-increasing sequence; the contract rejects it as a second line of defence.
- Never sign after the market is closed. Closure is irreversible in both the service and the contract.
- Never sign a Publication Permit for a condition that is not `undecided` at the evaluated sequence, and never sign one whose hashes it did not compute itself from the submitted condition document.
- Prefer suspension to a guess. A stalled gate refunds; a wrong gate pays the wrong person.

### Batched room gating with isolated failure

Four open slots on a ten-second epoch would otherwise need twenty-four gate transactions a minute. The per-room `LiveRoom` contract collapses them and holds `GATE_ROLE` on every market it creates.

Batching introduces a failure mode worse than the cost it removes: an atomic batch in which one child market reverts would stop every other slot in the room from clearing. Batches are therefore bounded and each child call is isolated.

```solidity
interface ILiveRoom {
    struct SlotRequest {
        bytes32 templateId;
        bytes32 templateParamsHash;
        bytes32 conditionHash;
        uint64 announceDelay;
        uint16 winnerRewardBps;          // 0 or 100
        LivePredictionMarket.MarketConfig config;
    }

    struct PublicationPermit {
        uint32 slotIndex;
        bytes32 templateParamsHash;
        bytes32 conditionHash;
        uint256 undecidedThroughSequence;
        uint64 announceDelay;
        uint64 expiresAt;
        uint256 nonce;
    }

    /// @notice Requires PROGRAM_PUBLISHER_ROLE on the caller AND a GATE_SIGNER_ROLE signature over the permit.
    function publishSlot(
        SlotRequest calldata request,
        PublicationPermit calldata permit,
        bytes calldata gateSignature,
        address[] calldata restricted
    ) external returns (address market, uint32 slotIndex);

    // GATE_SIGNER_ROLE. Each rejects a decreasing room sequence and anything after closeRoom.
    // Child calls are isolated: a reverting market is skipped and reported, never reverting the batch.
    function markRoomEpochsSafe(uint256 sourceSequence, address[] calldata markets, uint64[] calldata epochs) external;
    function suspendRoom(uint256 sourceSequence) external;
    function reopenRoom(uint256 sourceSequence) external;
    function closeSlots(uint256 decisiveSequence, address[] calldata markets) external;
    function closeRoom(uint256 decisiveSequence) external;

    // Permissionless: anyone may push execution, and anyone may close remaining slots once the room is closed
    function processRoom(address[] calldata markets, uint64[] calldata epochs, uint256 maxActions) external;
    function closeRemainingSlots(address[] calldata markets) external;

    event SlotCallSkipped(address indexed market, uint64 indexed epoch, bytes4 selector, bytes reason);

    // Room-scoped Integrity Bonds and the readiness delegate markets consult (issue 13)
    function postIntegrityBond() external;
    function participantsReady() external view returns (bool);
    function claimIntegrityBond() external;

    function slots() external view returns (address[] memory);
    function lastObservedSequence() external view returns (uint256);          // room-level, non-decreasing
    function lastSafeSequenceOf(address market) external view returns (uint256); // per-market, strictly increasing
    function roomClosedSequence() external view returns (uint256);
    function openSlotCount() external view returns (uint256);
}
```

Isolation rules:

- Every **gating** entry is called with a bounded gas stipend inside `try`/`catch`. A failing child emits `SlotCallSkipped` with its revert reason and the batch continues. Gating work is small and predictable, so a fixed stipend is right for it.
- `processRoom` is different and must not use a fixed stipend. It executes real market work whose cost scales with the actions in the epoch, so each child receives a fair share of the gas actually available above a floor. A fixed stipend silently starved execution, and because failures are isolated the starvation was invisible: the market simply never became backed.
- When the available share falls below the floor, `processRoom` **reverts** rather than skipping. A cheap skip path is self-fulfilling under gas estimation — the estimator finds that a low limit "succeeds" because everything was skipped, returns it, and the batch never does any work and never says so. Any caller must set an explicit gas limit rather than trusting an estimate.
- `MAX_BATCH` caps entries per transaction. Exceeding it is a caller error and reverts, because a silently truncated batch would look like success.
- The batch reverts only on caller error: a bad role, an invalid signature, an array-length mismatch, an unknown market, a decreasing room sequence, or a call after `closeRoom`.
- The room sequence is **non-decreasing** while each market's safe sequence is **strictly increasing**. A market skipped at sequence `S` can therefore be retried at the same `S` in a later transaction, individually or in the next batch, without weakening replay protection.
- A skipped market simply does not clear. Its epoch stays pending and refunds at the maximum pending time. Skipping fails closed, and the skip is visible on chain rather than inferred from absence.
- `closeRoom` records the terminal sequence without looping over every market, and `closeRemainingSlots` becomes permissionless afterwards, so a gas-exhausted or censoring operator cannot trap pending actions in a room that has already ended.

The Gate Authority alerts on any `SlotCallSkipped`, because a persistently skipped market is a market that will refund its audience rather than settle.

## Required chain changes

These are **bounded** contract changes, not purely additive ones. Three of them change existing semantics and accounting: bond custody moves off the market, the Winner Reward Fee stops being a constant, and liquidity gains a delegated entry point. Each keeps a backward-compatible standalone mode so the existing suite and any non-room market behave exactly as before, but "additive" would be the wrong word to plan around, and the changed paths need their invariants re-proved rather than merely re-run.

| Change | Where | Kind | Why |
|---|---|---|---|
| Add `roomId`, `slotIndex`, `templateId`, `conditionHash` to `MarketConfig` | `LivePredictionMarket` | Additive | Without an on-chain room binding, settlement history cannot prove which room and which frozen question a market belonged to |
| Replace the `WINNER_REWARD_BPS` constant with a frozen `winnerRewardBps` (0–100) | `MarketMath`, `LivePredictionMarket` | **Changes fee semantics and reward accounting** | Threshold slots have no Participant to reward; ADR 0021 |
| Move the Integrity Bond to the room: add an immutable `readinessSource` to `MarketConfig`, delegate `isReady()` to it, and hold `postIntegrityBond` and `claimIntegrityBond` on `LiveRoom` | `LivePredictionMarket`, `LiveRoom` | **Changes bond custody, readiness, and `accountedLiabilities()`** | Per-market bonds would require 200 USDC and two Participant signatures per published slot, mid-session |
| Add `submitAddLiquidityFor(provider, …)` behind a frozen `LIQUIDITY_ROUTER_ROLE` | `LivePredictionMarket` | **Changes who may originate an LP action** | Room liquidity commitments need an executor that is not the LP, while shares, fees, and refunds still belong to the LP |
| New `LiveRoom` clone with the interface above | `contracts/src/LiveRoom.sol` | New | Publication Permit verification, batched gating with isolated failure, per-market sequence monotonicity, room bond custody, permissionless recovery |
| `Clones.cloneDeterministic` keyed by `(roomId, slotIndex)` | `LiveMarketFactory` | Additive | Deterministic slot addresses let an LP commit to a future slot and let the UI deep-link one before it exists |
| `createRoomMarket` requires `roomById[roomId] == msg.sender` and that the config's `roomId`/`slotIndex` match the deterministic salt | `LiveMarketFactory` | Changes who may create markets | Only the registered room may mint its own slots. A `MARKET_CREATOR_ROLE` check alone let the factory admin mint a market into someone else's room, and let a room's config claim a room binding its salt did not match |

`readinessSource` is deliberately a separate immutable field rather than a reuse of `gateOracle`. Readiness is a statement about Participant commitment; gating is a statement about source safety. They happen to be the same contract today, and conflating them in the type would make it impossible to separate them later without a migration.

Everything else — FPMM math, epochs, positions, the 0.3% Liquidity Fee, resolution, challenge, and redemption — is unchanged. Bond amounts, forfeiture rules, and the objective violation process are unchanged; only custody and release conditions move.

### Room Integrity Bond release

A Participant's room bond is released only when **all four** hold:

1. The room's terminal condition has occurred and `roomClosedSequence()` is set.
2. No further slot can ever be published, which follows from 1 and is asserted explicitly.
3. Every published slot has reached Final or Invalid.
4. The Integrity Claim Window has elapsed with no unresolved Integrity Claim against that Participant.

Condition 4 needs a claim registry on `LiveRoom`: a window that opens at room close, a bonded claim carrying an objective violation code and evidence hash, and a published adjudication authority and deadline. The product spec already requires those to be frozen before forecasting opens; the room contract is where they now live. Which body adjudicates on testnet remains an open decision.

## Read models

The Chain Indexer is the only writer of chain-derived tables. Every such table carries the block it was derived from, and the whole schema can be dropped and rebuilt by replaying logs plus the Session Event Log.

```sql
create table room (
  room_id            text primary key,
  live_room_address  bytea not null unique,
  state              text not null,                    -- draft|armed|live|closing|settling|final|invalid
  template_id        text not null,
  participant_a      jsonb not null,                   -- name, address, reward address, linked account digest
  participant_b      jsonb not null,
  resolver_set       bytea[] not null,
  gate_signer        bytea not null,
  epoch_duration_s   int  not null,
  finality_delay_s   int  not null,
  announce_delay_s   int  not null,
  max_open_slots     int  not null,
  scheduled_start_at timestamptz not null,
  terminal_condition jsonb not null,
  stream             jsonb not null,                   -- provider, playback id, embed policy, disclosed delay
  room_seq           bigint not null default 0,
  closed_source_seq  numeric,
  created_at         timestamptz not null default now()
);

create table program_slot (
  room_id           text not null references room(room_id),
  slot_index        int  not null,
  state             text not null,                     -- planned|announced|awaiting-liquidity|open|suspended|closed|recovering|provisional|challenged|final|invalid
  shape             text not null,                     -- participant|threshold|race
  question          text not null,
  template_id       text not null,
  params            jsonb not null,
  opening_condition jsonb not null,
  closing_condition jsonb not null,
  condition_hash    bytea not null,
  winner_reward_bps int  not null,
  market_address    bytea unique,
  published_seq     numeric,                           -- source sequence at publication
  opens_at          timestamptz,
  closed_seq        numeric,
  primary key (room_id, slot_index)
);

create table market_state (                            -- one row per market, rewritten by the indexer
  market_address    bytea primary key,
  room_id           text not null,
  slot_index        int  not null,
  participant_a_name text,                            -- immutable label read from the child market; null until proven
  participant_b_name text,                            -- immutable label read from the child market; null until proven
  gate_state        smallint not null,
  reserve_a         numeric not null,
  reserve_b         numeric not null,
  implied_prob_a    numeric not null,                  -- cleared price only, never pending-adjusted
  total_lp_shares   numeric not null,
  winner_reward_pool numeric not null,
  pending_collateral numeric not null,
  current_epoch     bigint not null,
  last_safe_seq     numeric not null,
  final_outcome     smallint not null,
  finalized_block_number bigint,                      -- ResultFinalized log block, never the row's later refresh block
  provisional_at    timestamptz,
  challenge_ends_at timestamptz,
  block_number      bigint not null,
  updated_at        timestamptz not null
);

create table market_action (                           -- pending and settled Forecaster and LP actions
  market_address bytea not null,
  action_id      bigint not null,
  epoch          bigint not null,
  kind           smallint not null,
  status         smallint not null,                    -- pending|executed|refunded
  account        bytea not null,
  outcome_a      boolean not null,
  amount         numeric not null,
  minimum_return numeric not null,
  return_amount  numeric,
  submitted_block bigint not null,
  settled_block   bigint,
  primary key (market_address, action_id)
);

create table source_event (                            -- the Session Event Log, append-only, partitioned by room
  room_id     text   not null,
  seq         numeric not null,
  source      text   not null,
  participant text,
  kind        text   not null,
  observed_at timestamptz not null,
  ingested_at timestamptz not null,
  facts       jsonb  not null,
  derived     jsonb  not null,
  raw_ref     text   not null,                       -- archived provider payload
  raw_hash    bytea  not null,
  raw_query   jsonb  not null,                       -- the request that produced it, for re-fetch
  prev_hash   bytea  not null,
  hash        bytea  not null,
  connector_signature bytea not null,
  primary key (room_id, seq)
);

create table publication_permit (                      -- signed permits, kept for audit and replay
  room_id           text not null,
  nonce             numeric not null,
  slot_index        int  not null,
  condition_hash    bytea not null,
  params_hash       bytea not null,
  undecided_through numeric not null,
  expires_at        timestamptz not null,
  signature         bytea not null,
  outcome           text not null,                    -- signed|refused|consumed|expired
  refusal_reason    text,
  primary key (room_id, nonce)
);

create table room_event (                              -- the published Room Sequence delta log
  room_id    text   not null,
  room_seq   bigint not null,
  type       text   not null,
  at         timestamptz not null,
  source_seq numeric,
  chain_ref  jsonb,
  payload    jsonb  not null,
  primary key (room_id, room_seq)
);
```

Chat, notifications, subscriptions, presence, and the outbox live in their own tables and are never inputs to any of the above.

Two rules keep the projections honest:

- `implied_prob_a` is the **cleared** price from on-chain reserves. Pending actions are surfaced separately as pending pressure and never folded into the displayed price.
- Any row whose `block_number` trails the chain head by more than the configured threshold is served with a staleness flag, and the UI shows delayed data rather than confident data.

## Real-time protocol

### Connect and resume

```
GET  /v1/rooms/{roomId}                     Room Snapshot at room_seq
WS   /v1/rooms/{roomId}/stream?since={seq}  deltas after that Room Sequence
```

The server opens with `hello`, carrying the current `room_seq`, the retention floor, and the heartbeat interval. If `since` is below the retention floor the server replies `resync` and the client refetches the snapshot. Retention is ten minutes of room deltas in Redis and the full log in Postgres for replay.

### Envelope

Every frame carries provenance.

```json
{
  "room": "room_01J9F2",
  "seq": 48213,
  "type": "slot.gate_changed",
  "at": "2026-08-18T20:41:07.412Z",
  "source_seq": 918341,
  "chain": { "block": 12345678, "tx": "0x…", "log_index": 3 },
  "payload": { "slot_index": 2, "gate": "suspended", "reason": "source_stale" }
}
```

- A frame derived from chain state carries `chain`.
- A frame derived from source facts carries `source_seq`.
- A frame with neither is presentation-only and the client must render it as such. Chat, viewer counts, and stream health are the only permitted presentation-only frames.

### Event catalog

| Group | Types |
|---|---|
| Control | `hello`, `heartbeat`, `resync`, `error` |
| Room | `room.state_changed`, `room.program_changed`, `room.focus_changed` |
| Slot | `slot.published`, `slot.opened`, `slot.gate_changed`, `slot.price_changed`, `slot.liquidity_changed`, `slot.epoch_cleared`, `slot.closed`, `slot.provisional`, `slot.challenged`, `slot.final`, `slot.invalid` |
| Source | `source.watermark`, `source.freshness_changed`, `source.decisive_event`, `score.updated` |
| Activity | `trade.executed`, `action.pending`, `action.cleared`, `action.refunded`, `liquidity.added` |
| Presentation | `stream.health_changed`, `viewers.updated`, `chat.message`, `chat.deleted`, `chat.pinned` |
| Private channel | `user.action_state`, `user.position_changed`, `user.claimable` |

`heartbeat` fires every ten seconds carrying `room_seq`, the latest `source_seq`, and source freshness age, so a client can detect a dead connection itself. A missing heartbeat means **connection lost**, never **market suspended**.

The private channel is scoped to one address, requires a wallet signature to subscribe, and carries nothing that is not already public on chain. It exists for latency and convenience, not confidentiality.

### Ordering guarantees

- `room_seq` is gap-free and strictly increasing per room. A client that sees a gap must resync.
- Frames for one slot are ordered. Frames across slots are ordered only by `room_seq`.
- A `slot.closed` frame is never followed by a `slot.price_changed` or `slot.opened` for the same slot.
- The Coordinator publishes a chain-derived frame only after the indexer has the log; it never predicts a transaction's effect.

## HTTP surface

Read and social only. There is no trading endpoint, because there is no trading path through this tier.

```
GET  /v1/rooms?state=live|upcoming|final&cursor=      room cards for discovery
GET  /v1/rooms/{roomId}                               Room Snapshot
GET  /v1/rooms/{roomId}/program                       full slot list with conditions
GET  /v1/rooms/{roomId}/slots/{index}                 one slot with market state and quote inputs
GET  /v1/rooms/{roomId}/events?since=&limit=          Room Sequence replay
GET  /v1/rooms/{roomId}/tape?since=                   executed trades and liquidity events
GET  /v1/rooms/{roomId}/scores                        Official Scores with source sequences and timestamps
GET  /v1/rooms/{roomId}/chat?since=                   chat history
POST /v1/rooms/{roomId}/chat                          wallet-authenticated, rate limited, moderated
GET  /v1/markets/{address}                            market read model
GET  /v1/markets/{address}/settlement                 evidence bundle, quorum, challenge, timeline, stream timecodes
GET  /v1/accounts/{address}/portfolio                 positions, LP positions, pending actions, claimables
GET  /v1/accounts/{address}/history                   settled activity with links to chain
POST /v1/notifications/subscribe                      web push or email, wallet-authenticated
GET  /v1/health                                       per-component health for the UI's honest status strip
WS   /v1/rooms/{roomId}/stream                        real-time deltas
WS   /v1/accounts/{address}/stream                    private channel, signature-gated
```

The settlement response includes the immutable Outcome A and Outcome B display
labels read from the child market, plus `winner_name` when a decisive outcome
maps to a known label. Missing labels remain `null`; source account keys and
wallet addresses are never promoted into display names. Its final timeline
moment uses the `ResultFinalized` log block, not the market row's latest refresh
block.

Quotes are computed client-side from cleared reserves using the same `MarketMath` port the app already has, so a wrong or lagging Coordinator cannot mis-quote a trade. `/v1/slots/{index}` returns reserve inputs and the block they came from, not a price the client is expected to trust blindly.

Authentication is a wallet signature over a domain-bound, expiring challenge, used only for chat, notifications, and the private channel. No session grants any market authority.

## Chat, playback, and history

### Chat

Off-chain, non-authoritative, and never evidence. Wallet-signed identity, per-address and per-IP rate limits, a pinned rules message stating that chat cannot change a result, moderator delete and timeout with an audit trail, and slow mode during high-volume moments. Participants and production insiders are labelled. Chat is retained with the room so a settlement replay can show what the room saw, clearly marked as commentary.

### Playback

The stream is embedded or ingested per the Competition Template's frozen policy. The Playback Service polls provider health and publishes `stream.health_changed` with three values: `live`, `degraded`, `unavailable`. It also records the mapping from stream timecode to source sequence, which is what makes a settlement replay legible: the decisive moment can be shown at the video position where it happened, while the result still comes from the source.

The UI must display stream failure as **Livestream unavailable** and never imply that the Competition Source failed. The reverse also holds: a suspended Market Gate with a healthy stream reads **Market suspended — score feed delayed**.

### Settlement history

Every finished slot produces a replay: the question and its frozen Closing Condition, the source events that decided it with sequences and timestamps, the condition evaluator version and hash, the Decisive Event, the epochs that cleared and the ones that refunded, the Evidence Bundle, resolver attestations and quorum, any challenge and its verdict, the final payout vector, and the claim transactions. Each entry links to chain. This is the artifact that makes the integrity story visible instead of merely true.

## Degradation matrix

| Failure | Effect on money | Room behaviour | What the UI says |
|---|---|---|---|
| Coordinator down | None | Markets keep running; gate keeps clearing | App falls back to direct RPC reads; **Live updates unavailable** |
| Realtime Edge down | None | Snapshots still served over HTTP | Polling mode banner |
| Indexer lagging | None | Read models stale | **Data delayed** with the block age |
| Chat service down | None | Markets unaffected | Chat panel unavailable |
| Playback down | None | Markets unaffected | **Livestream unavailable** |
| Source stale | No epoch clears | Gate suspends; pending actions wait | **Market suspended — score feed delayed** with last sequence |
| Source stale past threshold | Pending actions refund at maximum pending time | Slot closes, recovery, then Invalid if unverifiable | Explicit recovery countdown |
| Gate Authority down | No epoch clears; actions refund at timeout | Nothing executes | Suspended, then refunded — never a silent hang |
| Program Publisher down | None | No new slots; open slots continue | Program shows no upcoming question |
| Resolver offline | No Provisional Result | Missing quorum after the deadline fails to Invalid | Resolution status with the deadline |
| RPC down | Submissions fail in the wallet | No state change | Wallet-level error, no phantom pending action |
| One slot's gate call reverts | That slot does not clear; its epoch refunds at timeout | Other slots clear normally | That slot shows pending, then refunded, with the skip reason |
| Coordinator compromised | **None** | It can lie about presentation only | Chain-verifiable fields let the client detect divergence |
| Connector compromised | **Severe**: early close, forced suspension, or wrong score | Resolver reconstruction diverges from the derived score | Resolution blocked, then Invalid — never a confident wrong result |
| Gate key compromised | Can suspend, close early, or permit a question | Cannot resolve, cannot move collateral, cannot publish alone | Suspension and closure are visible on chain with sequences |
| Publisher key compromised | Cannot publish without a gate permit | No rigged question can open | Program shows only permitted slots |

The last row is the design's whole point. Every other row is an availability problem; none of them is a solvency problem.

## Operational invariants

1. The Coordinator holds no private key that any market contract honours.
2. No API endpoint accepts a Forecaster order, a position transfer, or a liquidity deposit.
3. The gate signer never signs a sequence it has not evaluated for that exact market.
4. On-chain writes are idempotent by construction: the key is `(market, epoch, call)`, retries reconcile against chain state before resubmitting, and one writer owns each key.
5. Every published market number is traceable to a block; every published source number to a sequence.
6. A slot's Closing Condition, condition hash, Resolver Set, and Winner Reward setting are immutable after publication.
7. The Session Event Log is append-only, hash-chained, and archived before a room reaches `final`.
8. Read models are disposable; deleting them loses no authority and no funds.
9. Room state is derived, never asserted: the Coordinator publishes what the chain and the log already say.
10. Concurrency limits and the Announce Delay are enforced on chain, not only in the service.
11. One Integrity Bond per Participant covers a whole Live Session and is released only after every slot in the room is Final or Invalid.

## Metrics and alerts

| Signal | Target | Alert |
|---|---|---|
| Gate lag: source `observed_at` → on-chain safe mark | < finality delay + 3s p95 | Page at 2× for 60s |
| Epoch clear latency: submission → executed | < finality delay + epoch duration + 5s p95 | Page on breach |
| Indexer lag | < 3 blocks | Warn at 10, page at 50 |
| Room fanout lag: chain log → client frame | < 500 ms p95 | Warn at 2s |
| Source freshness age | < template threshold | Page on suspension |
| Watermark cadence | one per epoch per open market | Page on a missed epoch |
| Refund rate from missed clearance | ~0 | Page on any non-zero rate |
| Stream health | `live` | Warn only, never paged as a market incident |

## First Competition Template

These values are frozen for the first testnet template. They are starting points chosen to be measured and revised, not final protocol constants, and every one of them is disclosed in the interface before a Forecaster signs anything.

| Parameter | Value | Note |
|---|---|---|
| Competition Source | Hyperliquid testnet | Both Participants on the same source; never one source per Participant |
| Forecasting Epoch | 10 s | Measure `epoch_clear_p95` before changing |
| Source Finality Delay | 10 s | Measure against observed provider correction behaviour |
| Disclosed clearing time | "Usually clears in about 20 seconds" | Epoch plus finality delay, stated in the ticket, not buried |
| Maximum pending time | 90 s, then refund | The honest ceiling on how long a Forecaster's USDC can sit uncleared |
| Concurrent markets | Headline plus one micro | Enforced on chain by the room's frozen maximum |
| Announce Delay | 30 s minimum | Bound into the Publication Permit |
| Micro-market activation | Headline must be backed first | `publishSlot` requires `slot0.hasLiquidity()` for any `slotIndex > 0` |
| Winner Reward, `participant` and `race` | 100 bps | Paid to the winning Participant's reward address |
| Winner Reward, `threshold` | 0 bps | Yes and No are not Participants |
| Jurisdiction | Closed allowlist, no-value testnet, until legal review | Interface-level only; see below |

### Why Hyperliquid first

Hyperliquid's public API exposes account state, fills, and WebSocket updates addressed by account, and a reconnecting subscription can be reconciled against the information endpoint to recover missed data. That means the first connector reads a **public address**, not a Participant's exchange credentials. Not holding participants' API keys in the first version removes an entire class of custody, secret-management, and liability problems from the earliest and least-hardened part of the stack, and it makes the Linked Competition Account boundary a public fact a resolver can independently re-fetch.

Both Participants must be on the same source in the same session. A cross-source competition would require normalizing two different fill semantics, two clocks, and two correction behaviours into one comparable Official Score, which is a research problem rather than a first template.

### Access and jurisdiction, stated honestly

The testnet runs behind a closed allowlist with no real value until legal review completes. Be precise about what that is: **an interface control, not a protocol control.** The contracts remain permissionless apart from the restricted wallet list, so an allowlist on the API and the room stream restricts who uses TraderMarket's interface, not who can transact with a deployed market. The real containment during this phase is that the collateral is Circle test USDC with no real-world value.

The allowlist gates the HTTP surface, the room stream, and chat. It does not gate reading the chain, and the interface must not imply otherwise.

## Delivery order

Issues live in `issues/`. Dependencies are recorded per ticket; the phases below are the intended sequence.

**Phase 1 — make the chain support a room.** In dependency order: 01 room binding and configurable Winner Reward, 15 the delegated liquidity entry point, 02 the `LiveRoom` contract with permit verification and isolated batching, 13 room-scoped Integrity Bond on that contract, 03 deterministic slot addresses. Every market-contract change lands together here, because redeploying the market implementation mid-program would strand live rooms. At the end of this phase a room with several slots is deployable and gateable in one transaction, and the existing Foundry suite still passes in standalone mode.

**Phase 2 — make the source real and the result independently checkable.** 04 Session Event Log and the Hyperliquid connector with raw retention, 05 the Source Gate Authority including Publication Permits, 14 resolver nodes with independent reconstruction. Resolvers belong in this phase and not later: a source pipeline without an independent check is exactly the trust assumption this design refuses.

**Phase 3 — make the room observable.** 06 the indexer, 07 the Coordinator, 08 the Program Publisher. At the end of this phase a room can run a rolling program end to end with no browser attached.

**Phase 4 — make it a product.** 09 realtime edge, chat, and playback, 16 room liquidity commitments, 10 the app on the room API with its RPC fallback, 11 settlement history and replay, 17 the testnet allowlist.

**Phase 5 — make it operable.** 12 observability and the operating runbook, then a full game day.

Game day is two exercises, and both must pass. `contracts/test/GameDayTest` runs a
complete session on a real EVM. `services/live-room` `npm run gameday` deploys
the real contracts to a clean Anvil chain and drives them with the **real
services** — the gate signing real permits a real room verifies. The second is
not optional and the in-memory `FakeRoomChain` is not a substitute for it: three
defects reached this specification's "complete" claim precisely because the fake
hid them. A BigInt/Number seam read a live room as closed; a fixed gas stipend
silently starved `processRoom`; and gas estimation converged on a limit that
skipped all the work and reported success. None were visible to any unit test.

The money-critical set does not align perfectly with the phase boundaries, so name it explicitly rather than implying "later means safer": issues 01, 15, 02, 13, 03 (Phase 1, contract code), 04, 05, 14 (Phase 2, the source pipeline, the gate key, and the resolver quorum), **16** (Phase 4, but a contract holding LP allowances that can initiate USDC movement — it gets the same Foundry-level invariant testing and audit treatment as Phase 1, not product-code treatment), and **08** (Phase 3, a keyed service whose signer decides which questions exist). Everything else — the Coordinator, edge, chat, playback, indexer, app, allowlist — is projection and interface work whose worst failure is an unavailable or wrong display.

## Non-goals

- Any custody, matching, netting, or order routing in the off-chain tier.
- Coordinator-authored results, scores, prices, or gate decisions.
- Off-chain balances, credits, or internal ledgers.
- Cross-slot shared liquidity, migrated reserves, or parlays across slots.
- Unbounded concurrent questions in one room.
- Subjective, creator-judged, or audience-voted questions.
- Chat, reactions, or viewer counts as any kind of input to settlement.
- Multi-room shared feeds; one Live Session, one Session Event Log, one `LiveRoom`.

## Decisions still open

The first template's source, timing, concurrency, reward, and access parameters are frozen above. What remains:

1. **Integrity Claim adjudication on testnet.** Room bond release depends on a claim window with a published authority, deadline, and destination. Who adjudicates, and where a forfeited bond goes.
2. **Dual-connector policy.** Whether the first template runs two independent connectors over Hyperliquid and treats divergence as `unevaluable`, or accepts a single connector plus resolver reconstruction as sufficient for testnet.
3. **Exact Competition Metric and tie threshold** on Hyperliquid fills: which fills count, how unrealized positions are treated at the terminal condition, precision, and the exact-tie band.
4. **Terminal condition for the first template.** The Closing Condition of the headline slot is the one condition that ends the session, and it must be objectively detectable from fills alone.
5. **Chat identity model**, moderation authority, retention, and whether an allowlisted visitor may read chat without connecting a wallet.
6. **Stream provider**, disclosed delay, recording retention, and timecode mapping precision.
7. **Room event log retention and archival format**, and whether published Room Snapshots are signed so a third party can prove what the room displayed.
8. **`MAX_BATCH` and the child gas stipend** for batched gating, which must be measured against a room at its concurrency cap rather than guessed.
9. **Headline replacement.** Whether the headline slot may be replaced if the terminal condition changes shape mid-session. Recommended: no; invalidate and open a new room.
10. **Production legal review**: jurisdiction, age, Terms, market integrity, and consumer protection, which is a launch blocker and requires qualified advice before anything carries real value.

## Acceptance criteria

- A room can be created, armed, and run through a full session with a headline slot and at least three sequential micro slots, all resolved from one Session Event Log.
- The Gate Authority refuses to sign a Publication Permit for a condition that is already decided, and logs the refusal with its evaluated sequence.
- On chain, a `publishSlot` call is rejected when the permit signature is absent, from a non-gate signer, expired, valid for longer than `MAX_PERMIT_LIFETIME` from now, replayed, cut at a sequence below `lastObservedSequence()`, bound to different hashes than the request, or aimed at a `slotIndex` other than `slots().length`. A test asserts each rejection separately.
- A successful publication advances `lastObservedSequence()` to the permit's attested sequence; a later gate call at a lower sequence reverts.
- Neither the publisher key alone nor the gate key alone can publish a slot.
- A micro slot cannot be published while slot 0 reports no liquidity.
- One `markRoomEpochsSafe` transaction clears epochs for every open slot in the room.
- A child market that reverts inside a batch is skipped with a `SlotCallSkipped` event, every other slot in the same batch clears, and the skipped market can be retried at the same room sequence.
- A micro slot's Decisive Event closes only that slot; the headline slot keeps trading.
- The terminal condition closes every open slot, and `closeRemainingSlots` can be called by an unprivileged address afterwards.
- Killing the Coordinator mid-session changes no market state; the app falls back to direct RPC reads and every settlement completes.
- Killing the Gate Authority mid-epoch clears nothing and refunds every affected action at the maximum pending time.
- A client reconnecting with a stale cursor receives `resync` and rebuilds identical state from the snapshot.
- Stream failure, source staleness, and connection loss produce three visibly different states in the UI.
- Every displayed price traces to a block; every displayed score traces to a source sequence.
- A finished slot's replay reproduces its result by rerunning the archived evaluator over the archived log.
- A resolver reconstructs a result from raw provider data re-fetched with the archived `raw_query`, without reading our derived score, and reaches the same payout vector.
- A deliberately corrupted normalized event is detected by resolver reconstruction, and the market fails to Invalid rather than resolving to the corrupted side.
- A room with five slots requires exactly two Integrity Bond transactions, and no bond is claimable until the room is closed, every slot is Final or Invalid, and the claim window has elapsed.
- An LP with one approval and one signed commitment supplies liquidity to a slot published later, executed by an unrelated address, and receives that slot's LP Position, fees, and refunds.
- A commitment capped at N simultaneous slots executes against slot N+1 only after a settled slot's exposure is released permissionlessly, and the commitment contract's USDC balance is zero at the end of every transaction.
- The re-fetched raw window for any event matches on immutable fill identifiers and normalized facts, with the archived original bytes matching `raw_hash`.
- Dropping and rebuilding every read model reproduces byte-identical room state from chain logs plus the Session Event Log.
