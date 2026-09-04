---
status: superseded
superseded-by: 0016
supersedes: 0012
amends: 0004, 0010, 0013
---

# Allow permissionless pre-open liquidity provision

The MVP will let any eligible wallet except either Competitor or a controlled or related wallet deposit native Polygon USDC during a Liquidity Funding Window before audience forecasting begins. The protocol Liquidity Vault supplies the 1,000 test-USDC base seed, community deposits add equal complete sets without changing the 50/50 opening price, and each provider receives non-transferable LP Shares representing its proportional ownership.

When funding closes, additions and removals lock through final Resolution or invalidation. LP Share holders receive the 0.3% Liquidity Fee and the resolved AMM inventory pro rata, accepting that informed audience flow can make the final value lower than their deposit and that neither fees nor the protocol guarantee a profit. The fixed funding-window duration, market liquidity ceiling, and whether the protocol base seed later becomes optional remain deferred; public liquidity lowers treasury concentration but adds funding, disclosure, accounting, and suitability complexity.

ADR 0016 replaces the protocol base seed and pre-open-only funding window with a Community-Funded FPMM that accepts price-preserving additions until the Round starts.
