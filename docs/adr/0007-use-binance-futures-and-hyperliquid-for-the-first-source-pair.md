---
status: superseded
superseded-by: 0019
---

# Use Binance Futures and Hyperliquid for the first source pair

The first cross-source prototype will compare one Competitor-controlled USDC-only Binance USDⓈ-M Futures Testnet account boundary with one Hyperliquid Testnet USDC perpetual account or subaccount, restricted to BTC and ETH perpetuals and complete-portfolio accounting. The Binance side uses a dedicated test account or a subaccount where supported, avoiding dependence on undocumented Testnet subaccount behavior; this pairing tests both private read-only credentials and public on-chain data without approving either source for production availability in any jurisdiction.

ADR 0014 retains Binance and Hyperliquid as the first connector pair but removes USDC-only and BTC/ETH-only restrictions from the product rule. Those currencies and instruments may remain initial fixtures while the accepted model admits any complete Source-Policy-supported portfolio that can be valued reliably in USD.

ADR 0019 removes this connector pair from the active MVP. A later trading Competition Template may reuse the research, but the first Livestream Competition Source remains an explicit product decision.
