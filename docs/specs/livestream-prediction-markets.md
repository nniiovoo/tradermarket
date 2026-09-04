# Product Spec: On-Chain Livestream Prediction Markets

Status: Draft

Supersedes: On-Chain Trader Prediction Markets (earlier draft, not published)

Decisions: [ADR 0020 — Use event-driven market gating](../adr/0020-use-event-driven-market-gating.md), [ADR 0025 — Use canonical broadcast evidence for observable livestream events](../adr/0025-use-canonical-broadcast-evidence-for-observable-livestream-events.md)

## Summary

Create a protocol where two Participants enter an objectively resolved Live Competition of unknown duration, broadcast it through a Livestream, and let the audience acquire collateral-backed Outcome Positions on who will win. The Live Competition and its Competition Market are connected, but they are not the same thing: the Official Result Source, terminal condition, and frozen Competition Metric determine the result, while the Livestream lets the audience watch it.

ADR 0025 adds a narrow second template: an objective Livestream Event Market over one exact official broadcast, such as which named guest first satisfies a frozen on-screen appearance rule. In that template the live player remains non-authoritative; the approved source record is the complete hashed Canonical Stream Recording for the frozen Observation Window, independently reviewed by the Resolver Set. An isolated highlight clip, audience reaction, or operator statement is never enough.

Smart contracts hold native Polygon USDC as Competition Market Collateral, run one independent Community-Funded FPMM for each Live Session, escrow pending live actions, enforce the source-driven Market Gate, record Resolution, distribute Winner Rewards and Liquidity Fees, and enable Redemption. The Protocol Operator does not supply market liquidity, custody Participant assets, choose the Winner, or treat the Livestream as an oracle.

The Live Session starts at a published time and ends only when the Official Result Source reports the frozen terminal condition. Because its end is unpredictable, live purchases, sales, transfers, and liquidity additions settle through short Forecasting Epochs only after a Safe Event Watermark confirms that no Decisive Event occurred during that epoch.

## Product promise

For Forecasters: watch a live head-to-head competition and take a transparent, market-priced position on who will win under rules published before the session.

For Participants: invite an opponent, compete live using an approved format, build a verifiable competitive record, and receive the whole-market Winner Reward Pool after a valid win.

For Liquidity Providers: supply market-specific USDC liquidity, earn future 0.3% Liquidity Fees, and knowingly accept proportional AMM inventory risk without any promise of principal or profit.

## Product principles

- **The competition is primary:** audience trading cannot change the Official Score, Winner, Participant Rating, or integrity judgment.
- **The live player is non-authoritative:** an embed or mutable VOD is a viewing surface. Only an approved source record determines the result; a Livestream Event Market may use a complete hashed Canonical Stream Recording under ADR 0025.
- **Objective formats only:** every Competition Template has a deterministic terminal condition, Competition Metric, complete source coverage, and invalidation rule.
- **Event-driven close:** the Market Gate suspends on stale data and closes irreversibly when the Official Result Source reports a Decisive Event.
- **No post-result execution:** live actions remain pending through the Source Finality Delay until a Safe Event Watermark clears their Forecasting Epoch.
- **On-chain market custody:** Competition Market Collateral follows immutable smart-contract rules rather than an operator-controlled account.
- **Community liquidity:** real eligible users supply all FPMM reserves; the Protocol Operator supplies no liquidity capital and receives no LP Share.
- **Fully backed positions:** the protocol cannot create redeemable claims exceeding locked Collateral.
- **Published rules:** Participant identities, account boundaries, terminal condition, metric, Market Gate policy, Forecasting Epoch policy, fees, integrity rules, Official Result Source, and Resolver Set freeze before forecasting begins.
- **Safe failure:** missing or contradictory result evidence produces an Invalid Market rather than a default win.
- **Explicit risk:** price impact, LP inventory loss, data freshness, gas reimbursement, and invalidation rules are disclosed before signing.

## Users and jobs

### Forecaster

- Discover upcoming and running Live Competitions.
- Watch the Livestream and inspect timestamped Official Scores.
- Compare Participants, ratings, rules, prices, liquidity, fees, and Resolution evidence.
- Submit a purchase or sale while the Market Gate is Open and track it as pending until its Forecasting Epoch clears.
- Redeem a winning position or receive the applicable invalid-market refund.

