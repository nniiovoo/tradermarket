# Runbook: operating a Live Room

Companion to [POLYGON_AMOY_MVP.md](./POLYGON_AMOY_MVP.md), which covers deploying and hand-driving a single standalone market. This runbook covers a **Live Room**: one Live Session carrying a headline market plus rolling micro markets, driven by the Source Gate Authority rather than by hand.

This is unaudited, no-value testnet software. Circle test USDC has no real-world value. Do not operate this with production keys or real collateral.

## Who holds what

Four signing domains. The Coordinator is not one of them.

| Role | Key | May do | May never do |
|---|---|---|---|
| Source Connector | connector signer | Sign normalized log events | Touch any market |
| Source Gate Authority | `GATE_SIGNER_ROLE` | Mark epochs safe, suspend, reopen, close, sign Publication Permits | Publish a slot alone, resolve, move collateral |
| Program Publisher | `PROGRAM_PUBLISHER_ROLE` | Publish an approved slot **with** a gate permit | Gate, resolve, publish without a permit |
| Resolver Set | `RESOLVER_ROLE` ×3, separate operators | Attest results, answer challenges | Gate, publish, change custody |
| Live Room Coordinator | **none** | Read, project, publish room state, request a slot | Anything on chain |

Rotate by deploying a new room: room roles are frozen at initialization and cannot be changed on a live room. That is deliberate.

## Arming a room

1. Deploy or reuse the implementations and factory (`DeployAmoy`), which now deploys the market implementation, the `LiveRoom` implementation, and the factory.
2. Create the room with `createRoom(config)`. Freeze: `headlineTemplateId`, gate signer, publisher, adjudicator, participants, reward addresses, bond recipient, liquidity router, the three resolvers, `epochDuration`, `sourceFinalityDelay`, `maxPendingTime`, `minAnnounceDelay`, `maxPermitLifetime`, `integrityClaimWindow`, `integrityClaimTimeout`, `challengeWindow`, `challengeTimeout`, `gateStallTimeout`, `maxOpenSlots`, and the approved template catalog with each template's Winner Reward setting.

   `challengeWindow`, `challengeTimeout` and `gateStallTimeout` were missing from
   this list and are **not optional**: `LiveRoom.initialize` reverts `InvalidConfig`
   if any of the three is zero, so a room built strictly from the old list could
   not be created at all.

   The timing values `CreateAmoyRoom` actually defaults to are `epochDuration` 60s,
   `sourceFinalityDelay` 15s, `maxPendingTime` 900s, `challengeWindow` 600s,
   `challengeTimeout` 1800s, `minAnnounceDelay` 30s, `maxPermitLifetime` 300s,
   `integrityClaimWindow` and `integrityClaimTimeout` 3600s each,
   `gateStallTimeout` 21600s, and `maxOpenSlots` 4 — a headline plus three micro
   markets. ADR 0023 freezes the first Hyperliquid-testnet template at 10s / 10s /
   90s and a headline plus one micro market instead. **The two disagree**, and the
   deploy command further down this runbook uses the script defaults. Reconciling
   them is tracked as an open issue — until then, pass the values
   you intend explicitly rather than relying on either default.
3. Both Participants call `postIntegrityBond()` **on the room**, once each, for the whole session. Markets refuse per-market bonds in room mode.
4. Start the connector against the Participants' public addresses. It needs no exchange credentials.
5. Confirm `/v1/health` shows `source: fresh` before publishing anything.

## Publishing a slot

Publication needs two authorities and neither can act alone. In production they
are two processes holding two different keys, so the request between them goes
through a **durable queue** in the shared `TM_DATA_DIR` rather than a function
call. Each step is written down before the next one starts, so either process
can die at any point without losing the question.

```
queued ──publisher validates──▶ awaiting_permit ──gate signs──▶ permitted ──publisher submits──▶ published
   │                                   │                                                              │
   ▼                                   ▼                                                              ▼
rejected                            refused                                                        failed
(not in the catalogue)     (the gate said no, with a reason)                            (the room refused it)
```

