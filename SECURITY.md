# Security policy

## Supported use

This codebase is an unaudited Polygon Amoy MVP. It is intended only for test USDC with no real-world value. Mainnet deployment and real-money use are not supported.

## Security design

### Authority separation

- Four signing domains, and the Live Room Coordinator is not one of them: the Source Connector signs the event log, the Source Gate Authority holds `GATE_SIGNER_ROLE`, the Program Publisher holds `PROGRAM_PUBLISHER_ROLE`, and three independent Resolver operators hold `RESOLVER_ROLE`.
- The Coordinator holds no chain key, accepts no order, and asserts no state the chain does not already support. Anything it publishes may be wrong, late, or missing without changing a settlement outcome.
- Publishing a Market Slot requires **both** the Publisher's role and a fresh, single-use, EIP-712 Publication Permit signed by the Gate Authority. Neither key can open a question alone. The permit binds room, slot index, condition hash, undecided-through sequence, announce delay, signed issuance time, expiry, nonce, and a canonical hash of the **complete** slot request — template id, parameter hash, winner setting, question text, both media URLs, and the per-slot restricted-wallet list in order. Binding a subset would leave the rest free to change after signing, so a publisher could have a 0 bps question attested and publish a 100 bps one, or drop a disclosed insider from the restricted list.
- Permit freshness is anchored to signed `issuedAt`, not to expiry. An expiry-relative bound accepts a permit issued hours ago whose expiry merely happens to be near, carrying a stale undecidedness claim.
- Only the registered room may create its own slot markets, and a slot's config must match its deterministic salt. A creator-role check alone let the factory admin mint a market into another room.
- The chain cannot read the Session Event Log, so it does not verify undecidedness itself. It verifies that the only authority able to evaluate the question signed a fresh, bound, single-use statement about it, and every publication leaves a replayable record of that claim.

### Market and room contracts

- Markets are non-upgradeable EIP-1167 clones. Market roles and economic configuration are frozen at initialization.
- Room slot addresses are deterministic in `(roomId, slotIndex)`, and republishing a pair reverts.
- Batched room gating isolates child failure: each market is called with a bounded gas stipend inside `try`/`catch`, a reverting market is skipped with an explicit `SlotCallSkipped` event, and batches are capped. One broken slot cannot freeze the Live Room. The room sequence is non-decreasing while each market's safe sequence is strictly increasing, so a skipped market is retryable at the same sequence.
- Failure isolation has a cost that must be managed rather than assumed away: a starved child looks exactly like a successful transaction that did nothing. `processRoom` therefore gives each child a proportional share of available gas rather than a fixed stipend, and **reverts** rather than skipping when it cannot run — otherwise gas estimation converges on a limit that skips all work and reports success. Callers must set explicit gas limits.
- `closeRoom` is irreversible and blocks all further publication; `closeRemainingSlots` and `processRoom` are permissionless afterwards, so a stalled or censoring operator cannot trap pending actions.
- The Integrity Bond is held once per Live Room and released only when the room is closed, no further slot can be published, every slot is Final or Invalid, and the Integrity Claim Window has elapsed with no unresolved claim.
- The Winner Reward Fee is frozen per market at 0–100 bps: participant and race markets carry 1%, threshold markets carry 0%. The 0.3% Liquidity Fee is unchanged.
- Room liquidity commitments automate an LP's decision, never their capital: one bounded approval, an EIP-712 policy, permissionless execution into one slot's own FPMM, and per-slot/simultaneous/total exposure accounting with permissionless release after settlement. The router holds no balance between transactions and can never accumulate shares or positions.
- The implementation contract locks its initializer in the constructor.
- Market creation is restricted by the factory's `MARKET_CREATOR_ROLE`.
- Participants, reward wallets, the source gate, resolvers, and disclosed insiders cannot trade or provide liquidity.
- All collateral transfers use OpenZeppelin `SafeERC20`; state-changing asset paths use `ReentrancyGuard`.
- Audience and LP actions enter pending epochs. They execute only after source finality and a monotonic source-sequence attestation.
- A decisive source event permanently closes forecasting and refunds overlapping or later pending actions.
- Resolution requires matching two-of-three resolver attestations and includes a fixed-bond challenge path.
- Missing resolution quorum and unanswered challenges fail closed to `Invalid`.

