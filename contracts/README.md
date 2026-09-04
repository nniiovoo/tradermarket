# TraderMarket contracts

Polygon Amoy contracts for a two-participant Livestream Prediction Market.

## What is implemented

- one isolated Community-Funded FPMM per Live Competition;
- public first and later liquidity, with price-preserving later deposits;
- pending buys, sells, position transfers, and liquidity additions grouped into Forecasting Epochs;
- source-attested safe epoch execution and decisive-epoch refunds;
- 1% whole-market Winner Reward Fee and 0.3% LP Liquidity Fee;
- Participant and disclosed-insider prohibitions;
- 100 test-USDC Participant Integrity Bonds;
- frozen two-of-three Resolver quorum, Challenge Window, and fail-closed invalidation;
- position Redemption, Winner Reward, LP fee, LP inventory, invalid-fee-refund, and Integrity Bond claims;
- non-upgradeable market implementations cloned by a permissioned registry factory.

The Amoy deployment uses Circle test USDC at `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582`.

## Verification

```sh
forge fmt --check
forge test
forge build --sizes
```

## Amoy deployment

Copy `.env.example` to an untracked `.env`, provide a funded testnet deployer and the frozen role addresses, then run:

```sh
source .env
forge script script/DeployAmoy.s.sol:DeployAmoy --rpc-url amoy --broadcast
forge script script/CreateAmoyMarket.s.sol:CreateAmoyMarket --rpc-url amoy --broadcast
```

Never use a production private key or real-value collateral with this unaudited testnet MVP.

The complete role, web-app, epoch, resolution, and reconciliation procedure is in `../docs/runbooks/POLYGON_AMOY_MVP.md`. A tested Node operator command is available from `../prototype/live-market-app` with `npm run operator -- <command>`.
