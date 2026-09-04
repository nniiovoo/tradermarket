# Livestream Prediction Markets

This context describes a protocol where an objectively resolved Live Competition or frozen Livestream Event of unknown duration is broadcast to an audience and paired with an on-chain prediction market. The live player is a viewing surface, never by itself the authority that determines the result or whether live market actions are safe to execute.

## Participants

**Participant**:
A person, team, creator, player, or trader whose verified performance is ranked in a Live Competition.
_Avoid_: Competitor, subject trader, betting subject

**Forecaster**:
An audience participant who acquires an Outcome Position expressing which Participant they expect to win.
_Avoid_: Bettor, gambler, voter

**Liquidity Provider**:
An eligible non-Participant that supplies native USDC to a Community-Funded FPMM and bears proportional inventory risk in exchange for an LP Position and Liquidity Fees.
_Avoid_: House, bookmaker, guaranteed-yield depositor

**Protocol Operator**:
The party that maintains protocol interfaces and approved Competition Templates without custody of Collateral or unilateral control over locked markets.
_Avoid_: House, bookmaker, casino

## Live competition

**Live Competition**:
An objectively resolved contest between exactly two Participants that is available to watch through a Livestream and ends when its frozen terminal condition occurs.
_Avoid_: Livestream, arbitrary prediction question, scheduled-duration contest

**Livestream**:
The audiovisual broadcast of a Live Competition. It helps the audience observe the competition but is not an Official Result Source.
_Avoid_: Result oracle, score record, settlement source

**Livestream Event**:
An objectively observable occurrence in one exact official broadcast, evaluated over a frozen Observation Window under a rule published before its Livestream Event Market opens.
_Avoid_: Audience opinion, creator announcement, arbitrary prompt, subjective moment

**Observation Window**:
The immutable interval of one exact official broadcast that resolvers must review from its opening watermark through the first qualifying event or broadcast end.
_Avoid_: Highlight clip, Challenge Window, scheduled market duration

**Competition Invitation**:
A revocable invitation that lets any person begin Participant onboarding with an inviter but creates no Competition Offer, Live Session, or market rights.
_Avoid_: Competition Offer, accepted competition, market link

**Competition Offer**:
An open or directed invitation created by an eligible Participant from an approved Competition Template that becomes a Draft Competition when one compatible Participant accepts it.
_Avoid_: Competition Invitation, Resolution Challenge, forecast invitation

**Draft Competition**:
An accepted Competition Offer whose Participants must complete readiness before its Live Session and Competition Market are created.
_Avoid_: Open offer, active market, resolved competition

**Competition Template**:
A versioned, approved set of immutable eligibility, terminal-condition, scoring, source, integrity, market-gating, and Resolution rules for one class of Live Competition.
_Avoid_: Editable match settings, hidden rules, market category

**Live Session**:
One occurrence of a Live Competition with an immutable start, Participant set, Competition Metric, performance baseline, and source-defined terminal condition; its end time is not known in advance.
_Avoid_: Livestream, fixed-duration round, market

**Participant Rating**:
A versioned estimate of a Participant's competitive record, maintained as an Overall Rating and a rating for each Competition Template, and independent of Competition Market activity.
_Avoid_: Implied Probability, popularity score, earnings rank

**Rating Policy**:
The published, versioned rule that converts final rated Live Competition results and Season transitions into Participant Rating changes.
_Avoid_: Market pricing rule, popularity algorithm, changeable ladder formula

**Season**:
A 30-day interval for comparing Participant Ratings while preserving permanent career history across intervals.
_Avoid_: Tournament, Live Session, market cycle

**Competition Metric**:
The versioned, published rule that converts Performance Records into comparable Official Scores and ranks the two Participants.
_Avoid_: Changeable score, hidden formula, audience vote

**Official Score**:
The normalized value produced for one Participant by the frozen Competition Metric after the Official Result Source reports the Live Session's terminal condition.
_Avoid_: Market price, popularity, self-reported score

**Winner**:
The Participant with the higher final Official Score; a Live Competition may have two Winners when its scores are exactly tied.
_Avoid_: Winning wallet, selected creator, favored outcome

**Linked Competition Account**:
A Participant-controlled identity or account boundary through which a Competition Source attributes the actions used to build a Performance Record.
_Avoid_: Platform account, custodial account, audience wallet