1. An operator queues a candidate — template id, parameters, question text:

   ```bash
   TM_ROOM_ID=… TM_DATA_DIR=… npm run queue-question -- \
     --template tpl-participant-v1 \
     --question "Who reaches \$10,000 realized PnL first?" \
     --param target=10000
   ```

   It is a separate command rather than a Coordinator endpoint on purpose: the
   Coordinator holds no key and decides nothing, and WHICH question to publish
   is an operator's decision.

2. The **Publisher** process validates it against the frozen catalog, builds the
   condition document and the complete slot request, and stops. It cannot decide
   whether the question is still open — that is what the second key is for.
3. The **Gate** process signs the permit, in its own process, with the gate key.
   It evaluates the Closing Condition at the current tip, signs only when the
   result is `undecided`, and computes both hashes itself from the submitted
   documents — including a canonical hash of the **complete** request and its
   restricted-wallet list, so nothing about the question can change after
   signing. It also fills in `slotIndex` from the room's own slot count, because
   the room requires those to match exactly and only the chain knows it.
4. The **Publisher** submits `publishSlot(request, permit, signature, restricted)`
   with the publisher key.

One publication is in flight at a time. A permit binds a slot index and the room
requires it to equal the current slot count, so two outstanding permits are two
permits for the same index and only one of them can ever be submitted.

Things that go wrong here, and what happens:

| Situation | What the publisher does |
|---|---|
| Permit expired while the publisher was down | Discards it and asks the gate again. After three such attempts the request fails rather than being published by a process that keeps waking up late. |
| Another slot was published first | Same: the permit is for the wrong index, so it is discarded and re-requested before any transaction is sent. |
| Transaction landed but the receipt was lost | Reconciles against the chain. The room marks the permit nonce used inside the same call that deploys the market, so a consumed nonce means the publication happened; the record is updated instead of a second market being published. |
| The room refused the transaction | Recorded as `failed` with the revert reason. |

Each authority process checks at start that the room actually names its address
— `gateSigner` for the gate, `publisher` for the publisher — and exits with the
address the room does want if not. Without that check a process with the wrong
key validates, queues, takes a permit and burns it on a transaction the room was
always going to refuse, once per request, forever.

**A refused permit is a normal outcome, not an incident.** `condition decided` means the question is no longer open; `condition unevaluable` means it cannot be scored. Never retry a refusal blindly — pick a different question.

Rules the chain enforces, so a mistake fails loudly: the caller must be the publisher; the signature must be the gate's; the nonce must be unused; the permit must not be issued in the future, must be unexpired, and must declare a lifetime within `maxPermitLifetime` measured from its signed `issuedAt`; `undecidedThroughSequence` must not trail `lastObservedSequence()`; the request hash must match the complete submitted request **and its restricted list**; `slotIndex` must equal `slots().length`; slot 0 must use the headline template; any later slot needs slot 0 backed by liquidity; and the open-slot count must be below the cap.

Only the registered room may create its own slot markets, and a slot's config must match the deterministic salt — the factory admin cannot mint a market into someone else's room.

## Normal operation

The gate loop runs one tick per epoch, in this order:

1. **Decide.** If the headline's condition is decided, `closeRoom` at the deciding sequence and stop. If a micro slot's condition is decided, `closeSlots` for that slot only.
2. **Freshness.** Stale source → `suspendRoom`. Recovered → `reopenRoom`. Nothing clears while stale.
3. **Clear.** For each open, still-undecided slot, mark one completed epoch safe at the tip sequence — one per market per tick, because each market requires a strictly increasing sequence. It picks the oldest epoch that actually **holds pending actions**; empty epochs are skipped, since marking one achieves nothing and would consume the single clearance that market gets at this sequence.
4. **Process.** Push cleared epochs through `processRoom`, with an explicit gas limit.

The gate must tick at least once per epoch. It clears one epoch per market per tick, so a gate that falls behind cannot catch up faster than the source sequence advances, and pending actions will refund at `maxPendingTime`.

Heartbeats matter: they are how silence is distinguished from staleness and how the sequence advances during quiet periods. A connector that stops heart-beating will suspend the room.

## Failure playbook

