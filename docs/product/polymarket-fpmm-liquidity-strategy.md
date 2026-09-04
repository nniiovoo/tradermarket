# Polymarket FPMM Liquidity Research and Livestream Competition Strategy

Status: Current product discussion record  
Decisions: [ADR 0017](../adr/0017-use-per-market-permissionless-fpmm-liquidity.md) and [ADR 0020](../adr/0020-use-event-driven-market-gating.md)
Specification: [On-Chain Livestream Prediction Markets](../specs/livestream-prediction-markets.md)

## Purpose

This document records the reasoning behind the first liquidity design for TraderMarket's variable-duration Live Competitions. It separates:

1. what early Polymarket actually did;
2. what the FPMM mechanism can and cannot do; and
3. which parts TraderMarket has chosen to adopt or change.

The distinction matters. An automated market maker automates pricing and execution. It does not create economic liquidity without real collateral.

## Short conclusion

TraderMarket will learn three core lessons from early Polymarket:

- every Live Competition has its own independent FPMM liquidity pool;
- any eligible community user can supply native USDC and become an LP; and
- LPs receive a proportional share of the market's Liquidity Fees.

TraderMarket will not require a separate crowdfunding stage or a Liquidity Activation Threshold. After Participant readiness, the Live Session start, terminal condition, Market Gate, and its empty FPMM are frozen. The first valid community LP submission initializes backed reserves and makes AMM execution available only after a Safe Event Watermark clears its Forecasting Epoch. If nobody supplies liquidity, the Live Competition may still run, but the audience market remains non-executable.

Forecaster purchases, AMM sales, permitted Outcome Position transfers, and price-preserving community LP additions may be submitted before and during the Live Session while the Market Gate is Open. Each remains pending through the Source Finality Delay until a Safe Event Watermark clears its short Forecasting Epoch; a Decisive Event closes the gate and refunds the overlapping and later uncleared actions. Cleared purchases pay the 1% Winner Reward Fee and 0.3% Liquidity Fee; cleared sales pay only the 0.3% Liquidity Fee deducted from gross USDC output.

The Livestream is a viewing surface rather than an Official Result Source or a market-safety clock. Event-driven gating and pending epochs are necessary because the competition end is not known in advance.

The Protocol Operator supplies no base liquidity and receives no LP Share. This is a deliberate TraderMarket decision, not a claim that early Polymarket never supplied liquidity itself.

## Terms

### FPMM

A Fixed Product Market Maker holds reserves of mutually exclusive Outcome Positions and quotes trades using a constant-product rule. For a binary market with reserves `x` and `y`:

```text
x * y = k
```

Buying the `x` outcome makes it scarcer in the pool and increases its price. Selling or buying the opposite outcome moves the reserve ratio in the other direction.

### Liquidity Provider

An LP supplies collateral-backed outcome inventory to a particular FPMM. In exchange, the LP receives a proportional claim on the pool's resolved inventory and on Liquidity Fees earned while that LP owns the position.

An LP is a capital provider, not merely a smart contract. The smart contract enforces the AMM rules; real people or organizations supply the capital.

### Liquidity, volume, and open interest

These are different quantities:

| Quantity | Meaning |
| --- | --- |
| Liquidity | How much can trade without a large price movement |
| Volume | The cumulative value traded over time |
| Open interest | The value of outstanding unsettled positions |

A 1,000 USDC pool can process much more than 1,000 USDC in cumulative volume when capital turns over. It cannot offer a reasonable price for a one-sided 1,000,000 USDC order without much more depth.

## What early Polymarket actually did

### One pool per market

Early Polymarket used a separate FPMM deployment for each market. Liquidity was market-specific rather than automatically shared across unrelated questions. A popular market could become deep while an unpopular market remained shallow.

This isolated inventory and pricing risk. It also meant that adding liquidity to one market did not help another market.

### Permissionless LP participation

Polymarket's legacy interface allowed any user to add liquidity to a selected market. The LP received pool shares and accepted exposure to that market's outcome-token inventory.

The underlying FPMM contract exposes `addFunding()` to any caller. The first funding operation can provide a `distributionHint` that establishes the initial outcome-reserve ratio. Later funding must enter relative to the existing pool and cannot provide another initial distribution hint.

### LP trading fees

Traders paid fees to the market's LPs. Fees were allocated pro rata according to LP ownership. During the period described by the United States Commodity Futures Trading Commission's January 2022 order, Polymarket generally charged a 2% transaction fee for this purpose and had changed its LP policies over time.

The historical percentage is evidence that prediction-market LP risk may require more compensation than a low-risk savings product. It is not the fee TraderMarket has chosen for its MVP.

### Polymarket sometimes supplied liquidity