**Competition Source**:
A supported provider of authoritative or independently verifiable performance facts for a Live Competition.
_Avoid_: Livestream, social post, participant claim

**Source Policy**:
The versioned, published rule defining which source facts, timestamps, identities, and validation states form a Performance Record.
_Avoid_: Connector configuration, hidden filter, custom scoring

**Performance Record**:
The verified facts gathered for one Participant during one Live Session and used to calculate an Official Score.
_Avoid_: Self-reported score, screenshot, raw private payload

**Performance Recovery Window**:
The period after a Live Session ends during which missing source facts may be reconstructed before its Competition Market becomes Invalid.
_Avoid_: Forecasting Window, Challenge Window, start delay

## Live Room operations

**Live Room**:
The persistent surface for one Live Session that carries its Livestream, Participants, Official Scores, source status, and Room Program. It is where the audience watches and forecasts, and it holds no authority over any result.
_Avoid_: Livestream, Competition Market, chat channel, lobby

**Room Program**:
The ordered, versioned set of Market Slots published for one Live Room, beginning with the mandatory headline slot on the whole Live Competition.
_Avoid_: Schedule, playlist, market list, bet menu

**Market Slot**:
One position in a Room Program that materializes into exactly one independent Competition Market with its own FPMM, LP Shares, fees, epochs, and Resolution.
_Avoid_: Round, sub-bet, side market, shared pool

**Question Template**:
An approved, versioned, parameterized question type with a frozen Opening Condition, Closing Condition, outcome shape, tie rule, and Winner Reward setting. It sits inside a Competition Template, which governs the Live Competition itself.
_Avoid_: Competition Template, editable question, creator prompt

**Opening Condition**:
The frozen rule that makes a Market Slot's Forecasting Window available.
_Avoid_: Start time, operator toggle, scheduled open

**Closing Condition**:
The frozen predicate over the Session Event Log whose satisfaction is one Competition Market's Decisive Event. The Live Session's terminal condition is the Closing Condition of its headline slot.
_Avoid_: Countdown, cutoff time, host decision

**Announce Delay**:
The frozen minimum interval between publishing a Market Slot and opening its Forecasting Window, so no question opens on facts the audience has not yet seen.
_Avoid_: Source Finality Delay, Challenge Window, warm-up

**Session Event Log**:
The append-only, monotonically sequenced, hash-chained, signed record of normalized Competition Source facts for one Live Session. It is the single ordering authority for every Competition Market in a Live Room and the only permitted input to condition evaluation.
_Avoid_: Activity feed, chat history, stream transcript, analytics stream

**Source Connector**:
The security-critical service that normalizes one Competition Source's facts into the Session Event Log, retaining and hashing the raw provider payload and the query that produced it with every event, and signing the log with its own key. Unlike the Live Room Coordinator, a compromised Source Connector can harm a market, which is why the Resolver Set reconstructs results without trusting it.
_Avoid_: Live Room Coordinator, oracle, result authority, analytics collector

**Source Gate Authority**:
The isolated service that evaluates frozen conditions over the Session Event Log, holds the Market Gate role for every Competition Market in a Live Room, and signs Publication Permits. It decides epoch safety, suspension, Decisive Event closure, and whether a proposed question is still open, and nothing else.
_Avoid_: Live Room Coordinator, admin pause, oracle, result authority

**Publication Permit**:
A fresh, single-use, expiring EIP-712 attestation signed by the Source Gate Authority that one exact question's Closing Condition was undecided through a named source sequence. `publishSlot` requires it alongside the Program Publisher's role, so no single compromised key can open a question whose answer is already known.
_Avoid_: Safe Event Watermark, market approval, admin signature

**Program Publisher**:
The isolated signer that instantiates approved Question Templates as Competition Markets through the room's `LiveRoom` contract. It chooses which question and when, but cannot publish without a Publication Permit and cannot decide whether a question is still open.
_Avoid_: Market creator account, host, Source Gate Authority

**Live Room Coordinator**:
The non-custodial service that composes Live Room state, sequences the Room Program, and delivers real-time updates. It holds no market key and cannot clear a Forecasting Epoch, close a market, select a Winner, or move Collateral.
_Avoid_: Matching engine, exchange backend, oracle, market administrator

**Room Snapshot**:
The complete published state of a Live Room at one Room Sequence, from which a client can rebuild identical state after any disconnection.
_Avoid_: Cached page, market summary, price feed