| Symptom | What is happening to money | Do this |
|---|---|---|
| `gate_lag_seconds` paging | Nothing yet; actions are pending | Check connector freshness, then the gate signer's RPC and nonce. Actions refund at 90s — you have time, but not much |
| `SlotCallSkipped` on a market | That epoch will not clear; those actions refund | Retry that market alone at the **same** room sequence. If it still reverts, read the revert reason in the event |
| Room suspended, source stale | Nothing clears; pending actions wait | Fix the connector. If the outage outlives the epoch, expect refunds — that is the design |
| Gate offline entirely | Everything pending refunds at `maxPendingTime` | Anyone can call `processEpoch`/`processRoom` to push the refunds. Do not try to "catch up" the gate past a decision |
| Resolver divergence | No attestation; the market will invalidate | Do not override. Publish the divergence. Failing closed is correct |
| No resolver quorum by the deadline | Market fails to Invalid | Call `invalidateUnresolved()`. Collateral returns; winner fees refund to payers |
| Coordinator down | **Nothing** | Restart it. The app falls back to direct RPC reads and says so |
| Indexer behind | Stale reads only | Restart; it rebuilds from genesis with no manual intervention |
| Stream down | **Nothing** | Fix the stream. Never let anyone read this as a market problem |
| Room stuck open after the terminal event | Pending actions could be trapped | Anyone calls `closeRemainingSlots` once `roomClosedSequence` is set |
| Room suspended, condition `unevaluable` | Nothing clears | Fix the source or the condition inside the grace period. If it expires, the market closes on its own and goes to Resolution — recovery if the facts can be rebuilt, Invalid if not. Do not override |
| `processRoom` reverts `InsufficientGas` | Nothing executed; the batch did nothing and said so | Raise the gas limit or shrink the batch. Never "fix" this by lowering the floor: the silent version of this bug starved execution invisibly |
| Provider restates a fill | The log carries a figure the provider has withdrawn until the sweep runs | Nothing to do: the reconciliation sweep re-asks the recent past and appends the restatement as a correction, and everything that folds the log counts the fact once at its latest value. Check `[connector] N correction(s) from reconciliation` in the connector's log |
| `hyperliquid window saturated` | The connector stopped rather than record a total missing trades | A full page of fills inside one millisecond, which no time window can step over. The source will go stale and the room will suspend — that is the intended failure. Raise the page limit if the provider supports it; do not "fix" this by skipping the window |
| Room decided at a sequence behind its watermark | Nothing; the close is recorded honestly | A restatement made the terminal condition true earlier than anyone knew. The gate closes at a sequence the chain accepts and the audit keeps the sequence the session actually ended at (`retroactive: true`) |
| Gate restarted | Nothing | It resumes from persisted state: nonces do not rewind, the audit survives, and suspension is re-read from chain. Verify with `durableState()` |

## Closing a session

1. The headline's decisive event triggers `closeRoom(decisiveSequence)`. This is irreversible and blocks all further publication.
2. Any address may call `closeRemainingSlots(markets)` to close what is left.
3. Resolvers reconstruct each slot **from raw provider data**, not from our derived scores, and attest. Two matching attestations register a Provisional Result; a 10-minute Challenge Window follows.
4. After the window, `finalizeUnchallenged()`. An upheld or unreviewed challenge, or a missing quorum, ends in Invalid.
5. Forecasters redeem, LPs settle inventory and claim fees, the winning participant claims the reward pool, and invalid markets refund winner fees to their payers.
6. Room bonds release only when **all four** hold: the room is closed, no further slot can be published, every slot is Final or Invalid, and the Integrity Claim Window has passed with no unresolved claim.

## Game day

Three exercises. All must pass before any deployment. Give each chain-driving
run its own fresh Anvil: both game days move chain time forward, and a second
run on the same chain fails on a timestamp that cannot go backwards.

```bash
cd contracts && forge test --match-contract GameDayTest -vv
```

```bash
cd services/live-room && anvil --port 8545 --silent & npm run gameday
```

