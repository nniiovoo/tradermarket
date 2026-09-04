---
status: superseded
superseded-by: 0015
amends: 0004
---

# Auto-seed the FPMM from a shared liquidity vault

The MVP will expose no public or manual Liquidity Provider workflow. After both Competitors complete readiness, a shared TraderMarket Liquidity Vault automatically allocates exactly 1,000 Circle test USDC to the approved Winner Market, splits that Collateral into complete sets, and deposits equal Outcome Position reserves into the fixed-product AMM. Equal reserves open the two-Competitor market at a 50/50 Implied Probability, and the reserve product `x * y = k` determines subsequent pricing as Forecasters buy and sell.

The vault is technically the market's Liquidity Provider even though users never see or manage an LP feature. Its market-specific liquidity entitlement remains locked from market opening through final Resolution or invalidation. After every Forecaster Redemption, refund, Winner Reward Pool, and other senior liability remains fully covered, the resolved AMM inventory, remaining principal, and accrued AMM reserve fees return automatically to the shared vault for reuse. The protocol does not guarantee that every market returns the original 1,000 USDC: the vault bears the AMM's inventory and informed-flow risk and must be funded, capped, and monitored accordingly.

The MVP uses a fixed seed to keep markets and test results comparable. A market does not open when the vault lacks the full seed. Community LP deposits, variable seed sizing, and transferable LP positions are deferred. A Polymarket-style CLOB remains a later migration path after activity and professional market-making justify it.

ADR 0015 replaces the sole-vault model with permissionless pre-open liquidity provision. The shared vault remains the base-seed provider but is no longer the only Liquidity Provider.

ADR 0016 later removed the shared vault and all Protocol Operator liquidity capital. ADR 0017 now contains the accepted cold-start model: one independent FPMM per market, permissionless public LP participation, immediate execution after the first valid community deposit, and no separate activation threshold.