**Room Sequence**:
The gap-free monotonic counter for a Live Room's published state changes, distinct from the source sequence that orders the Session Event Log.
_Avoid_: Source sequence, block number, epoch number

**Liquidity Commitment**:
A signed, cancellable EIP-712 policy in which a Liquidity Provider pre-authorizes bounded per-slot liquidity for future Market Slots matching approved Question Templates. Anyone may execute it when a matching slot is published; the USDC enters only that slot's own FPMM, and the LP receives that slot's LP Position. It automates the decision, never pools the capital.
_Avoid_: Shared liquidity vault, cross-market pool, standing order book, yield product

**Stream Health**:
The separately reported availability of the Livestream, published as live, degraded, or unavailable. It is never an input to the Market Gate and is never merged with source freshness or connection state.
_Avoid_: Market status, source freshness, uptime

## Prediction market

**Competition Market**:
A binary prediction market whose mutually exclusive outcomes correspond to the two Participants in one Live Session.
_Avoid_: Winner Market, bet, wager, poll

**Livestream Event Market**:
A binary prediction market whose mutually exclusive outcomes describe one frozen Livestream Event and whose evidence comes from a complete Canonical Stream Recording rather than Participant performance accounts.
_Avoid_: Subjective creator question, audience vote, highlight-clip market

**Outcome Position**:
A collateral-backed claim associated with one possible Competition Market outcome.
_Avoid_: Bet, ticket, vote

**Implied Probability**:
The market price of an Outcome Position expressed as the market's current probability estimate.
_Avoid_: Odds, Official Score, win guarantee

**Reference Probability**:
The non-executable template value used to initialize the first backed FPMM reserves before price discovery begins.
_Avoid_: Implied Probability, virtual price, guaranteed probability

**Awaiting Liquidity**:
The post-readiness state in which a Competition Market's FPMM has no backed reserves. The first valid eligible LP deposit ends this state and makes AMM execution available; the Live Competition does not wait for a liquidity threshold.
_Avoid_: Funding stage, crowdfunding campaign, executable reference price

**Forecasting Window**:
The period after Participant readiness and before Forecasting Close during which the Market Gate may accept Forecaster and liquidity actions into pending Forecasting Epochs.
_Avoid_: Betting period, post-result market, settlement period

**Market Gate**:
The source-driven state that is Open, Suspended, or Closed for Forecaster trades, Outcome Position transfers, and liquidity additions.
_Avoid_: Frontend toggle, administrator pause, scheduled cutoff

**Forecasting Epoch**:
A short interval that collects pending market actions and executes them only after the Official Result Source clears the interval as safe.
_Avoid_: Instant trade, settlement period, Live Session

**Safe Event Watermark**:
A signed, monotonic source statement issued after the Source Finality Delay that no Decisive Event occurred through a specified source sequence and time, allowing the corresponding Forecasting Epoch to settle.
_Avoid_: Price quote, Livestream timestamp, result

**Source Finality Delay**:
The frozen minimum delay before a Safe Event Watermark may clear a Forecasting Epoch, allowing the Official Result Source time to ingest and stabilize late event facts.
_Avoid_: Blockchain finality, Challenge Window, stream delay

**Decisive Event**:
The objectively verifiable source fact that satisfies a Competition Template's terminal condition and determines that its Live Session has ended.
_Avoid_: Stream reaction, commentator call, market-price movement

**Forecasting Close**:
The irreversible event-driven transition that follows a Decisive Event and prevents any uncleared or later market action from executing.
_Avoid_: Scheduled cutoff, flexible pause, Live Session start

**Collateral**:
The native USDC committed to back Outcome Positions and their eventual Redemption value.
_Avoid_: Participant stake, platform balance, house funds

**USDC Gas Charge**:
A separately quoted and user-capped USDC reimbursement for the actual POL network gas a Market Paymaster pays on a user's behalf.
_Avoid_: Protocol trading fee, hidden deduction, free gas

**Community-Funded FPMM**:
A Competition Market's fixed-product pool whose real reserves come entirely from eligible Liquidity Providers rather than Protocol Operator capital.
_Avoid_: Virtual liquidity, protocol-seeded pool, house bankroll

**Liquidity Provision Period**:
The period after Participant readiness and before Forecasting Close during which the Market Gate may accept eligible liquidity additions into Forecasting Epochs. Every cleared deposit remains locked through Resolution or invalidation.
_Avoid_: Forecasting Window, withdrawal period, protocol funding round