The first runs a complete Live Room on a real EVM: headline plus three
sequential micro markets, permits, gating, suspension and recovery, a decisive
close, a refunded overlapping epoch, a challenge that invalidates, a tie, an LP
commitment executed by a stranger, every claim, and bond release.

The second is the one that proves the seam between the services and the chain.
It deploys the contracts to a clean Anvil chain and drives them with the real
connector, gate, publisher, and resolver nodes — the gate signing permits a real
room verifies. It needs `forge build` to have run, because it loads bytecode
from `contracts/out`.

```bash
cd services/live-room && anvil --port 8545 --silent & npm run live-gameday
```

The third replaces the recorded session with a real HTTP provider that
misbehaves the way providers do: it repeats fills across overlapping windows,
drops a connection, goes down long enough to suspend the room, and restates a
figure it already reported. The run ends on the check the whole exercise exists
for — a market settling on the corrected figure, with the counterfactual printed
beside it showing the stale figure would have paid the other side.

**The in-memory fake is not a substitute for this run.** Three real defects
survived a full unit suite because the fake hid them: a BigInt/Number seam that
read a live room as closed, a fixed gas stipend that silently starved
`processRoom`, and gas estimation converging on a limit that skipped all the work
and reported success. If you change anything at the service-to-contract
boundary, run the real game day.

### Gas, specifically

`processRoom` executes real market work and must never run on an estimated gas
limit. The room isolates child failures, so a starved batch looks like a
successful transaction that did nothing; and because the skip path is cheap, an
estimator will converge on exactly that limit. The contract now refuses a batch
it cannot run, and the chain port sets explicit gas floors. If you write another
caller, set an explicit limit.

## Serving the room to a website

The Coordinator process is read-only. It holds no chain key, and nothing it
serves can move money.

```bash
cd services/live-room
TM_ROOM_ID=<room> TM_RPC_URL=<rpc> TM_FACTORY_ADDRESS=<factory> \
TM_ROOM_ADDRESS=<room-contract> TM_CHAIN_ID=<id> \
TM_ROOM_API_URL=<public-url> TM_PORT=8787 npm run serve
```

It refuses to start without all four chain settings. That refusal is the design:
there is no fixture mode, so a website pointed at this API can rely on
everything it reads having come off a chain.

On start it prints each capability and, for the ones it lacks, the reason. Read
that block before announcing anything — `gas_sponsorship`, `livestream`, `chat`,
`funding_faucet`, `referrals`, `social_proof` and `legal_availability` are all
off until something real configures them, and `legal_availability` cannot be
configured on at all.

**If a settlement record shows no participant mapping**, set `TM_PARTICIPANT_A`
and `TM_PARTICIPANT_B` to the source participant keys that correspond to Outcome
A and Outcome B. Without both, settlement records are omitted rather than
guessed: guessing here would mislabel who won.

**If chat is enabled**, set `TM_CHAT_MODERATORS` to the moderator addresses.
Both posting and moderating are signed over a bound claim — a string naming the
purpose, the room, the actor, the action and the moment — which expires after
five minutes and can be used once. A moderator with no signing key cannot
moderate, and a signature captured from one room or one deployment is useless in
another. The moderation audit log is durable when `TM_DATA_DIR` is set: it is the
`chat_audit` table in `room.db` and the backup script carries it. With no
`TM_DATA_DIR` the whole service is in-memory and the log goes with it.

**If chat posts start failing with "a signed claim is required"**, the website
build predates the bound-claim format. Deploy the current build; there is no
compatibility fallback, because accepting a bare-text signature would discard
every property the claim exists to guarantee.

**If a portfolio says "Not known" rather than claimable or claimed**, the process
has no chain reader for the per-account balances — `lpFeeCredit` and
`winnerFeePaid`. `buildService` wires one automatically; a custom composition that
omits it gets the honest unknown rather than a wrong zero.

**If the room is permanently empty and reports state "draft"**, check the log
and `/v1/health` for a `config_warning`. `TM_ROOM_ID` and `TM_ROOM_ADDRESS` must
name the same room; the process detects the mismatch as soon as the room is
indexed and says which id the contract actually carries.