### Participant

- Invite any person through a shareable Competition Invitation.
- Create an open or directed Competition Offer from an approved Competition Template.
- Prove identity and control of the required Linked Competition Account.
- Complete readiness, disclose related and production-insider wallets, and commit an Integrity Bond.
- Compete until the frozen source-defined terminal condition occurs.
- Receive a verifiable Official Score, competitive result, rating update, and any final Winner Reward.

### Liquidity Provider

- Inspect one Competition Market's rules, reserves, price, fees, and loss scenarios.
- Become the first LP or submit price-preserving liquidity while the Market Gate is Open.
- Receive an LP Position and earn only Liquidity Fees generated after entry.
- Wait until final Resolution or invalidation before settling the locked LP Position.

### Protocol Operator

- Approve versioned Competition Templates, Competition Sources, Source Policies, and oracle adapters.
- Maintain interfaces, stream embedding, source collection, and monitoring.
- Never custody market Collateral, select a Winner, extend a locked session, or use an operator announcement as result evidence.

## Recommended MVP

### Competition format

- Every Live Competition has exactly two Participants and one variable-duration Live Session.
- The session has a published start but no predetermined end time.
- Each Competition Template freezes Participant eligibility, Competition Source, Source Policy, Linked Competition Account type, objective terminal condition, Competition Metric, tie rule, stream requirements, Source Finality Delay, Market Gate and Forecasting Epoch policies, integrity policy, rating policy, fee rule, and Resolution configuration.
- The Official Result Source emits monotonic source sequences and identifies the Decisive Event that satisfies the terminal condition.
- Team, tournament, multiplayer, subjective judging, audience-voted results, and unbounded arbitrary creator questions are deferred. A versioned Livestream Event template may admit a binary observable event with a complete-recording source policy, frozen Observation Window, objective rule, and Invalid fallback.
- A trading competition is a possible later template, not the universal product model.

### Invitation and matchmaking

- An eligible Participant may generate a revocable Competition Invitation and share it by link or QR code with any person, including an unregistered recipient.
- An invitation begins onboarding only. It creates no Competition Offer, Live Session, Competition Market, LP Position, or Collateral obligation.
- An eligible Participant may create one open Competition Offer or one directed offer to a verified Participant.
- An offer uses one approved Competition Template and expires after 30 minutes.
- The first compatible acceptance of an open offer succeeds atomically; only the named recipient may accept a directed offer.
- Self-pairing, related parties, duplicate Linked Competition Accounts, incompatible Source Policies, overlapping unresolved competitions, expired offers, and replayed offers are rejected.
- Acceptance creates a Draft Competition. Both Participants then have 10 minutes to complete readiness.
- An unaccepted offer may be cancelled by its creator. After acceptance, neither Participant nor the Protocol Operator can replace a Participant, change frozen rules, or move the start.

### Readiness and start

- Readiness verifies current Participant identity, Linked Competition Account control, Competition Source eligibility, Livestream configuration, related and production-insider disclosures, Integrity Bond commitment, reward address, terminal condition, source sequence, Source Finality Delay, Market Gate, Forecasting Epoch, and oracle configuration.
- When both Participants become ready, the protocol schedules the Live Session exactly 30 minutes later; no end timestamp is created.
- The Competition Market and its empty FPMM are created only after readiness succeeds.
- The Live Competition starts at its timestamp whether or not liquidity has arrived and without requiring another Participant transaction.
- If the published start cannot be honored, the existing Competition Market becomes Invalid and a replacement requires a new Competition Offer and market.

### Competition data and Livestream