**LP Share**:
A non-transferable claim representing one Liquidity Provider's proportional ownership of a Competition Market's resolved AMM inventory and Liquidity Fees, including the same proportion of any loss.
_Avoid_: Guaranteed principal, Outcome Position, Winner Reward

**LP Adjustment Position**:
Outcome inventory attached to a later LP deposit so the deposit preserves the current Implied Probability and enters without transferring existing pool value.
_Avoid_: Forecaster purchase, bonus position, free reward

**LP Position**:
The user-facing bundle of one provider's LP Share, any LP Adjustment Position, and Liquidity Fees earned after entry.
_Avoid_: Outcome Position, guaranteed-yield account, platform balance

**Winner Reward Pool**:
The whole-market escrow funded by the 1% Winner Reward Fee on purchases of either outcome. It is paid to the final Winner or tied Winners, or returned to original fee payers when the Competition Market is Invalid.
_Avoid_: Selected-side support payment, guaranteed appearance fee, Outcome Position backing

**Liquidity Fee**:
The separate 0.3% fee charged on every AMM purchase and sale and accrued proportionally to the LP Share holders present when the trade executes.
_Avoid_: Winner Reward Fee, Protocol Operator fee, USDC Gas Charge

## Integrity and resolution

**Integrity Bond**:
A Participant's commitment held separately from Competition Market Collateral and returnable after ordinary settlement unless an objectively proven, pre-published integrity violation is upheld.
_Avoid_: Entry fee, wager, subjective penalty

**Integrity Claim**:
A timely request to adjudicate an Integrity Bond using a published objective violation code and reviewable evidence; it cannot select the Winner or change Forecaster settlement.
_Avoid_: Resolution Challenge, cheating accusation, admin penalty

**Prohibited Market Interest**:
Any direct or indirect beneficial exposure held by a Participant, production insider, or disclosed related party in the Competition Market connected to their Live Competition.
_Avoid_: Self-bet, opponent hedge, undisclosed wallet position

**Official Result Source**:
The authoritative source that supplies or verifies the facts needed to calculate Official Scores and determine the Winner under the published rules.
For a Livestream Event Market, this is the complete, hashed Canonical Stream Recording and its frozen Observation Window—not the live player or an isolated clip.
_Avoid_: Live player, house decision, participant announcement, isolated highlight

**Canonical Stream Recording**:
The complete archived MP4 for one frozen Observation Window, retained with the exact official stream URL, absolute timestamps, a content hash, and a focused review window. Resolvers inspect the complete interval; the focused window is only wayfinding.
_Avoid_: Livestream embed, mutable VOD link, winning-moment clip

**Evidence Bundle**:
The privacy-safe record of inputs, calculations, source provenance, timestamps, and integrity hashes supporting a Provisional Result.
_Avoid_: Raw account dump, private credential export, screenshot

**Provisional Result**:
The proposed Winner, tied Winners, or invalid outcome calculated from completed Performance Records but not yet eligible for Redemption.
_Avoid_: Final result, Resolution, streamer announcement

**Challenge Window**:
The published period after a Provisional Result during which it may be disputed before final Resolution.
_Avoid_: Performance Recovery Window, settlement delay

**Resolution Challenge**:
A bonded, evidence-backed claim made during the Challenge Window that a Provisional Result violates an objective rule frozen for the Live Session.
_Avoid_: Complaint, vote, subjective appeal

**Resolver Set**:
The versioned Resolver Set frozen for one Competition Market before it opens. The roles are named Primary Resolver, Independent Verifier and Recovery Resolver by convention and by deployment practice; the contract itself grants all three the same `RESOLVER_ROLE` and treats any two distinct holders as a quorum (see ADR 0006's 2026-08-23 amendment).
_Avoid_: Admin keys, mutable signer list

**Resolution**:
The final determination that a Competition Market has a Winner, tied Winners, or is Invalid.
_Avoid_: Livestream result announcement, provisional score

**Redemption**:
The exchange of a resolved Outcome Position for its share of Collateral.
_Avoid_: Withdrawal, cash-out, prize

**Invalid Market**:
A Competition Market that cannot be resolved reliably under its published rules and therefore returns Collateral without selecting a Winner for market settlement.
_Avoid_: Cancelled bet, participant disqualification, default win