**If the website reports "Failed to fetch" on personalised surfaces only**
(portfolio, entry status) while public pages work, the browser's CORS preflight
is being refused. The service allows `content-type` and `x-tm-address`; a proxy
in front of it must not strip them.

## Running the whole thing

Six processes, five of them holding a different key. Splitting them is not
ceremony: publication needs the Program Publisher role **and** a Gate signature,
and a quorum needs two resolvers who are not each other. One process holding two
of those keys makes the pair meaningless.

The keeper is the exception that proves the rule: it holds a key but **no
authority**. Every function it calls is permissionless, and the contract decides
whether it is time. Its key needs gas and no on-chain role. It is still a
separate process, and `preflight` still requires its address to differ from every
other — not for authority separation, but because two processes signing with one
key contend for nonces and silently drop each other's transactions.

```bash
# The Coordinator. Read-only, holds no key.
TM_DATA_DIR=/var/lib/tradermarket TM_ORACLE_OPERATOR_TOKEN='<long-random-secret>' \
TM_ROOMS="gameday=0xROOM,second=0xROOM2" TM_FACTORIES="0xFACTORY" \
TM_RPC_URL=… TM_CHAIN_ID=80002 TM_ROOM_API_URL=https://… TM_PORT=8787 \
npm run serve
```

```bash
# One per authority, each with its own key and the same TM_DATA_DIR.
TM_GATE_KEY=…       npm run operator gate
TM_PUBLISHER_KEY=…  npm run operator publisher
TM_CONNECTOR_KEY=…  TM_SOURCE=… TM_PARTICIPANTS="alice=0x…,bob=0x…" npm run operator connector
TM_RESOLVER_KEY=…   TM_PARTICIPANTS="alice=0x…,bob=0x…" npm run operator resolver
# Holds no authority. Without it, markets reach a result and nobody can be paid:
# every payout path on the market contract is onlyFinal.
TM_KEEPER_KEY=…     npm run operator keeper
```

**If the keeper is not running, nothing is lost — but nothing is paid.** A
market whose challenge window has elapsed stays at `finalOutcome == Unset`, and
`redeemPositions`, `settleLpInventory`, `claimWinnerReward` and
`claimIntegrityBond` all revert. The three functions it calls are permissionless,
so a stranger can always finalize a market by hand; the keeper is what makes it
happen without one.

A room's HLS health signal is its own room's fact, the same way `TM_ROOMS`
above already makes chat and event frames. `TM_STREAM_PLAYBACK_URLS` carries
one entry per room, same `roomId=value` shape as `TM_ROOMS`:

```bash
TM_STREAM_PLAYBACK_URLS="gameday=https://cdn.example.com/gameday/live.m3u8,second=https://cdn.example.com/second/live.m3u8"
```

A single-room deployment may keep using the older `TM_STREAM_PLAYBACK_URL`
instead. Once a deployment sets `TM_STREAM_PLAYBACK_URLS` at all, a room left
out of that list is genuinely unmonitored (`unknown`, never polled) rather
than silently showing another room's health — the same failure mode a single
shared monitor across rooms would otherwise cause.

Two resolver processes are needed, not one: quorum is two attestations of the
same result from two different signers. Run them with different
`TM_RESOLVER_KEY` values.

Each process does real work every tick, not a status check:

| Role | Each tick |
|---|---|
| `connector` | Polls the source, appends signed facts, heart-beats when there is nothing new, and periodically re-sweeps for restatements. |
| `gate` | Loads the published markets' condition documents from the queue and verifies each against the chain's own binding, evaluates and drives the gate, then signs any waiting permit requests. |
| `publisher` | Reconciles in-flight publications against the chain, submits any permit it holds, then prepares the next queued question. |
| `resolver` | Reads the chain for closed, unresolved markets, rebuilds each result from raw provider bytes, and attests — once. What it attested and what it refused is durable, so a restart does not re-send. |

**The gate and the publisher must share a filesystem.** The publication queue is
a table in the shared SQLite file, so this composition is one host or one shared
volume — not two datacentres. That is the channel's design limit and it is the
main thing standing between this and geographically separated authorities.

