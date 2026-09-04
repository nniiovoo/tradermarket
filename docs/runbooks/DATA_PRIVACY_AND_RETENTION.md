# Data privacy and retention

What personal data this system holds, where, for how long, and what can
actually be done about it today. This is the Phase 1 "data lifecycle,
deletion propagation and privacy inventory" item — the storage-layer
foundation. It is not the Phase 9 compliance workflow: there is no request
intake, no requester identity verification, and no audit trail of privacy
requests here. Those need provider decisions (blocker B7) and legal review
(blocker B6) this document does not attempt.

## What exists today: nothing

Before this, the repository had no privacy or retention documentation and no
deletion mechanism of any kind. Every durable table grows forever. This
document and `scripts/erase-account.mjs` are the first pieces of either.

## The two kinds of data this system holds

**On-chain.** Wallet addresses, trades, LP positions, claims — public,
immutable, and outside this system's control by design: TraderMarket is
non-custodial, and nothing here could delete a chain fact even if asked to.
This is standard for any permissionless protocol and is not a gap; it is
recorded here so the boundary is explicit rather than assumed.

**Off-chain durable** (`TM_DATA_DIR/room.db`, or the equivalent PostgreSQL
tables once Phase 1 item 3's backend-selection wiring is used in production).
The rest of this document is about this half.

## Inventory: every durable table

| Table | What it holds | Data-subject | Erasable today? |
|---|---|---|---|
| `chat_message` | author address, text, timestamp | Forecaster/audience (self-authored) | **Yes** — `eraseAccount` |
| `chat_timeout` | muted address, expiry | Forecaster/audience | **Yes** — `eraseAccount` |
| `chat_audit` | moderator address, action, message id | Moderator (operator-appointed) | Not built; low priority — moderators are operator-appointed roles, not general users |
| `referral_binding` | referred address, code, referrer address | Forecaster/audience (both sides) | **Yes** — `eraseAccount` |
| `terms_acceptance` | address, terms version, signature-proven flag | Anyone who used the interface | **Yes, mechanically — see the open question below** |
| `session_event` | normalized Competition Source facts about **Participants** | Participant (opted in; posted an Integrity Bond) | **No — see "What cannot be erased, and why"** |
| `raw_blob` | the exact provider bytes `session_event` hashes commit to | Participant | **No**, same reason |
| `resolution_attempt`, `challenge_verdict` | resolver address, market, outcome, evidence hash | Resolver (operator-appointed) | **No**, evidentiary |
| `livestream_oracle_proof` | evidence metadata for Livestream Event Markets, plus the recording file beside the database | May depict Participants or on-stream public figures | **No**, evidentiary |
| `livestream_challenge_evidence` | challenger address, evidence, transaction hash | Challenger (bonded an on-chain challenge) | **No**, evidentiary |
| `kv`, `leader_lease`, `publication_request`, `schema_migration` | operational state: nonces, leases, publication workflow | Nobody — no personal data | N/A |

Frontend: `localStorage` holds one key, `tradermarket-creator-draft` — a
device-local, unsynced copy of a creator's own in-progress form input. Never
reaches a server; nothing to erase server-side.

No IP address is ever captured or stored anywhere in this service — checked
directly against `src/api/server.mjs`, not assumed.

## Retention: indefinite, with one unrelated exception

Nothing here expires data for privacy reasons. The one existing pruning
mechanism — `ChatService._prune()` capping `maxMessages` per room — exists to
bound memory/disk growth, not to protect anyone's privacy, and a message it
drops for that reason is gone from `history()` but the row itself is only
removed by the same age/count rule, not by request.

**No default retention period is set here.** How long is "long enough" for
evidentiary tables, and how long is "too long" for erasable ones, are
genuine policy tradeoffs (dispute windows, tax/audit obligations, storage
cost) this document does not decide. Recorded as an open item for the owner,
not invented.

## What cannot be erased, and why

`session_event`, `raw_blob`, `resolution_attempt`, `challenge_verdict`,
`livestream_oracle_proof`, and `livestream_challenge_evidence` are the
evidence a market's resolution rests on. The Session Event Log is
hash-chained and independently reconstructed by resolvers from the raw
bytes (ADR 0024) specifically so no single party — including this system's
own operator — can alter what a market's outcome was built from. Erasing a
Participant's own performance facts from it on request would either corrupt
that hash chain (breaking every resolver's ability to reconstruct) or, if
done "cleanly" by rebuilding the chain around the gap, would let a
Participant retroactively edit the evidence a market already paid out on.
Neither is acceptable in a settlement-evidence system. A Participant's
recourse is the same as anyone's in any competitive record: the option not
to compete, not retroactive erasure of a completed one.

This is a real constraint, not a convenient excuse — it is recorded here so
a future privacy-request workflow (Phase 9) fails closed on these tables by
design, rather than someone adding a generic "delete this account" button
that quietly corrupts settlement evidence.

## What can be erased, and what "erased" means for each

`scripts/erase-account.mjs <TM_DATA_DIR> <address>` erases one address from
every table where it is safe to:

- **Chat**: every message's `author` and `text` are replaced with a
  tombstone (`"[erased]"` / `[removed by the account holder]`); the row and
  its id stay, because other people's replies and the room's message
  ordering are their own information, not the erased account's. Any active
  mute for the address is cleared.
- **Referrals**: a binding where the address is the *referred* party is
  deleted outright — it is entirely that account's own record. A binding
  where the address is the *referrer* has only the `referrer` field
  tombstoned; the row itself (that someone else was referred, and when)
  stays, because it is the *other* account's record, not the erased one's.
- **Terms acceptance**: the row is deleted.

**The terms-acceptance case has a real, unresolved policy tension, flagged
rather than decided:** the whole reason a signed acceptance is recorded is
so the operator can *prove* someone agreed to the testnet terms. Erasing it
on that same person's request trades away the operator's own evidence of
consent — which cuts against the operator, not just for the requester's
privacy. Many jurisdictions expect exactly this kind of record to be
*retained or anonymized*, not deleted outright, specifically so a consent
dispute remains provable. This script deletes the row today because that is
the mechanically simple, unambiguous behavior to build and test; whether
that is the *right* default — versus, say, retaining a proof-only stub with
the version and signature but not the live address-to-consent mapping — is
a legal question (blocker B6) this implementation does not resolve. Do not
read "the script deletes it" as "this is definitely fine to do."

## Running it

```sh
cd services/live-room
node --no-warnings scripts/erase-account.mjs /var/lib/tradermarket 0xAddress
```

Same calling convention as `scripts/backup.mjs`: the data directory first,
then the argument specific to this script. Prints exactly what was touched
in each table (message count tombstoned, timeout cleared or not, referral
bindings affected on each side, acceptance row present or not) — never
silent, so a real operator has evidence the request was actually carried
out. Idempotent: running it again on an already-erased address reports zero
further changes rather than erroring. Refuses an argument that is not a
`0x`-plus-40-hex-character address rather than silently matching nothing.

Works against the SQLite adapter today. The PostgreSQL adapter's
`eraseAccount` methods exist and pass the same port-contract tests, but
`scripts/erase-account.mjs` itself only opens a `TM_DATA_DIR` SQLite file —
extending it to accept `TM_DATABASE_URL` is a few lines once an operator
actually needs it, not built speculatively ahead of that need.

## What this deliberately does not build

This is the storage-layer mechanism only. It is not:

- **A request-intake surface.** Nothing here verifies that the person
  asking is the address's owner, records that a request was made, or
  enforces a response-time obligation. That is Phase 9's compliance
  workflow, and it needs an identity/authentication decision this document
  does not make.
- **A retention *policy*.** No table auto-expires. Setting one is a
  business/legal decision (recorded above), not an engineering default this
  change should silently assert.
- **Deletion propagation to backups or CDN.** `scripts/backup.mjs` snapshots
  the database as it is at backup time; an erasure after a backup was taken
  is not retroactively applied to that backup. Object storage and CDN
  delivery (Phase 1, unbuilt) will need their own propagation story once
  they exist — recorded here so it is not forgotten when they are built,
  not solved now for infrastructure that does not exist yet.