The CFTC order states that Polymarket and its employees acted as LPs from time to time. The public sources reviewed do not identify the first funder for every market, so it would be inaccurate to claim that every early market was seeded exclusively by unrelated public users.

### Additional liquidity incentives

Polymarket later experimented with liquidity mining and fee rebates on selected markets. Its first published epoch allocated 50,000 USDC and 10,000 UMA across liquidity provisioning, fee rebates, and community bounties.

Rewards were concentrated on designated markets instead of being spread equally over every market. This helped direct scarce LP capital toward markets Polymarket wanted to deepen.

### Low liquidity remained low liquidity

Polymarket did not make a small pool behave like a large one. In a shallow FPMM, a large one-sided purchase received a worse average execution price and pushed the displayed probability toward `1`. The market could technically continue quoting, but at a price the trader might reject.

The public historical strategy was therefore a combination of:

```text
market-specific FPMM
    + public LP participation
    + LP trading fees
    + occasional company or employee liquidity
    + selected liquidity incentives
```

It was not an infinite-liquidity algorithm.

## What early Polymarket did not publicly establish

The reviewed public record does not establish that Polymarket had:

- a universal customer-facing "funding stage" for every market;
- a universal minimum Liquidity Activation Threshold before trading;
- a rule requiring the named market creator personally to seed every pool; or
- a mechanism that guaranteed good execution for every possible order size.

The FPMM contract supports creation with initial funds or creation followed by a later first `addFunding()` call. That contract capability does not prove which address funded every historical Polymarket market.

## How pool depth affects execution

Assume a binary pool begins with:

```text
1,000 A-wins positions
1,000 B-wins positions
k = 1,000,000
```

Both outcomes begin near `0.50`.

If audience demand removes A-wins positions, the remaining A reserve falls and the B reserve grows. A becomes more expensive. The spot-price approximation is:

```text
price(A) = B reserve / (A reserve + B reserve)
price(B) = A reserve / (A reserve + B reserve)
```

For example:

```text
A reserve = 800
B reserve = 1,250

price(A) = 1,250 / 2,050 ~= 0.61
price(B) =   800 / 2,050 ~= 0.39
```

The apparently reversed numerator reflects scarcity: a large B reserve and small A reserve show that traders have been taking A out of the pool.

### A very large order against a small pool

With 1,000 USDC of balanced initial liquidity, a hypothetical 1,000,000 USDC purchase of A can still be quoted by the idealized fee-free FPMM. However:

- its average execution price is approximately `0.999` USDC per A position; and
- its final spot price is approximately `0.999999`.

The pool does not need to promise a million dollars of cheap A inventory. Its curve makes continued one-sided demand progressively more expensive. A buyer who pays almost `1` for a claim redeemable at at most `1` has almost no remaining upside.

This is how an FPMM avoids being cheaply emptied. It does not solve the lack of depth; it prices that lack of depth.

## TraderMarket decisions learned from Polymarket

### 1. One isolated pool for every Live Competition

Every accepted one-versus-one Live Session receives exactly one Competition Market and one FPMM. Its native USDC Collateral, Outcome Positions, LP Shares, fees, and settlement accounting remain isolated from every other Live Session.

Examples:

| Competition | Liquidity |
| --- | ---: |
| Participant A vs Participant B | 50,000 USDC |
| Participant C vs Participant D | 2,000 USDC |
| Participant E vs Participant F | 0 USDC |

The third competition can still run as a game, but its audience market cannot execute until a first LP supplies real collateral.

### 2. Any eligible user may become an LP

After both Participants complete readiness:

1. the protocol freezes the Competition Template, identities, source, terminal condition, Live Session start, Market Gate, and epoch rules;
2. it creates an empty per-session FPMM at the published Reference Probability;
3. any eligible non-Participant wallet may submit native Polygon USDC while the Market Gate is Open;
4. the first Safe Event Watermark-cleared deposit creates the first fully backed complete sets and initializes executable reserves; and
5. later LPs may submit price-preserving additions into Forecasting Epochs until a Decisive Event causes Forecasting Close.

Participants, their reward addresses, production insiders, their Linked Competition Account ownership wallets, and disclosed controlled or related wallets cannot supply liquidity to the connected Competition Market.

There is no separate Liquidity Activation Threshold. The UI may say `Waiting for first liquidity` while the pool is empty, but that is a market state, not a crowdfunding campaign or a promise that the eventual pool will have good depth.

### 3. LPs earn proportional Liquidity Fees

The current MVP purchase-budget split remains:

| Use of a 100 USDC purchase budget | Amount |
| --- | ---: |
| AMM trade input | 98.70 USDC |
| Whole-market Winner Reward Fee | 1.00 USDC |
| Liquidity Fee | 0.30 USDC |