- The Competition Source must produce complete, timestamped, monotonically sequenced facts for both Participants across the same Live Session.
- The Source Policy defines identity binding, included events, terminal-event detection, missing-data states, correction handling, normalization, scoring precision, freshness, and evidence retention.
- The Competition Metric converts both Performance Records into comparable Official Scores.
- A Participant cannot select favorable actions while omitting unfavorable actions from the same frozen account or identity boundary.
- The Livestream may display official scores and source timestamps, but a live embed, commentary, overlays, chat, creator announcements, and an isolated clip are never result evidence by themselves. Under a Livestream Event template, the complete hashed Canonical Stream Recording and frozen Observation Window form the approved source record.
- Stream failure does not select a Winner. The UI reports the failure separately from Competition Source freshness.
- Stale source data suspends the Market Gate immediately. After the Decisive Event, missing source facts receive a 30-minute Performance Recovery Window; if either Performance Record remains unverifiable, the Competition Market becomes Invalid.
- The first production Competition Source and Competition Template remain to be selected; Binance, Hyperliquid, and net-USD portfolio return are no longer assumed MVP dependencies.

### Participant ratings

- A new Participant begins with provisional 1,000 Overall and per-Competition-Template ratings.
- The provisional label remains through 10 valid rated Live Competitions.
- A valid result updates Overall and selected Competition Template ratings once using a frozen Elo-style Rating Policy; Invalid and explicitly Unrated competitions change none.
- A win is scored as 1, an exact tie as 0.5, and a loss as 0 for rating purposes.
- Use a 400-point expectation scale, `K = 40` before 10 valid rated career results, and `K = 20` afterward.
- Only the first two Rated Live Competitions between the same Participants in a rolling 24-hour period affect ratings. Later rematches must be explicitly Unrated.
- Seasons last 30 days and carry 75% of each rating's distance from 1,000 into the next Season without changing permanent career history.
- Forecasting prices, volume, Collateral, liquidity, Outcome Position ownership, and Winner Rewards never affect Participant Ratings.

### Competition Market

- Every ready Live Session has exactly one binary Competition Market and one independent Community-Funded FPMM.
- Each Outcome Position corresponds to one Participant and redeems for the final payout fraction: 1 for a sole Winner, 0 for the loser, and 0.5 each for an exact tie.
- The first market template uses a non-executable 50/50 Reference Probability.
- The market becomes executable only after the first LP deposit's Forecasting Epoch clears and creates real, fully backed complete-set reserves.
- The Forecasting Window opens after readiness and remains available while the Market Gate is Open.
- Purchases, AMM sales, permitted Outcome Position transfers, and LP additions enter a short pending Forecasting Epoch; submission does not immediately change FPMM reserves, ownership, or fees.
- After the frozen Source Finality Delay, a signed Safe Event Watermark clears an epoch only when the source remained fresh and no Decisive Event occurred through its final source sequence.
- Cleared actions apply to the FPMM in deterministic on-chain submission order, subject to each action's deadline and minimum-output or minimum-share protection.
- A stale source moves the Market Gate to Suspended and rejects new actions. Freshness recovery may reopen it only when no Decisive Event occurred.
- A Decisive Event causes irreversible Forecasting Close. The overlapping and every later uncleared epoch are voided and refunded, and no market or liquidity action reopens before Resolution or invalidation.

### Permissionless FPMM liquidity

- The Protocol Operator supplies no market liquidity and receives no LP Share.
- Any eligible wallet except a Participant, reward address, production insider, disclosed related wallet, Linked Competition Account owner, or a deterministic smart account owned by one of those parties may provide liquidity.
- The first valid LP submission remains escrowed until its Forecasting Epoch clears, then creates equal backed outcome reserves at the frozen 50/50 Reference Probability and enables AMM execution.
- There is no separate funding stage, crowdfunding target, Liquidity Activation Threshold, or guaranteed minimum depth.
- If no LP arrives, the Live Competition still runs and resolves, but its Competition Market remains non-executable.
- A later LP submission joins a pending Forecasting Epoch and, only after clearance, enters at the current reserve ratio, receives proportional non-transferable LP Shares and any required LP Adjustment Position, and does not change the Implied Probability.
- Each LP receives a fee checkpoint and earns only Liquidity Fees generated after entry.
- Every LP Position remains locked through final Resolution or invalidation.
- LPs receive resolved AMM inventory and Liquidity Fees pro rata and may receive less than their original deposit.
- Pool size controls depth, not total possible cumulative volume. Large one-sided orders against a shallow pool receive increasingly unfavorable prices.

### Fees and Winner Reward