**`TM_DATA_DIR` is not optional in practice.** Without it the session event log,
the raw source bytes, chat and its moderation, and the terms acceptances live in
memory. The projections rebuild from chain either way — but nothing else does,
and an operator who forgets it does not lose a little history, they lose the
evidence a resolver reconstructs from. It also disables the Livestream Event
recording archive. `TM_ORACLE_OPERATOR_TOKEN` separately enables authenticated
recording uploads and must live only in the API environment file; the API never
uses it as a chain key. The Coordinator prints `history durable`
or a warning on start, and `/metrics` carries `tradermarket_history_durable`.

## Monitoring

`GET /metrics` on the Coordinator, in Prometheus text format. It is
unauthenticated because everything in it is operational shape — block numbers,
health states, counts — and none of it is anyone's data; put it behind your own
ingress if you would rather.

The four that are worth an alert:

| Series | Alert when |
|---|---|
| `tradermarket_indexer_lag_blocks` | sustained above your reorg depth — the page is behind the chain |
| `tradermarket_indexer_health{state="delayed"}` | 1 for more than a few minutes |
| `tradermarket_source_health{state="stale"}` | 1 — markets suspend on a stale source, by design |
| `tradermarket_config_warning` | 1 — this process can see it is misconfigured, and says which way |

`tradermarket_stream_health` is deliberately **not** alert-worthy for settlement:
the livestream is context and never gates a market. Alert on it for the viewing
experience, not for the money.

Ready-made rules are in `services/live-room/deploy/alerts/tradermarket.rules.yml`
— eleven alerts, each with a wait, a summary, and a pointer back into this
runbook. A test asserts that every metric they name is one this build actually
exports, because an alert on a series nobody emits is a green check over
something nobody is watching. The stream rule is `severity: info` and is
required by that test to stay that way.

`absent(tradermarket_rooms_served)` is the one to install first: while the
Coordinator is down, none of the other rules can fire.

## Keeping the processes up

`services/live-room/deploy/systemd/` has one unit per process: the four
authorities and the Coordinator. Each starts exactly one role, reads exactly one
environment file, and restarts always with a five-second backoff.

Keys live in `/etc/tradermarket/<role>.env`, mode 0400, and never in a unit
file — a `TM_GATE_KEY=` on an `ExecStart` line is readable from `/proc` by every
user on the machine. A test checks the units for both mistakes, and checks that
no unit starts a second role: one process holding two authority keys undoes the
separation everything else here rests on.

These units describe a deployment; they are not evidence that one exists.

### Backups

Chain state survives anything. `TM_DATA_DIR/room.db` and
`TM_DATA_DIR/oracle-proofs/` do not, and together they hold
everything that cannot be rebuilt from the chain: the signed session event log,
the raw provider bytes resolvers reconstruct results from, chat and its
moderation record, terms acceptances, referral bindings, the gate's permit nonce
counter and audit log, the poller's cursors.

```bash
cd services/live-room && node scripts/backup.mjs "$TM_DATA_DIR" /backups/room-$(date +%F-%H%M).db
```

Runs against the live service — no need to stop anything. It takes the database copy
through SQLite rather than copying bytes, because with WAL a `cp` can produce a
database that opens and is quietly missing the last hour of a session. It
refuses to overwrite an existing file, and it prints what it captured so a
backup that ran and caught nothing is distinguishable from one that caught a
session. When livestream evidence exists it also creates
`<destination.db>.oracle-proofs/`; the command fails and removes the incomplete
database copy if the matching recordings cannot be copied.

Restore the database as `TM_DATA_DIR/room.db` and the adjacent backup directory
as `TM_DATA_DIR/oracle-proofs/`. A test takes a backup mid-write and asserts the restored log still
verifies signature-by-signature, that the raw bytes came with it, and that the
gate's nonce counter survived — and a separate test restores an evidence
recording under a different data path and replays it by proof id. A restored
gate that rewinds its nonce would reissue permits it has already used.

**Losing these artifacts loses no money.** Every position, claim and bond is on
chain. What it loses is the evidence for how each market was settled.

#### PostgreSQL

