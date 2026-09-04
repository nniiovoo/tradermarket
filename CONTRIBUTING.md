# Contributing

This is testnet software that handles collateral. The conventions below exist
because a mistake here is not a rendering glitch — it is somebody's money.

## Before you start

Open an issue first for anything that changes settlement, liquidity, payouts,
refunds, bonds, or the resolution path. Those changes are cheap to discuss and
expensive to get wrong. Bug fixes, documentation, and tests need no preamble.

## Environment

| Tool    | Version | Install                          |
| ------- | ------- | -------------------------------- |
| Node.js | 24.14.x | `nvm install 24.14`              |
| npm     | 11.x    | ships with Node 24               |
| Foundry | v1.7.1  | `foundryup -i v1.7.1`            |

Both npm packages declare `"engines": { "node": ">=24.14 <25" }`. solc 0.8.26 is
pinned in `contracts/foundry.toml`. Solidity dependencies are vendored under
`contracts/lib/`, so contract builds need no network.

Always install with `npm ci`, never `npm install`. `npm ci` installs exactly
what `package-lock.json` records and fails when the lockfile and `package.json`
disagree. If you change a dependency, commit the regenerated lockfile in the
same change.

```sh
cd contracts               && forge build --sizes && forge test
cd services/live-room      && npm ci && npm test
cd prototype/live-market-app && npm ci && npm test
```

Run them in that order. The backend suite loads compiled ABIs and bytecode from
`contracts/out` (see `services/live-room/src/indexer/abi.mjs`), so `forge build`
has to have run first — on a fresh clone it has not.

The frontend's `npm test` builds first, because one test asserts on the packaged
output. A fresh clone has no `dist/`.

## Tests come first, and they fail first

Write the test before the fix, and **watch it fail for the reason you expect**.
A test that passes before your change proves nothing about your change. If you
cannot make it fail, you have not found the defect yet.

Every test in this repository opens with a comment saying what was actually
wrong and why the absence of that check mattered. Follow it. A test named after
the function it calls tells a future reader nothing; a test named after the
behaviour that broke tells them everything.

State what a test does **not** cover, in the test. Several suites here run
against PGlite — real PostgreSQL compiled to WASM — which exercises the SQL
dialect for real and the TCP transport not at all. That limitation is written
down beside the tests rather than left for someone to discover.

## Game day

Three end-to-end tiers, narrowest first. Each proves something the one before it
cannot, and they all bind port 8545 — run them one at a time.

```sh
cd services/live-room
npm run gameday:anvil               # the room, in one process
npm run live-gameday:anvil          # with the live source loop
npm run multiprocess-gameday:anvil  # operator roles as real spawned processes
```

All of them load bytecode from `contracts/out`, so `forge build` must have run.

## Architecture

The service is ports and adapters. Store implementations (SQLite, PostgreSQL,
in-memory) are interchangeable, and one shared contract suite
(`services/live-room/tests/helpers/store-contract.mjs`) runs unchanged against
each. A new store passes that suite before anything else.

Every store method is `async` on every adapter, including the ones where it need
not be. A missed `await` then fails loudly instead of silently comparing a
Promise.

Authority separation is load-bearing. The Coordinator holds no chain key; the
Gate, Publisher, Connector, and Resolvers hold different ones and run as separate
processes. Do not add a path that lets the read tier sign anything.

Architecture decisions live in `docs/adr/` and are numbered. Changing a decision
means a new ADR, not an edit to the old one.

## Style

Match the file you are editing. Comments explain **why**, especially why an
obvious simpler version is wrong — several of them in this repository exist
because the obvious version shipped first and cost something.

Contracts: `forge fmt`. JavaScript: no formatter is enforced; follow the
surrounding file.

## Pull requests

Fill in the template. State how you verified the change, with the numbers your
run produced rather than "tests pass". If your change touches a money path, say
what an incorrect version would cost, and to whom.

Do not include real credentials, private keys, seed phrases, or a `.env` file.
The only 64-hex private keys that may appear anywhere are the well-known public
anvil keys.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the MIT Licence — see [LICENSE](LICENSE) and
[NOTICE](NOTICE). By opening a pull request you agree your contribution may be
distributed under those terms.