- A 100 USDC purchase budget is divided into 98.70 USDC of AMM trade input, a 1.00 USDC Winner Reward Fee, and a 0.30 USDC Liquidity Fee, using a frozen six-decimal rounding rule.
- Every AMM sale deducts a 0.3% Liquidity Fee from gross USDC output and creates no Winner Reward.
- Every purchase and sale Liquidity Fee belongs to LP Share holders present when the trade executes.
- Voided, expired, or minimum-output-failing pending actions return their escrowed assets and create no Winner Reward Fee or Liquidity Fee.
- Winner Reward Fees from purchases of both outcomes enter one whole-market Winner Reward Pool.
- A sole final Winner receives the entire Winner Reward Pool. An exact tie divides it using the same payout vector as Outcome Position Redemption.
- An Invalid Market returns Winner Reward Fees to their original fee payers.
- Winner Rewards, Liquidity Fees, LP capital, Outcome Position backing, Integrity Bonds, Resolution bonds, and gas reimbursement remain separate accounting domains.
- The Protocol Operator charges no separate trading fee in the MVP.

### Integrity

- Every Participant registers a reward address and discloses controlled, related, production, and Linked Competition Account ownership wallets before market opening.
- Participants and production insiders may hold no direct or indirect Outcome Position or LP Share in their own Live Competition.
- Each Participant commits exactly 100 Circle test USDC as the Amoy Integrity Bond; the production amount and destination remain undecided.
- Losing, a low Official Score, disconnection, source outage, stream failure, or suspicious-looking performance cannot forfeit a bond.
- Forfeiture requires an objective violation code, frozen evidence rule, review authority, deadline, and destination published before forecasting opens.
- An Integrity Claim may change only the violating Participant's bond disposition. It cannot select the Winner, modify Official Scores, or change Forecaster and LP settlement.
- The Winner Reward aligns a Participant with winning but cannot prove intent or discover every hidden wallet.

### Resolution

- A Safe Event Watermark authorizes market execution only; it does not declare the Winner or replace final Resolution.
- Completed Performance Records and the frozen Competition Metric produce an Evidence Bundle and candidate payout vector.
- Polygon Amoy uses a frozen three-role Resolver Set: Primary Resolver, Independent Verifier, and a two-of-three human Recovery Resolver Safe.
- Two matching valid signatures establish a Provisional Result; one signature cannot.
- Registration starts a 10-minute Challenge Window and does not enable Redemption or reward claims.
- A well-formed bonded Resolution Challenge pauses finalization and identifies an objective rule plus evidence hash.
- An accepted challenge, an unreviewed challenge after 30 minutes, missing resolver quorum after the frozen deadline, or unrecoverable evidence makes the market Invalid.
- Production uses a frozen UMA OOV3 adapter and privacy-safe assertion where the Competition Source permits it; unavailable or non-reviewable source evidence fails closed to Invalid.
- An isolated Livestream clip, audience vote, Participant concession, or Protocol Operator statement cannot replace the Official Result Source. A complete Canonical Stream Recording may be that source record only for a frozen Livestream Event template under ADR 0025.

### Polygon, USDC, and gas abstraction

- Polygon Amoy is the test network and Polygon PoS chain ID 137 is the intended production network.
- Native Circle USDC is the sole Competition Market Collateral and accounting asset.
- Bridged USDC variants, USDT pools, crypto-denominated positions, and internal platform credits are excluded from the MVP.
- A deterministic one-owner Safe smart account may execute ERC-4337 UserOperations.
- A call-restricted Market Paymaster pays POL and collects only the actual converted network cost through a separately quoted, user-capped USDC Gas Charge with no markup.
- The user sees expected and maximum gas charges before signing; unused authorization is released or refunded.
- The paymaster may sponsor only approved account deployment, native-USDC funding or approval, purchase, sale, permitted transfer, liquidity addition, Redemption, refund, and reward-claim calls.
- Every market action remains available through a self-paid POL path if sponsorship is paused or unavailable.

## Lifecycle

