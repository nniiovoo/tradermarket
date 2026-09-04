# TraderMarket livestream prediction MVP

TraderMarket is a two-outcome livestream prediction market for Polygon PoS Amoy. It uses one community-funded fixed-product market maker per market, and a Live Room publishes many of them over one livestream — a headline market plus micro markets, each its own FPMM clone with its own reserves, LP shares, fees and resolution, bounded by the room's `maxOpenSlots`. For each one: anyone except the participants, their reward wallets, the source gate, resolvers, and disclosed insiders may provide test-USDC liquidity and earn the 0.3% LP fee.

This repository contains a working local web app and a tested, deployable testnet contract system. It has **not** been broadcast to Polygon Amoy because this workspace does not contain a funded deployment signer or the participant, gate, and resolver addresses. It must not be presented as publicly deployed until those addresses are configured and the deployment transactions are confirmed.

## Product flow

1. An approved creator creates a market with two participants or two objective Livestream Event outcomes, an exact official stream, a frozen Observation Window and rule, a source gate, and three frozen resolvers.
2. Both participants post a 100 test-USDC Integrity Bond.
3. The first eligible LP supplies Circle test USDC. No platform treasury seed or minimum funding stage is required.
4. Audience buys, sells, transfers, and LP additions enter short Forecasting Epochs. Nothing changes the price until the source gate marks the completed epoch safe.
5. A decisive source event closes forecasting. Pending actions from the decisive epoch and later are refunded.
6. Two of three resolvers attest to the same result and evidence. A challenge window follows; missing quorum or an unresolved challenge fails closed to `Invalid`.
7. Winning Outcome Positions redeem for $1 each. LPs settle their final inventory and claim LP fees. The winning participant's reward wallet receives the 1% Winner Reward Pool. An invalid market refunds that 1% to the forecasters who paid it.

The live player is context, not the source of truth. Approved event data controls the source gate and Resolution. For a Livestream Event Market, that event data is a complete hashed Canonical Stream Recording for the frozen Observation Window—not the embed, a mutable VOD, or an isolated highlight.

## Repository map

- `contracts/` — Solidity market, per-session `LiveRoom`, liquidity commitments, clone factory, fixed-product math, deployment scripts, and Foundry tests.
- `services/live-room/` — the off-chain operating layer: source connector, Session Event Log, Source Gate Authority, Program Publisher, chain indexer, Coordinator, realtime edge, resolver nodes, settlement, and the HTTP/SSE room API.
- `prototype/live-market-app/` — responsive livestream app with injected-wallet, Circle test-USDC, prediction, public-LP, participant-bond, portfolio, and claim flows.
- `prototype/live-market-app/scripts/live-market-operator.mjs` — source-gate, epoch-processing, and resolver command line for the Amoy MVP.
- [`docs/specs/livestream-prediction-markets.md`](docs/specs/livestream-prediction-markets.md) — complete product and economic specification.
- [`docs/specs/livestream-oracle-mvp.md`](docs/specs/livestream-oracle-mvp.md) — complete-recording evidence archive, resolver console, and audience challenge flow for objective Livestream Event Markets.
- [`docs/specs/live-room-coordinator.md`](docs/specs/live-room-coordinator.md) — Live Room operating design: the rolling market program, Publication Permits, the source trust model, and the non-custodial Coordinator.
- `docs/adr/` — accepted architecture decisions from the product discussion.
- `docs/runbooks/POLYGON_AMOY_MVP.md` — deployment and operating procedure for a standalone market.
- `docs/runbooks/LIVE_ROOM_OPERATIONS.md` — operating a Live Room: roles, publication, the gate loop, the failure playbook, and game day.
- [`CONTEXT.md`](CONTEXT.md) — the domain glossary: every term the protocol uses, what it means, and what it must not be called.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — environment versions, the failing-first test convention, and how to run each suite.
- [`SECURITY.md`](SECURITY.md) — testnet boundary, controls, and known limitations.

## Verification

Prerequisites, and the versions CI runs:

| Tool    | Version   | Notes                                                     |
| ------- | --------- | --------------------------------------------------------- |
| Node.js | 24.14.x   | Declared as `engines` in both packages; `>=24.14 <25`.     |
| npm     | 11.x      | Ships with Node 24.                                        |
| Foundry | v1.7.1    | `foundryup -i v1.7.1`. solc 0.8.26 is pinned in `foundry.toml`. |

