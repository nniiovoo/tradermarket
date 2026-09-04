# Polygon Amoy MVP deployment and operations

## Purpose

This runbook deploys and operates the livestream prediction MVP on Polygon PoS Amoy using Circle test USDC. It is testnet-only.

## Prerequisites

- A newly created testnet-only deployer with enough Amoy POL for deployment gas.
- Two participant addresses and, preferably, separate reward addresses.
- One gate-oracle signer and three distinct resolver signers. Do not reuse participant, reward, or public LP addresses for these roles.
- An objective result rule, an approved evidence/source policy, an embeddable stream URL, and original or licensed market artwork.
- Circle test USDC for the two 100 test-USDC participant bonds and the first public LP.

Never commit `.env` files or paste a private key into a browser build. The browser accepts only public `VITE_*` values. Operator private keys remain server-side or in a dedicated signer.

## Network constants

- Chain: Polygon PoS Amoy
- Chain ID: `80002`
- Gas token: test POL
- Circle test USDC: `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582`
- Explorer: `https://amoy.polygonscan.com`
- Circle faucet: `https://faucet.circle.com/`

## 1. Configure roles

Copy `contracts/.env.example` to an untracked `contracts/.env` and fill every address. Treat `DEPLOYER_PRIVATE_KEY` as a hexadecimal integer accepted by Foundry; use a testnet-only key.

The resolver addresses are frozen into each market. Two resolvers should never be operated by the same person or automation in a production design. The testnet MVP can start with the project's controlled signers, but must preserve three distinct keys.

## 2. Deploy the implementation and factory

```sh
cd contracts
source .env
forge script script/DeployAmoy.s.sol:DeployAmoy --rpc-url amoy --broadcast
```

Record the implementation and factory transaction hashes and confirm both contracts have bytecode on PolygonScan. Put the factory address into `FACTORY_ADDRESS`.

## 3. Create a livestream market

Confirm the participant names, objective question, stream URL, artwork URL, and all frozen roles. Then run:

```sh
forge script script/CreateAmoyMarket.s.sol:CreateAmoyMarket --rpc-url amoy --broadcast
```

Record the new market address. Confirm its `collateral()` is Circle test USDC and compare every public configuration value against the approved launch sheet before accepting deposits.

## 4. Connect the web app

Copy `prototype/live-market-app/.env.example` to an untracked `.env.local` and set:

```text
VITE_AMOY_RPC_URL=https://polygon-amoy.drpc.org
VITE_USDC_ADDRESS=0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582
VITE_FACTORY_ADDRESS=<confirmed factory>
VITE_MARKET_ADDRESS=<confirmed market>
```

Rebuild the app. The header must change from “deployment ready” to “live contract,” and its contract link must point to the confirmed market on Amoy PolygonScan.

## 5. Make the market ready

Each participant connects the invited address in the Compete view, obtains Circle test USDC, approves the market, and posts the 100 test-USDC Integrity Bond. After both bonds are present, any eligible user can provide the first liquidity. That first successfully cleared deposit creates equal A and B reserves and opens executable audience trading.

There is no platform-funded seed, funding stage, or promise that every order size will execute at an attractive price. Large orders face steep fixed-product price impact. More public LP capital deepens the individual market.

## 6. Operate Forecasting Epochs

From `prototype/live-market-app`, set `AMOY_RPC_URL`, `MARKET_ADDRESS`, and the appropriate testnet-only `OPERATOR_PRIVATE_KEY`.

Read state:

```sh
npm run operator -- status
```

After an epoch has ended and the source finality delay has passed, the gate signer marks it safe. Anyone may then process its queued actions:

```sh
npm run operator -- safe <epoch> <monotonic-source-sequence>
npm run operator -- process <epoch> 100
```

On source uncertainty, suspend before accepting more actions; reopen only with a later source sequence:

```sh
npm run operator -- suspend <source-sequence>
npm run operator -- reopen <later-source-sequence>
```

## 7. Close and resolve

The gate signer closes immediately when the decisive source event is observed:

```sh
npm run operator -- close <decisive-source-sequence>
```

Each of two resolvers independently attests the same outcome and evidence URI/hash using its own signer:

```sh
npm run operator -- attest a https://evidence.example/result.json
```

Use `b`, `tie`, or `invalid` when appropriate. The URI string is hashed locally; resolvers must use the exact same canonical string or the same explicit bytes32 hash.

If unchallenged after the configured window, anyone can finalize:

```sh
npm run operator -- finalize
```

For a challenge, two resolvers independently submit `verdict accept` or `verdict reject`. `accept` invalidates the market and returns the challenger bond; `reject` preserves the provisional result and sends the fixed bond to the configured bond recipient. If no challenge verdict arrives before timeout, `expire` returns the bond and invalidates. If no result quorum arrives by the resolution deadline, `invalidate` finalizes Invalid.

## 8. Claims and reconciliation

Forecasters redeem Outcome Positions. LPs claim accrued fees and settle their final inventory. The winning participant reward wallet claims the Winner Reward Pool. Participants claim their Integrity Bonds. On `Invalid`, forecasters reclaim the 1% winner fees they paid.

Before declaring a test complete, compare the contract's Circle test-USDC balance with `accountedLiabilities()`. The balance must never be lower. Preserve transaction hashes and evidence hashes in the test report.

## Stop conditions

Stop the market and do not reopen it when source ordering is unclear, the stream identity no longer matches the market, a configured role key is suspected compromised, collateral accounting is inconsistent, or the approved objective rule cannot produce an unambiguous result. Resolve as `Invalid` when the frozen rules require it.