```text
Competition Invitation (optional)
        |
Competition Offer accepted
        |
Draft Competition
        |
Participants complete readiness
        |
Rules, terminal condition, sources, identities, stream, metric, and gate policy freeze
        |
Live Session start and empty Competition Market are scheduled
        |
        +-- no LP --> competition runs; audience market is non-executable
        |
        +-- first LP epoch clears --> backed FPMM becomes executable
                              |
                       Market Gate Open
                              |
                       actions enter pending Forecasting Epochs
                              |
                       Safe Event Watermarks clear safe epochs
                              |
                       Live Session starts; baseline freezes
                              |
                       live viewing and cleared market actions continue
                              |
                       Decisive Event occurs
                              |
                       Forecasting Close; overlapping epoch refunded
                              |
                       source recovery and score calculation
                              |
                       Provisional Result and Challenge Window
                              |
                       Resolution, Redemption, rewards, LP settlement
```

## Functional requirements

### Invitations and offers

- Invitation secrets are high-entropy, single-purpose, stored only as non-reversible digests, and expire after seven days.
- Invitation secrets stay in URL fragments until deliberately submitted; analytics and access logs never receive plaintext secrets.
- Opening or claiming an invitation never automatically selects an opponent.
- A recipient proves wallet control and completes normal Participant eligibility before the inviter can approve that exact profile.
- An inviter may have at most 10 active invitations and may revoke or replace a leaked invitation.
- Competition Offers bind template version, creator, open or directed mode, recipient when directed, chain ID, verifying contract, nonce, creation time, 30-minute expiry, Rated or Unrated status, and Season.

### Market execution

- Display both outcomes, current Implied Probabilities, liquidity, indicative execution price, price impact, fees, potential Redemption, source freshness, current Forecasting Epoch, Market Gate state, and maximum loss.
- Require a 1 USDC minimum purchase, user-signed minimum output, and transaction deadline.
- Default the interface to 1% slippage tolerance and require deliberate confirmation for unusually high price impact.
- Do not impose a protocol-wide 5% price-impact rejection.
- Escrow every submitted action without changing the cleared market state.
- Require a valid source-signed Safe Event Watermark whose source sequence reaches beyond the epoch boundary before any pending action can execute.
- Apply cleared actions in deterministic on-chain submission order; atomically update FPMM reserves, positions, Winner Reward Fee, and Liquidity Fee for each action that still satisfies its protection.
- Refund the market amount of every action in an unsafe, expired, or failed epoch. A mined action may still owe its separately authorized actual USDC Gas Charge.
- Make safe-epoch finalization and unsafe-epoch refunds permissionless after the required source attestation is available.
- Never execute against virtual reserves or a Reference Probability without real Collateral.
- Never create total redeemable claims greater than locked Collateral.

### Liquidity accounting

- Split every cleared unit of LP Collateral into a complete set of Outcome Positions.
- For a later deposit `D`, existing reserves `r[i]`, largest reserve `M`, and LP Share supply `S`, add `D * r[i] / M` to each pool reserve, attach `D - (D * r[i] / M)` to that LP as its adjustment inventory, and mint `D * S / M` LP Shares using conservative rounding.
- Bind every liquidity addition to user-signed minimum shares and a deadline.
- Leave pending liquidity outside the FPMM and fee-ownership calculation until its epoch clears.
- Checkpoint fees before changing LP ownership.
- Reject LP removals and LP Share transfers before settlement.
- Disclose each LP's value under either Participant win, an exact tie, and invalidation.

### Data, privacy, and evidence

- Gather only source facts required by the frozen Competition Metric and integrity checks.
- Store no Participant credential with action, trade, withdrawal, or asset-transfer authority.
- Separate public evidence from encrypted raw source payloads and direct account identifiers.
- Preserve source sequences, source timestamps, collection timestamps, provenance, calculation version, and integrity hashes.
- Store every Safe Event Watermark and Decisive Event attestation needed to reproduce why an epoch cleared, suspended, closed, or refunded.
- Keep privacy-safe Evidence Bundles publicly reviewable for the frozen retention period.
- Delete encrypted raw payloads after the frozen operational period when no active challenge or documented hold remains and retain an auditable deletion record.
- Stream URLs, video-provider identifiers, and public profile data are not treated as proof of the Official Score.

## Economic and security invariants

