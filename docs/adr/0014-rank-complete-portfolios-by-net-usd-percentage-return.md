---
status: superseded
superseded-by: 0019
---

# Rank complete portfolios by net USD percentage return

Competitors keep using their own external Linked Trading Accounts and may trade any instrument admitted by the Round's frozen Source Policy. A linked account may principally use USDC or USDT, and Competitors may use different instruments, strategies, venues, and account sizes. BTC and ETH are initial connector fixtures rather than permanent product restrictions.

The protocol ranks the complete Eligible Portfolios by net USD percentage return: `(ending eligible USD equity - starting eligible USD equity - net external capital flow) / starting eligible USD equity`. Realized and unrealized P&L, trading fees, funding, and liquidation losses remain in eligible equity, while verified deposits and withdrawals are neutralized through net external capital flow. The higher final return wins, an exact tie uses a 50/50 payout vector, and a Competitor with a complete record but no trading activity has a valid 0% return.

Every holding, position, fee, funding payment, and capital flow inside the immutable account boundary must be collected and valued; a Competitor cannot omit losing activity. If the frozen Source Policy cannot collect an instrument completely or value it reliably in USD, the Performance Record and Winner Market become Invalid instead of guessing or awarding the opponent a default win. The initial supported instrument list, USD reference sources, stablecoin treatment, timestamp rules, and rounding remain pre-implementation details.

ADR 0019 replaces net-USD portfolio return as the universal metric with a Competition Metric selected by each approved fixed-duration Competition Template. This calculation may return later for a trading-specific template.