### Source trust and resolution independence

- The Source Connector is security-critical: a compromised connector can close a market early, suspend one indefinitely, or force invalidation. It is built accordingly — every normalized event retains the exact raw provider bytes, their canonical hash, and the **closed** query window that produced them, and the log is hash-chained and signed with a key separate from the gate key.
- Resolver Nodes reconstruct every result from raw provider data. They never read the connector's derived fields or any Coordinator state as a resolution input, and a static check enforces that in code.
- Conflicting or unverifiable reconstructions produce **no attestation**: the market follows recovery and then invalidation rather than resolving to either side. Conflict is never resolved by majority.
- Re-verification is at the fact level — immutable fill identifiers and normalized facts over a closed window — because a later query over the same window may legitimately paginate, order, or extend differently. The archived bytes make the original read indisputable.
- Every collateral category is separately accounted: AMM backing, pending collateral, winner rewards, LP fees, integrity bonds, and a held challenge bond.
- Buy and sell callers set minimum returns and deadlines. Failed or expired pending actions refund without charging fees.

## Known testnet limitations

- The contracts have strong automated coverage but no independent third-party audit.
- The Gate Authority is restart-safe by design — persisted nonces and audit, chain-reconciled suspension, a persisted unevaluable clock — but it remains a **single writer**. There is no failover, and a lost signing key ends the room's ability to gate; markets then refund at `maxPendingTime` and resolve or invalidate.
- The gate and resolver workflow is automated from a replayable log, but the three resolver operators are not yet separate organizations. Production needs hardened source adapters, genuinely independent operators, monitored keys, and incident response.
- The interface allowlist is an **interface control, not a protocol control**. It restricts who uses TraderMarket's interface, not who can transact with a deployed market: the contracts stay permissionless apart from the restricted wallet list. The real containment in this phase is that the collateral is Circle test USDC with no real-world value.
- The first Competition Source is Hyperliquid testnet, read by public address. The connector holds no Participant exchange credentials. A single connector is a single point of failure until the dual-connector decision is settled.
- The website uses injected wallets and self-paid test POL. A paymaster is intentionally not claimed or enabled until a sponsor policy, bundler, abuse controls, and credentials exist.
- The stream URL is supplied by the approved market creator. Stream availability and moderation are outside the settlement contract.
- Legal, licensing, sanctions, age, geographic, market-integrity, and wagering compliance are product-launch requirements and are not solved by these contracts.
- LP capital remains exposed to inventory imbalance and final outcome risk until settlement; the 0.3% fee does not guarantee a profit.
- Non-chain history is durable only with `TM_DATA_DIR`. Without it the session
  event log — the evidence a resolver reconstructs from — the raw source bytes,
  chat and its moderation, and the terms acceptances are held in memory and lost
  on restart. The projections rebuild from chain either way. The process says
  which it is on start and in `tradermarket_history_durable`.
- There are **five** privileged key domains, not four. Alongside the gate signer,
  the program publisher and the resolvers, `integrityAdjudicator` alone decides
  Integrity Claims: `LiveRoom.adjudicateIntegrityClaim` is gated on that address
  and upholding a claim moves a Participant's entire 100 USDC Integrity Bond to
  `bondRecipient`. No quorum, no permit, no second signature. It must differ from
  the gate, the publisher, every resolver, the bond recipient and both
  participants — enforced by `CreateAmoyRoom` and by the deployment preflight
  since 2026-08-23, and by nothing at all before that. It should be held by a
  human or a multisig, never by an automated process sharing a host with the
  resolvers.