1. Audience trading never changes the Official Score, Winner, rating, or integrity verdict.
2. The Livestream never resolves a Competition Market.
3. A pending market action changes no FPMM reserve, position ownership, LP Share, Winner Reward, or Liquidity Fee.
4. No action executes unless a Safe Event Watermark clears its complete Forecasting Epoch.
5. Every Outcome Position is fully collateralized.
6. Winner Reward funds never back Outcome Position Redemption.
7. LP capital and Liquidity Fees never fund Winner Rewards, Integrity Bonds, gas, or operator expenses.
8. The Protocol Operator supplies no LP capital and owns no LP Share.
9. A new LP cannot change the current Implied Probability or claim past fees.
10. A Participant or production insider cannot knowingly participate through a registered or disclosed wallet in their own market.
11. No Protocol Operator key can seize Collateral or change frozen Competition rules.
12. A missing result becomes Invalid rather than a default win.
13. A Provisional Result releases no Collateral, reward, bond, or LP settlement.
14. Every successful, refunded, or reverted sponsored on-chain operation reconciles to actual gas spending without changing market economics.

## Experience outline

### Product shell

- Primary navigation is **Markets**, **Compete**, **Rankings**, and **Portfolio**.
- Visitors may watch and inspect a Competition Market without connecting a wallet.
- The same market route displays Upcoming, Awaiting Liquidity, Open, Action Pending, Source Suspended, Forecasting Closed, Recovering Data, Provisional, Challenged, Final, and Invalid states.
- The default page shows the embedded Livestream, two Participants, Official Scores and timestamps, elapsed time, Implied Probabilities, liquidity, Market Gate state, and one restrained forecast panel.
- The interface says **Buy position**, **Sell position**, and **Review forecast**, not “vote” or casino language.

### Live state

- Before the Live Session, the page shows its scheduled start, terminal condition, Market Gate policy, and current Forecasting Epoch.
- During the session, the Livestream, source freshness, Official Scores, cleared price, pending actions, liquidity, and Market Gate state update independently.
- A video outage displays **Livestream unavailable** without implying that the Competition Source failed.
- Stale official data displays **Market suspended — score feed delayed**, its last source sequence and timestamp, and no new market action.
- After a Forecaster submits an action, the UI displays **Pending source clearance** until the epoch clears or refunds.
- At a Decisive Event, the page displays **Forecasting closed**, refunds the overlapping uncleared epoch under the frozen rule, and remains spectating-only through Resolution.

## Edge cases

- **No first LP:** run and resolve the Live Competition; keep the Competition Market non-executable.
- **First LP submits after session start:** enable the market only if its epoch later receives a Safe Event Watermark.
- **Decisive Event occurs inside an epoch:** close forecasting and refund every action in that overlapping epoch.
- **Old open attestation is replayed after the result:** reject it by source sequence, epoch identity, expiry, and the irreversible closed gate.
- **Source becomes stale before an epoch clears:** suspend the gate and keep the epoch pending only until its frozen timeout; then refund it if safety cannot be proven.
- **Stream begins late or disconnects:** follow the frozen stream policy; never infer a Winner from video availability.
- **Official data remains unavailable after the Decisive Event:** apply recovery and then invalidation rather than inferring a result.
- **Participant disconnects:** apply only the frozen Competition Metric and source rules; do not create an administrator-selected default winner.
- **Exact tie:** redeem both outcomes at 0.5, split Winner Rewards 50/50, and update ratings with a 0.5 result.
- **Invalid Market:** return position Collateral and original Winner Reward Fees under frozen rules; apply the separately frozen Liquidity Fee treatment.
- **Participant or insider wallet forecasts or supplies liquidity:** reject the action and preserve an objective Integrity Claim path for provable circumvention.
- **Large order against shallow liquidity:** quote the curve's poor price and require explicit confirmation; do not pretend the pool supports cheap execution at any size.
- **Postponed start:** invalidate the existing market and create a new Competition Offer rather than moving the frozen start.

## Explicit non-goals for the MVP

- Arbitrary prediction questions unrelated to an approved Live Competition.
- Subjective creator judgments or audience voting as Resolution.
- More than two outcomes, teams, tournaments, or multi-stage brackets.
- Instant irreversible AMM execution during variable-duration live play without source clearance.
- Protocol-funded liquidity, guaranteed market depth, or guaranteed LP returns.
- A CLOB, professional market-maker program, cross-market shared liquidity, or LP withdrawal before Resolution.
- Participant-controlled settlement, operator-selected winners, or Livestream-only evidence.
- Social chat, reactions, quests, casino presentation, or a separate spectator application.
- USDT Collateral, parallel stablecoin pools, bridged USDC, or internal credits.

