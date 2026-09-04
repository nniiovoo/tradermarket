---
status: accepted
---

# Use native USDC and abstract Polygon gas

Competition Markets will use Circle's native USDC on Polygon as their sole Collateral and accounting currency, covering AMM liquidity, position purchases, fees, refunds, Redemption, and separately itemized gas reimbursement; bridged variants and internal platform credits are excluded. A connected wallet will control a deterministic one-owner Safe smart account whose ERC-4337 UserOperations use a call-restricted Market Paymaster: the paymaster spends POL and collects only the actual converted network cost through a pre-quoted, user-capped USDC Gas Charge with no markup, refunding unused authorization and keeping the charge separate from market economics. Unlike a permanently subsidized relayer, this makes users bear their own network cost while still needing no POL; ordinary service remains rate-limited, settlement uses a protected POL reserve, and every contract retains a self-paid POL path, at the cost of token-paymaster, conversion-rate, bundler, monitoring, and Sybil-abuse complexity.