The 1% Winner Reward Fee from purchases of either outcome enters one pool paid to the final winning Participant. It does not belong to LPs and never backs Forecaster Redemption.

The separate 0.3% Liquidity Fee belongs to LPs. If Alice owns 60% of the LP Shares when a trade occurs and Bob owns 40%, Alice earns 60% of that trade's Liquidity Fee and Bob earns 40%.

Fee checkpoints ensure that a later LP earns only future fees. A new LP cannot deposit immediately before settlement and claim fees earned before entry.

### LP ownership example

Before any audience trade:

| LP | Deposit | Pool ownership |
| --- | ---: | ---: |
| Alice | 600 USDC | 60% |
| Bob | 300 USDC | 30% |
| Carol | 100 USDC | 10% |
| Total | 1,000 USDC | 100% |

If the market later generates 30 USDC in Liquidity Fees while these ownership percentages remain unchanged:

| LP | Liquidity Fees |
| --- | ---: |
| Alice | 18 USDC |
| Bob | 9 USDC |
| Carol | 3 USDC |

Adding an LP changes future ownership percentages. It does not retroactively reallocate past fees.

## First and later liquidity

### First LP

The first LP does not choose an arbitrary price in the TraderMarket MVP. The approved Competition Template freezes a 50/50 Reference Probability for the first binary markets. The first cleared deposit creates equal complete-set reserves at that value.

This differs slightly from the generic FPMM contract, which permits a first funder to supply an initial distribution hint. Fixing the value in the template prevents the first LP from unilaterally choosing the opening probability.

### Later LPs

A later deposit must preserve the current Implied Probability. It therefore enters according to the current reserve ratio. Any surplus Outcome Position required by the complete-set split remains attached to that provider as an LP Adjustment Position.

This prevents a new LP deposit from:

- resetting the displayed price;
- transferring value from existing LPs;
- claiming fees generated before entry; or
- creating unbacked Outcome Positions.

## LP risk

LP fees are compensation, not guaranteed profit. An LP is exposed to the pool inventory created by audience trading.

Possible results include:

- two-sided trading generates fees and leaves balanced inventory;
- informed one-sided trading leaves the pool holding more losing positions;
- the final resolved inventory is worth less than the LP's original deposit; or
- earned fees offset some or all of the inventory loss.

The product must never describe LP participation as savings, interest, fixed yield, or guaranteed principal.

Before an LP signs, the UI must show:

- the deposited USDC amount;
- current total liquidity;
- estimated LP Share ownership;
- current pool reserves and Implied Probability;
- fees earned after entry;
- estimated resolved value under an A win, B win, tie, or invalidation; and
- a prominent warning that the LP can lose value.

## Market lifecycle

```text
Competition Offer accepted
        |
Participants complete readiness
        |
Source, terminal condition, Live Session start, Market Gate, and market configuration become immutable
        |
Empty per-market FPMM is created
        |
        +-- no LP --> competition may run; audience market stays non-executable
        |
        +-- first LP epoch clears --> backed reserves exist; forecasting becomes executable
                                      |
                              more community LPs may join
                                      |
                              actions enter pending Forecasting Epochs
                                      |
                              Live Session starts; performance baseline freezes
                                      |
                              Safe Event Watermarks clear safe epochs
                                      |
                              cleared audience actions move price
                                      |
                              Decisive Event occurs; Forecasting Close
                                      |
                              overlapping epoch refunds
                                      |
                              oracle resolution and settlement
```

The Live Session start does not depend on reaching a liquidity target. If a first LP epoch clears late, forecasting begins late and remains available only while the source-driven Market Gate stays Open. Neither a Participant nor the Protocol Operator may delay the source-defined terminal condition, reopen Forecasting Close, or mark an unsafe epoch safe to help an underfunded market.

All cleared LP Positions remain locked through final Resolution or invalidation in the MVP. This is a TraderMarket simplification for variable-duration Live Sessions; it is not presented as a historical Polymarket rule.

## Forecaster execution and slippage

The contract must enforce the Forecaster's signed minimum output and transaction deadline. The UI defaults to a conservative slippage tolerance and displays:

- current liquidity;
- quoted average execution price;
- price impact;
- resulting Implied Probability;
- all fees; and
- maximum loss and possible redemption.

There is no protocol-wide 5% price-impact rejection in the adopted design. A knowledgeable Forecaster may explicitly accept greater price impact, just as a shallow FPMM naturally quotes it. The interface must require deliberate confirmation for unusually high impact and must never hide the poor execution behind a generic `Buy` action.