## Risks

- Livestream and Official Result Source latency may still create information advantages before an epoch closes.
- Safe Event Watermark signing or delivery failures may suspend trading or delay refunds.
- Deterministic epoch execution can produce a different final price from the indicative quote; minimum-output protection may therefore refund some actions.
- Participants or production insiders may conceal related wallets.
- A 0.3% fee may be insufficient to attract early LPs to thin markets.
- One-sided informed flow can cause substantial LP inventory loss.
- Source outages and corrections may increase invalidations.
- A compromised oracle, paymaster, source connector, or stream embed can damage availability or trust.
- An incorrect Decisive Event timestamp or source sequence could clear or void the wrong epoch.
- Production eligibility, jurisdiction, consumer protection, market integrity, and tax treatment require specialist review before real-value launch.

## Decisions required before implementation

1. Select the first variable-duration Competition Template and its objectively detectable terminal condition.
2. Select its Official Result Source, independent verification path, and Source Policy.
3. Define the exact Competition Metric, tie threshold, precision, and missing-data rule.
4. Define the Livestream provider, stream-delay disclosure, outage policy, and embed requirements.
5. Freeze the Forecasting Epoch length, Source Finality Delay, action timeout, deterministic execution order, source sequence-to-time mapping, and Safe Event Watermark signer policy.
6. Freeze the live-data freshness threshold, suspension recovery rule, and maximum pending-epoch lifetime.
7. Freeze the invalid-market treatment of accumulated 0.3% Liquidity Fees.
8. Decide whether the ordinary 0.3% fee is enough or selected markets receive a separately funded incentive.
9. Set production Integrity Bond amounts and objective violation destinations.
10. Define production eligibility, jurisdiction, disclosure, and responsible-participation controls.

## Prototype acceptance criteria

- Two eligible Participants can create and accept a variable-duration Competition Offer and complete readiness.
- The template freezes identities, linked account boundaries, stream, source policy, terminal condition, metric, start, Source Finality Delay, Market Gate, Forecasting Epoch, fees, integrity policy, and Resolution rules.
- An embedded Livestream is visibly labeled non-authoritative and can fail independently from the Official Result Source.
- The protocol schedules the Live Session start without creating an end timestamp.
- The Protocol Operator provides zero market liquidity.
- The first eligible public LP submission creates balanced backed reserves and enables execution only after its Forecasting Epoch clears.
- A later cleared LP deposit preserves the current price, receives an LP Adjustment Position and fee checkpoint, and earns only later fees.
- Forecasters can submit buys and sales while the Market Gate is Open with minimum-output and deadline protection.
- A pending action changes no market state before a Safe Event Watermark clears its complete epoch.
- Cleared actions execute in deterministic submission order, and protection failures refund their market amount without trading fees.
- A 100 USDC purchase divides into 98.70 USDC trade input, 1.00 USDC Winner Reward, and 0.30 USDC LP fee; a sale charges only the 0.3% LP fee.
- Stale source data suspends new forecasting, transfers, and LP additions.
- A Decisive Event irreversibly closes forecasting and refunds the overlapping and later uncleared epochs.
- An action submitted after viewers see the result cannot execute by presenting an older source attestation.
- Two complete Performance Records deterministically produce Official Scores, an Evidence Bundle hash, and the correct payout vector.
- An unavailable or contradictory result follows recovery and then Invalid Market rules rather than selecting a default Winner.
- A sole Winner receives the Winner Reward Pool only after final Resolution.
- Winning Outcome Positions redeem for the correct native-USDC amount, tied positions redeem at 0.5, and invalid positions receive the frozen refund.
- Participant, related, production-insider, and linked-account ownership wallets are rejected from forecasting and liquidity in their own market.
- LP fees and resolved inventory settle pro rata without any principal guarantee.
- The Livestream, Official Score, Implied Probability, Winner Reward, Participant Rating, and market settlement are displayed as distinct concepts.