When `TM_DATABASE_URL` is set, the structured tables above live in PostgreSQL
instead of `room.db`. `vacuum into`, the technique `scripts/backup.mjs` uses,
is a SQLite pragma with no Postgres equivalent, and the standard answer —
`pg_dump` against the server — is a separate operational tool this runbook
does not assume is installed. Instead:

```bash
cd services/live-room
TM_DATABASE_URL="$TM_DATABASE_URL" node --no-warnings scripts/backup-postgres.mjs /backups/room-$(date +%F-%H%M).json
```

Reads every row of every durable table through the same connection the
service itself uses and writes them out as one portable JSON file — no
`pg_dump`/`pg_basebackup` in the loop. Runs against the live database; no
need to stop anything. Refuses to overwrite an existing destination, same as
`scripts/backup.mjs`. Evidence recordings are **not** included — that
directory (`TM_DATA_DIR/oracle-proofs`) is backed up the same way regardless
of which database backend is active.

Restore into a **fresh, empty** database — this is disaster recovery, not a
merge, and it refuses a target that already has rows rather than silently
dropping the ones that collide:

```bash
cd services/live-room
TM_DATABASE_URL="$TM_DATABASE_URL" node --no-warnings scripts/restore-postgres.mjs /backups/room-2026-08-24-1200.json
```

It runs the schema migration itself, so an empty database with no schema at
all is a valid restore target. A `bigserial` primary key (chat message ids,
publication request ids) has its sequence caught up to the restored rows as
part of the restore — inserting explicit ids does not, on its own, advance
the sequence object behind them, and a restore that got every row right but
left that behind would look complete right up until the first row written
after recovery collided with one that already meant something. A dedicated
test proves this rather than asserting it: it seeds rows, restores into a
fresh database, writes one more row through the normal path, and checks the
new id doesn't collide.

**DR verification, actually done, not asserted:** the strongest test in
`tests/backup-postgres.test.mjs` boots the real service against a database
that was populated only by replaying a backup — a genuinely separate
database instance standing in for "the original is gone" — and confirms it
serves a chat message and a terms acceptance that were written before the
simulated loss. Verified against real PostgreSQL (PGlite, the actual engine
compiled to WASM); the real-network path — an actual `pg_dump`-less
server-to-server restore, connection pooling, TLS — is not reachable in the
development sandbox this was built in (no Docker daemon, no local Postgres),
the same absence recorded against blocker B2 throughout Phase 1.

**Retention** is an operational policy this repository deliberately does not
encode: how many backups to keep and for how long is a cost/compliance
tradeoff for the operator, not a default worth baking into a script. Run
either backup command from cron, write to a path a normal retention tool
(`find -mtime +N -delete`, or the equivalent lifecycle rule on wherever
backups are actually stored) already knows how to expire, and restore-test
a real backup on a schedule — an untested backup is a hope, not a recovery
plan.

#### Six processes, one file

The authorities, the keeper and the Coordinator all write to
`TM_DATA_DIR/room.db`. That is a consequence of the separation, not a compromise
of it: no process may hold two authority keys, so they are separate processes,
and they share the store. (The keeper writes only its own liveness record — it
reads its work list from the chain, not from this file.)

SQLite handles that, but only if it is told to wait. Two failures were measured
under exactly this layout before it was:

- **Lost writes.** WAL allows one writer at a time and, with no busy timeout,
  SQLite returns "database is locked" immediately rather than queuing — roughly
  two writes in five, silently, including the gate's permit nonce counter.
- **A process that never starts.** Switching the journal mode takes an exclusive
  lock and does not honour the busy timeout at all, so opening the file while a
  neighbour was writing threw during open. Under `Restart=always`, that is a
  crash loop for as long as the neighbour keeps writing.

Both are fixed in `openDatabase`, and both have tests that run five real
processes against one file. If you write another tool that opens this database,
use `openDatabase` rather than opening it yourself.

#### How fast it grows

Measured: **~1.6 KB per recorded fact** — about 130 MiB/day at one fact per
second, and half a gigabyte a day at four. `tradermarket_durable_bytes` exports
the current size, including the write-ahead log.