The same execution rules apply during the running Live Session while the Market Gate is Open. A submitted action remains pending and changes no reserve, position, LP ownership, or fee until a signed Safe Event Watermark clears its complete epoch. Cleared purchases pay the 1% Winner Reward Fee and 0.3% Liquidity Fee; cleared sales pay a 0.3% Liquidity Fee deducted from gross output and create no Winner Reward. An unsafe, expired, or minimum-output-failing action refunds its market amount and creates no trading fee, although a mined action may still owe its separately authorized actual USDC Gas Charge.

Live Official Scores must carry source sequences, timestamps, and stale-data warnings. A stale source suspends new submissions; a Decisive Event irreversibly closes the Market Gate and refunds the overlapping and later uncleared epochs.

## Cold-start incentives

The accepted base mechanism is the 0.3% Liquidity Fee. Historical Polymarket evidence suggests that fees alone may not deepen every new market, so TraderMarket may later test separately funded incentives on selected competitions.

Any future incentive must:

- disclose its amount and funding source;
- target selected markets rather than imply universal depth;
- remain separate from Outcome Position backing, Winner Rewards, Integrity Bonds, and paymaster reimbursement; and
- avoid granting the Protocol Operator an undisclosed LP position.

No additional LP subsidy is part of the current accepted decision.

## Integrity boundaries

The winning Participant receives the whole-market Winner Reward Pool so that audience activity creates a direct incentive to win. Nevertheless, this reward cannot by itself prevent a Participant or production insider from secretly taking the opposite position through another wallet.

Therefore:

- both Participants, production insiders, and disclosed related wallets are prohibited from Outcome Positions and LP Shares in the connected Competition Market;
- every Participant posts a separate Integrity Bond;
- the protocol gathers performance only from the pre-declared Linked Competition Account and Source Policy boundary;
- settlement follows published Performance Records, the Competition Metric, and the frozen oracle process; and
- objective violations follow a pre-published evidence and review policy.

An oracle can establish the observed result. It cannot prove a person's hidden intent or discover every undisclosed wallet.

## Collateral and chain

- Polygon PoS is the intended production chain; Amoy is used for the MVP.
- Native Circle USDC is the sole Competition Market Collateral.
- USDT may later be converted to native USDC before a market action, but parallel USDC and USDT pools are not part of the MVP.
- ERC-4337 and a restricted paymaster may abstract POL gas while charging a separately quoted USDC Gas Charge.
- The paymaster does not supply AMM liquidity and never becomes an LP.

## Later hybrid order book

The permissionless FPMM is the cold-start execution layer. It does not prevent a later central limit order book.

When volume and professional market-making activity justify the complexity, a hybrid router can:

1. execute against better-priced resting limit orders first;
2. route remaining quantity to the same market's FPMM; and
3. settle both paths using the same fully backed Outcome Positions.

The FPMM then remains a continuous backstop while the order book provides more capital-efficient pricing on popular markets.

## Decisions still open

The following details remain deliberately unresolved:

1. whether 0.3% is enough to compensate early LPs for prediction-market inventory risk;
2. the treatment of Liquidity Fees when a market becomes Invalid;
3. whether selected markets receive temporary, separately funded LP rewards;
4. per-wallet LP concentration limits;
5. whether later long-duration markets permit pre-resolution LP withdrawals;
6. the Forecasting Epoch length, Source Finality Delay, action timeout, and deterministic execution order;
7. the Safe Event Watermark signer, source-sequence, freshness, and suspension rules; and
8. the production legal, jurisdictional, and participant-eligibility controls.

## Sources

- [Polymarket legacy liquidity documentation](https://legacy-docs.polymarket.com/faq/liquidity): permissionless liquidity, proportional LP fees, slippage, and LP risk.
- [Polymarket legacy liquidity mining and trading rewards](https://legacy-docs.polymarket.com/liquidity-mining-and-trading-rewards): selected-market subsidies and the first published reward epoch.
- [CFTC January 2022 Polymarket order](https://www.cftc.gov/media/6891/download?attachment=): market-specific pools, public `add liquidity` participation, transaction fees, the need for liquidity before transactions, and company or employee LP participation from time to time.
- [Gnosis FixedProductMarketMaker contract](https://github.com/gnosis/conditional-tokens-market-makers/blob/master/contracts/FixedProductMarketMaker.sol): `addFunding`, first-funder distribution hints, LP shares, buying, selling, fee accounting, and funding removal.
- [Gnosis Conditional Tokens developer guide](https://gnosis-conditional-tokens.readthedocs.io/en/latest/developer-guide.html): complete-set splitting, merging, and redemption.
- [Current Polymarket market-making documentation](https://docs.polymarket.com/trading/market-making): the later order-book market-making model.
- [Current Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards): incentives for useful resting orders under the later CLOB model.