Installs are lockfile-exact. `npm ci` installs precisely what `package-lock.json`
records and fails if the lockfile and `package.json` disagree; `npm install` may
quietly resolve something newer, which is how a green run stops meaning what the
committed dependency set does.

From a fresh clone, in order:

```sh
cd contracts
forge build --sizes
forge fmt --check
forge test
forge lint

cd ../services/live-room
npm ci
npm test

cd ../../prototype/live-market-app
npm ci
npm test          # builds first: one test asserts on the packaged output
```

Solidity dependencies are vendored under `contracts/lib/`, so `forge build`
fetches nothing and needs no network.

Game day runs a complete Live Room four ways, each proving something the one before it cannot.

```sh
cd contracts && forge test --match-contract GameDayTest -vv
```

```sh
cd services/live-room && npm run gameday:anvil
```

```sh
cd services/live-room && npm run live-gameday:anvil
```

```sh
cd services/live-room && npm run multiprocess-gameday:anvil
```

All but the first need `forge build` to have run, because they load bytecode from `contracts/out`.

The `:anvil` variants start a clean chain, run the game day against it, and stop
the chain again. Run them one at a time — they all bind port 8545, and a stray
long-lived `anvil` makes them silently reuse it and report **fewer** checks
rather than failing. `lsof -nP -iTCP:8545` should be empty before you start.

1. **In Foundry** — a real EVM, one headline market plus three sequential micro markets.
2. **`gameday`** — the real services driving contracts on a clean local chain. This is the one that proves the service-to-contract seam: the in-memory fake cannot, and three real defects reached a "complete" claim because it was trusted to. Needs a freshly started anvil; it replays a recorded session onto chain time.
3. **`live-gameday`** — a real HTTP provider that misbehaves the way real ones do: repeated fills, a dropped connection, an outage, and a restated figure. The check it exists for is a market settling on the corrected number.
4. **`multiprocess-gameday`** — the operator processes actually spawned, one key each, talked to only the way an operator would. It kills the publisher mid-publication and restarts it; it starts a publisher holding the gate's key and checks it refuses to run; it recovers the permit signature to prove the gate signed it. The first three all drive the authorities as objects in one process, which can prove the modules compose but not that they *don't* — and several defects survived every one of them: operator processes that exited after a single tick, a chain port missing methods only a deployment calls, and an evidence hash that depended on when a resolver happened to look, so two honest resolvers never reached quorum.

`forge lint` currently reports 94 warnings and no errors: 29 `block-timestamp`, which are inherent to a time-gated market (epochs, permit lifetimes, challenge and resolution deadlines) and are being justified individually for the security-review package, and 65 `unsafe-typecast`, all of them `bytes32` string-literal casts in `contracts/test` and `contracts/script` rather than in deployed code.

## Running a room

The Live Room Coordinator serves indexed chain facts and nothing else. It has no
fixture mode: a process that is not configured exits with the reason rather than
starting one that would answer the website with invented state.

```sh
cd services/live-room
TM_ROOM_ID=gameday \
TM_RPC_URL=http://127.0.0.1:8545 \
TM_FACTORY_ADDRESS=0x… \
TM_ROOM_ADDRESS=0x… \
TM_CHAIN_ID=31337 \
TM_ROOM_API_URL=http://127.0.0.1:8787 \
TM_DATA_DIR=/var/lib/tradermarket \
TM_ORACLE_OPERATOR_TOKEN='generate-a-long-random-secret' \
TM_PORT=8787 \
npm run serve
```

`npm run gameday` prints the exact command for the room it just exercised. On
start the service prints every capability it has and every one it does not, with
the reason — gas sponsorship, a livestream, chat, a faucet and legal
availability are all off until something real configures them.

`TM_DATA_DIR` is not optional in practice: without it the session event log, the
raw source bytes, chat and its moderation, and the terms acceptances live in
memory and are gone on restart, and Livestream Event evidence storage is unavailable.
`TM_ORACLE_OPERATOR_TOKEN` enables authenticated evidence uploads; it is never
returned by the capability API. The projections rebuild from chain either way.
The server prints `history durable` or a warning on start.

`TM_ROOMS=alpha=0x…,beta=0x…` serves several rooms from one process, with
`TM_FACTORIES` when they come from more than one factory. The single-room pair
above is the same thing with one entry.

The authority processes are separate, each with its own key and the same
`TM_DATA_DIR`:

```bash
TM_GATE_KEY=…      npm run operator gate
TM_PUBLISHER_KEY=… npm run operator publisher
TM_CONNECTOR_KEY=… TM_SOURCE=… TM_PARTICIPANTS="alice=0x…,bob=0x…" npm run operator connector
TM_RESOLVER_KEY=…  TM_PARTICIPANTS="alice=0x…,bob=0x…" npm run operator resolver
```

Splitting them is not ceremony: publication needs the Program Publisher role
**and** a Gate signature, and a quorum needs two resolvers who are not each
other. One process holding two of those keys makes the pair meaningless. Run two
resolvers, with different keys — one is not a quorum. The gate and the publisher
check at start that the room actually names their address, and exit with the
address the room does want if not. The connector and the resolvers cannot: the
connector signs the event log rather than the chain and has no address in the
room's configuration at all, and a resolver's role is granted per market, none of
which exists when it starts. A resolver's refusals are what surface a wrong key
there, and the deployment preflight checks both against every other authority
before anyone spends.

Questions are queued for publication durably, and the publisher picks them up:

```bash
TM_ROOM_ID=… TM_DATA_DIR=… npm run queue-question -- \
  --template tpl-participant-v1 \
  --question "Who reaches \$10,000 realized PnL first?" \
  --param target=10000
```

The publisher validates it against the frozen catalog and stops; the gate signs
the permit in its own process with its own key; the publisher submits it. Every
step is written to the shared store before the next begins, so either process
can be restarted mid-publication without losing the question. The channel is a
table in that shared SQLite file, which means the gate and publisher must share
a filesystem — one host or one volume, not two datacentres.

`GET /metrics` on the Coordinator serves Prometheus text from its own state —
indexer lag, source and stream health, whether history is durable, and whether
the process can see it is misconfigured. See the runbook for what is worth
alerting on.

Before deploying anywhere real, `npm run preflight` checks the chain, the
collateral contract, the separation of every authority, and each signer's
balance. It sends nothing.

Optional: `TM_CHAT_ENABLED`, `TM_CHAT_MODERATORS` (comma-separated addresses),
`TM_SOCIAL_PROOF_ENABLED`, `TM_REFERRALS_ENABLED` + `TM_REFERRAL_PROGRAM_ID`,
`TM_COMMUNITY_URL`, `TM_FAUCET_URL`, `TM_ALLOWLIST_ENABLED` + `TM_ALLOWLIST`,
`TM_PARTICIPANT_A` / `TM_PARTICIPANT_B` (which source participant is Outcome A;
without both, settlement records are omitted rather than guessed).

With durable storage and operator authentication configured, `#/oracle` lets
the Gate Authority close forecasting, archives the complete Observation Window
recording, and lets two independent resolver wallets attest the same evidence
hash. The API stores evidence only; every chain action is signed in the browser.

Gas sponsorship needs all of `TM_BUNDLER_URL`, `TM_PAYMASTER_URL`,
`TM_ENTRY_POINT`, `TM_PAYMASTER_POLICY_ID` **and**
`TM_PAYMASTER_SPONSORED_KINDS` — a policy covering no action kind sponsors
nothing, so the capability stays off rather than announcing what it would then
decline.

## Local app

```sh
cd prototype/live-market-app
VITE_ROOM_API_URL=http://127.0.0.1:8787 VITE_ROOM_ID=gameday \
  npm run dev -- --host 127.0.0.1 --port 4173
```

Without `VITE_ROOM_API_URL` the app says no Live Room is configured and shows no
markets — there is no fixture fallback. With it, Home, Market Activity, the
schedule, the leaderboard and the portfolio all read the Coordinator's indexed
chain facts. `VITE_MARKET_ADDRESS` additionally enables transactions through the
reader's own injected wallet.

## Testnet warning

This is unaudited testnet software. Circle faucet USDC has no real-world value. Do not deploy these contracts with production keys, real collateral, or mainnet addresses.

No independent security audit has been performed. The project's own audit
record is candid about what is verified and what is not; assume undiscovered
vulnerabilities exist.

## Licence

MIT — see [LICENSE](LICENSE), which is the unmodified standard text.

[NOTICE](NOTICE) records what the grant covers, the third-party components in
`contracts/lib/` and their licences, and the status of the software. All
vendored dependencies are permissive; there is no copyleft component.

Contributions are welcome under the same terms — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Security reports: please use GitHub's private vulnerability reporting rather
than a public issue. [SECURITY.md](SECURITY.md) sets out the trust boundaries,
and — more usefully — the known-unfixed weaknesses, including which write
endpoints are currently unauthenticated and unlimited. Read it before exposing
a deployment to the internet.