- The Coordinator holds no chain key. The Gate, Publisher, Connector and each
  Resolver run as separate processes with separate keys, and `CreateAmoyRoom`
  and the preflight both refuse a configuration where two of those authorities
  share an address: publication needs the publisher role **and** a gate
  signature, and a quorum needs two resolvers who are not each other.
- `GET /metrics` is unauthenticated. Everything in it is operational shape —
  block numbers, health states, counts — and none of it is anyone's data; an
  operator who wants it private should place it behind their own ingress.
- A referral binding is signed by the person being referred, not the referrer,
  and is attributed only when their first market action appears on chain after
  the binding. No reward is paid for one, because none is funded.
- Chat is presentation-only and can never change a result. Posting and moderating
  both require a wallet signature over a **bound claim**: a string naming its
  purpose, the room, the author, and the moment it was made. The claim expires
  after five minutes and is single-use, keyed on the claim itself rather than the
  signature, because ECDSA signatures are malleable. Naming a public moderator
  address is not proof of being one. Chat identity is still not an account system.
  The moderation audit log is durable whenever `TM_DATA_DIR` is set — it is the
  `chat_audit` table in `room.db`, written by `SqliteChatStore.audit()` and
  carried by the backup script. Without `TM_DATA_DIR` the service runs entirely
  in memory and the log does not survive a restart, along with everything else.
- The Coordinator's HTTP surface is read-only **except** for six endpoints that
  write server-side state: `POST /v1/entry/accept`, `/v1/oracle/proofs` (operator
  token), `/v1/oracle/challenges`, `/v1/referrals/bind` (signed by the referred
  account), `/{room}/chat` and `/{room}/chat/moderate` (both wallet-signed). None
  of them moves money or reaches a chain key.

  **Two of those are neither rate-limited nor signature-bound, and this file
  previously claimed all six were.** `POST /v1/entry/accept` accepts a null
  signature and writes an acceptance row regardless (`src/entry/entry.mjs`);
  and `/v1/oracle/proofs` is guarded only by a single shared static bearer token
  while streaming up to 250 MB to local disk.

  The address on an acceptance is now required to be `0x` followed by 40 hex
  characters, so the row names an account that could exist and the key cannot be
  60 KB of arbitrary text. **How many well-formed addresses one caller may write
  is still unbounded**, and that matters because `terms_acceptance` shares
  `room.db` with the Session Event Log, the chat audit and the gate's permit
  nonce — none of which is rebuildable. Bounding it belongs at ingress or in a
  service-wide write ceiling, and neither exists yet.

  Two read paths are unauthenticated and worth naming rather than leaving to be
  discovered: `GET /v1/oracle/proofs/{id}/video` serves evidence with Range
  support, up to the per-proof cap per request, above the allowlist gate; and
  `GET /v1/portfolio/{account}` turns one anonymous request into chain RPC
  calls. Both are deliberate — evidence must be public for a challenge to be
  meaningful — and both are amplification an operator should rate-limit.

  The only rate limiting anywhere in the service is chat's per-address in-memory
  window (`src/edge/edge.mjs`), which additionally runs *after* signature
  recovery, so it caps accepted posts rather than work done. There is no per-IP
  limit and no connection cap. There *are* request timeouts, contrary to what
  this file said before: Node's defaults apply — 300 s for a request, 60 s for
  headers — because nothing here overrides them. A body no route reads is
  drained at line rate for that whole 300 s.

  Treat an internet-facing deployment as requiring its own ingress controls
  until that changes. A per-IP limit in this process would be theatre today in
  any case: the API binds `127.0.0.1`, so behind a proxy every socket carries
  the proxy's address, and the limit belongs in the proxy. Everything else is unauthenticated apart from the interface
  allowlist and chat signatures. It answers `access-control-allow-origin: *`
  because everything it serves is either public chain data or an explanation of
  what this deployment lacks. It holds no chain key and cannot submit a
  transaction, take custody, publish a market, or choose a result.