The figure is stable across batch sizes (1.53–1.60 KB per fact whether the
provider returns 1 fill per response or 20), because the cost is the signed
event row — canonical facts, hashes, signature — rather than the raw payload
it shares with its batch. So you can plan from the fact rate alone.

The event log and the raw archive are **never pruned**. They are what a resolver
reconstructs a result from and what a challenger re-derives it from; pruning them
makes settled markets unverifiable, which is the one thing this system is built
not to do. So the answer to a growing file is a bigger disk, or backing up and
archiving a completed session — never a `DELETE`.

The failure this guards against is quiet: when the disk fills, SQLite writes
fail, the connector stops recording facts, and the room suspends on a stale
source. Every one of those steps is correct, and none of them says "the disk is
full".

### Knowing an authority has died

Each authority catches its own errors and keeps ticking. That is deliberate — a
gate that exits on one bad RPC response would end a live session over a blip —
but it means a process that can never work fails quietly, and the first sign
would otherwise be a session that stopped moving.

So every tick, successful or not, is recorded in the shared `TM_DATA_DIR`. The
Coordinator reads it and serves it two ways:

- `GET /v1/health` → `operators[]`, each with `role`, `failing`, the seconds
  since that role last succeeded, and the one-line reason it last reported.
- `GET /metrics` → `tradermarket_operator_failing{role}` and
  `tradermarket_operator_last_success_age_seconds{role}`.

A role nobody has heard from is **absent** from both, never reported healthy: a
deployment that never started its gate must not read like one whose gate is
working. For the same reason a process that has never succeeded has no "seconds
since it last worked" — `TraderMarketAuthorityFailing` is the rule that catches
that case, and `TraderMarketAuthoritySilent` catches one that worked and stopped.

Money is not trapped by any of this: once the on-chain stall timeout passes,
anyone may close a stalled room. But nothing moves until the process is fixed.

## Deploying to Polygon Amoy

Run the preflight first. It sends nothing, and it catches the mistakes that are
expensive to discover afterwards — the wrong chain, a gate and publisher sharing
one key, resolvers that are not three different addresses, a signer that cannot
afford its own transactions:

```bash
cd services/live-room
TM_RPC_URL=… TM_EXPECTED_CHAIN_ID=80002 TM_USDC=0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582 \
TM_DEPLOYER=0x… TM_GATE=0x… TM_PUBLISHER=0x… \
TM_RESOLVER_1=0x… TM_RESOLVER_2=0x… TM_RESOLVER_3=0x… \
npm run preflight
```

Then the two broadcasts, which are **yours to send** — they spend real testnet
gas from a signer this repo does not hold:

```bash
cd contracts
DEPLOYER_PRIVATE_KEY=… forge script script/DeployAmoy.s.sol --rpc-url $AMOY_RPC --broadcast
DEPLOYER_PRIVATE_KEY=… FACTORY_ADDRESS=0x… ROOM_ID=… \
GATE_SIGNER=0x… PUBLISHER=0x… INTEGRITY_ADJUDICATOR=0x… \
PARTICIPANT_A=0x… PARTICIPANT_B=0x… PARTICIPANT_A_NAME=… PARTICIPANT_B_NAME=… \
BOND_RECIPIENT=0x… RESOLVER_1=0x… RESOLVER_2=0x… RESOLVER_3=0x… \
forge script script/CreateAmoyRoom.s.sol --rpc-url $AMOY_RPC --broadcast
```

`CreateAmoyRoom` rejects a configuration where two authorities share an address,
for the same reason the preflight does: it would compile, run, and quietly
collapse the separation the design rests on.

## What this runbook does not cover

Production key custody, multi-operator resolver agreements, incident comms, and
legal review. Also: **independent resolvers.** Running two resolver processes
with two keys gives two signatures, but if they share a `TM_DATA_DIR` they share
a raw archive, so they are not independent reconstructions — a corrupted archive
corrupts both. Genuinely independent operators re-fetch from the provider
themselves, and that is not built. The interface allowlist is an interface control only: the contracts stay open on a public test network, and the collateral is valueless test USDC. See [SECURITY.md](../../SECURITY.md).