- Terms acceptance is signed when the wallet can sign, and the record says which
  it was. An acceptance without a signature is stored and reported as
  **self-declared**, because anyone can post any address: the record would
  otherwise present a claim someone made about a third party as that person's own
  affirmation of their age, risk understanding and jurisdiction. A signature that
  is supplied and does not verify is a refusal, never a quiet downgrade — and a
  build with no verifier says it cannot check rather than blaming the signature.
- **Only a proven acceptance opens the interface allowlist.** Allowlisted
  addresses are public, so writing an unproven acceptance through to the gate
  would let anyone post someone else's address and then assert it in a header.
  The unproven acceptance is still recorded so the journey is not a dead end; the
  gate is what waits for a signature.
- Gas sponsorship requires a policy that covers at least one action kind, not
  merely four endpoints. A paymaster built with an empty policy declines every
  request, so announcing sponsorship alongside one would claim a capability that
  cannot fire.
- Chat and moderation claims are **reserved before** the signature is verified,
  not after. Checking a single-use guard and recording it on either side of an
  `await` lets every concurrent request through the check before any of them
  records — one signed claim then acts as many times as it is sent.
- What an account is still owed is **read** from the market contract
  (`lpFeeCredit`, `winnerFeePaid`, and the accrual `claimLpFees` performs before
  paying), not inferred from event history — none of it appears in any log, and
  inferring it both hid real money and offered refunds that would revert.
  `claimInvalidWinnerFeeRefund` reverts unless the market resolved Invalid, and
  is the only writer that clears `winnerFeePaid`, so a non-zero balance on a
  decisively resolved market is permanent and unclaimable, never a payout. Where no chain reader is configured the answer is
  reported as *not known*, never as *nothing owed*.
- The `x-tm-address` header identifies a reader for the interface allowlist only.
  It is a self-declared address with no signature behind it, so it is an
  interface convenience and not an authentication mechanism; nothing behind it
  gates money.
- Referral attribution is implemented and durable. A referral code is derived
  deterministically from the programme id and the address; a binding is signed by
  the *referred* account over a claim naming the referrer and code, and is
  recorded with the block it was made at. `Growth.referrals()` counts only
  bindings whose referred account took its first market action **after** the
  binding block, read from indexed on-chain trades — so a code cannot claim
  someone who was already trading. No reward is advertised, because none is
  funded.

## Reporting a vulnerability

**Please report privately, not as a public issue.**

The intended route is GitHub's [Private Vulnerability
Reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability):
the repository's **Security** tab → **Report a vulnerability**. It opens a
private advisory that only the maintainers can read.

**That feature is not on by default, and this file cannot verify it is on.** It
has to be switched on per repository after the repository is created. So:

- **If the Security tab offers "Report a vulnerability", use it.** That is the
  private channel, and it is monitored.
- **If it does not**, private vulnerability reporting has not been enabled yet
  and there is no other private channel — this project publishes no security
  mailbox, because an address nobody is staffed to watch is worse than no
  address. In that case open a public issue containing **only** this and
  nothing else:

  > Security report — requesting a private channel. No details here.

  A maintainer will enable private reporting and open an advisory you can write
  into. Do not put the vulnerability, a reproduction, or an affected address in
  that issue.

Once you have a private channel, include the affected contract or flow,
reproduction steps, impact, and a proposed mitigation if you have one. Do not
include private keys, seed phrases, or active credentials in a report.

Do not test against public users or real funds. This is testnet software:
reproduce against a local `anvil` (`npm run gameday:anvil`) or your own testnet
deployment.

**What to expect.** This is a small project with no dedicated security team and
no bug bounty. There is no guaranteed response time, and saying so plainly is
more useful than publishing an SLA nobody is staffed to meet. Reports about the
known-unfixed items listed above are welcome but already tracked.

**No independent security audit has been performed.** Assume undiscovered
vulnerabilities exist, and do not deploy this against real funds.
