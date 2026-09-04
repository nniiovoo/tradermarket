// Settlement history and replay (issue 11). Turns the protocol's integrity
// work into something a person can read: the frozen question and its Closing
// Condition, the source events that decided it, the evaluator version and
// condition hash, the Decisive Event, cleared and refunded epochs, the
// Evidence Bundle, resolver quorum, any challenge, the payout vector, and the
// claim transactions — each linked to chain.
//
// The replay is not a retelling: rerunning the archived evaluator over the
// archived log must reproduce the recorded result.

import {
  evaluateCondition,
  rectify,
  undecidedAtSessionEnd,
  EVALUATOR_VERSION,
  conditionHash,
} from "../domain/conditions.mjs";

const OUTCOME_LABEL = { 0: "unset", 1: "outcome_a", 2: "outcome_b", 3: "tie", 4: "invalid" };

const INVALIDATION_REASONS = {
  no_quorum: "Two resolvers never attested to the same result before the deadline, so the market failed closed rather than guessing.",
  challenge_upheld: "A bonded challenge was upheld: the provisional result violated a rule frozen before the session.",
  challenge_unreviewed: "A challenge went unreviewed past its timeout, so the market failed closed.",
  challenge_filed:
    "A bonded challenge was filed against the provisional result. Whether it was upheld is on chain but not in this build's index, so it is not stated here — the collateral is returned either way.",
  unrecoverable_source: "The source facts needed to score this question could not be verified, so no result could be published.",
  resolver_divergence: "Independent resolver reconstructions disagreed with the recorded log, so no result could be trusted.",
  persistent_skip: "The room could not execute this market's gating calls, so it refunded rather than settling on an unverified state.",
  unknown:
    "This market resolved Invalid. The specific reason is not recorded on chain, so it is not stated here rather than guessed — the collateral is returned either way.",
};

/**
 * Why a market was invalidated, when that is knowable.
 *
 * Hardcoding `no_quorum` blamed the resolvers for every Invalid market — a
 * persistent skip, a stalled gate, an unreviewed challenge — and did so in the
 * same document that showed a reached quorum. What the projections do prove:
 * repeated skips on this market, an unreviewed challenge, or resolvers who
 * never converged. Anything else is unknown, and says so.
 */
function invalidationReason({ store, market, attestations, quorum, challenge }) {
  if (challenge?.unreviewed) return "challenge_unreviewed";
  if (challenge?.upheld) return "challenge_upheld";
  // A challenge whose verdict is not (yet) attested. Naming it beats "unknown",
  // which told a holder the chain does not record why — when it does, and this
  // process has the challenger.
  if (challenge && challenge.upheld === null) return "challenge_filed";
  if (store.listSkips(market).length >= 2) return "persistent_skip";
  if (attestations.length > 0 && !quorum) return "no_quorum";
  if (attestations.length === 0) return "no_quorum";
  return "unknown";
}

/**
 * Whether two resolvers independently reached the same reconstruction.
 *
 * The chain's rule is `resultAttestationCount[keccak256(outcome, evidenceHash)]
 * == 2` — two resolvers on the *same* result. Counting attestation rows instead
 * reports a reached quorum for two resolvers who disagreed, on a market that
 * finalized Invalid precisely because they did; the same record would then say
 * quorum was reached and, in its invalidation reason, that it never was. The
 * chain dedups per resolver per (outcome, evidenceHash), so one resolver can
 * legitimately emit two events and must still count once.
 */
function reachedQuorum(attestations) {
  const byResult = new Map();
  for (const entry of attestations) {
    const key = `${entry.outcome}:${String(entry.evidence_hash ?? "").toLowerCase()}`;
    const resolvers = byResult.get(key) ?? new Set();
    resolvers.add(String(entry.resolver ?? "").toLowerCase());
    byResult.set(key, resolvers);
  }
  for (const resolvers of byResult.values()) {
    if (resolvers.size >= 2) return true;
  }
  // A curated record may carry only the on-chain running count.
  return attestations.some((entry) => Number(entry.count ?? 0) >= 2);
}

export class SettlementService {
  /**
   * @param options.store      ProjectionStore
   * @param options.eventLog   EventStore (Session Event Log)
   * @param options.conditions Map market -> condition document
   * @param options.playback   PlaybackService (timecode mapping) or null
   * @param options.participantKeys { a, b } — which source participant key is
   *        Outcome A and which is Outcome B. This is Competition Template
   *        configuration, not chain data: the contract knows addresses, while
   *        the Session Event Log knows linked-account keys.
   * @param options.chainRefs  Map market -> { closeTx, finalizeTx, attestations: [], challenge, claims: [] }
   */
  constructor({
    store,
    eventLog,
    eventLogForRoom = null,
    conditionForMarket = null,
    conditions,
    participantKeys,
    playback = null,
    chainRefs = new Map(),
  }) {
    if (!participantKeys?.a || !participantKeys?.b) {
      throw new Error("participantKeys {a, b} is required to map an outcome to a payout vector");
    }
    this.participantKeys = participantKeys;
    this.store = store;
    this.eventLog = eventLog;
    this.eventLogForRoom = eventLogForRoom;
    this.conditionForMarket = conditionForMarket;
    this.conditions = conditions;
    this.playback = playback;
    this.chainRefs = chainRefs;
  }

  async _eventsFor(roomId) {
    return (this.eventLogForRoom?.(roomId) ?? this.eventLog).all();
  }

  async _conditionFor(market, roomId, expectedHash = null) {
    return (
      (await this.conditionForMarket?.(market, roomId, expectedHash)) ??
      this.conditions.get(market) ??
      this.conditions.get(String(market).toLowerCase()) ??
      null
    );
  }

  /** Resolver attestations for one market, straight from the projections. */
  /**
   * The challenge, from what the chain actually emitted.
   *
   * `upheld` is null until two resolvers have attested a verdict: a filed
   * challenge and an upheld one are different facts, and a holder reading why
   * their position redeemed at half is owed the difference rather than a guess
   * in either direction.
   */
  _indexedChallenge(market, marketRow) {
    if (!marketRow?.challenger) return null;
    const verdicts = this.store.listChallengeVerdicts?.(market) ?? [];
    const accepting = new Set();
    const rejecting = new Set();
    for (const verdict of verdicts) {
      const resolver = String(verdict.resolver ?? "").toLowerCase();
      (verdict.accept_challenge ? accepting : rejecting).add(resolver);
    }
    const upheld = accepting.size >= 2 ? true : rejecting.size >= 2 ? false : null;
    return {
      challenger: marketRow.challenger,
      evidence_hash: marketRow.challenge_evidence_hash ?? null,
      upheld,
      unreviewed: null,
      verdicts: verdicts.map((verdict) => ({
        resolver: verdict.resolver,
        accept_challenge: Boolean(verdict.accept_challenge),
        block_number: Number(verdict.block_number ?? 0),
      })),
    };
  }

  _indexedAttestations(market) {
    return this.store
      .listAttestations(market)
      .map((row) => ({
        resolver: row.resolver,
        outcome: Number(row.outcome ?? 0),
        evidence_hash: row.evidence_hash ?? null,
        count: Number(row.count ?? 0),
        block_number: Number(row.block_number ?? 0),
      }))
      .sort((a, b) => a.block_number - b.block_number || a.count - b.count);
  }

  /** The full settlement record for one market, or null. */
  async record(market) {
    const marketRow = this.store.getMarket(market);
    if (!marketRow) return null;
    const slot = this.store.slotByMarket(market);
    const condition = await this._conditionFor(market, marketRow.room_id, slot?.condition_hash ?? null);
    const refs = this.chainRefs.get(market) ?? {};
    const room = this.store.getRoom(marketRow.room_id);

    const terminalSeq = room?.closed_source_seq ? Number(room.closed_source_seq) : null;
    const events = await this._eventsFor(marketRow.room_id);
    const decision = condition
      ? evaluateCondition(condition, events, { terminalSeq, headlineCondition: this._headlineCondition() })
      : null;

    const decidingEvents = this._decidingEvents(decision, events);
    const outcome = Number(marketRow.final_outcome ?? 0);
    const attestations = refs.attestations ?? this._indexedAttestations(market);
    const participants = {
      a: marketRow.participant_a_name || null,
      b: marketRow.participant_b_name || null,
    };
    const winnerName = outcome === 1 ? participants.a : outcome === 2 ? participants.b : null;

    return {
      market,
      room_id: marketRow.room_id,
      slot_index: marketRow.slot_index,
      question: slot?.question ?? null,
      // Frozen from the child market's immutable initialization config. Null
      // means the indexer has not read a label; source keys are not display
      // names and must not be promoted into one by guesswork.
      participants,
      closing_condition: condition,
      condition_hash: condition ? conditionHash(condition) : slot?.condition_hash ?? null,
      evaluator_version: EVALUATOR_VERSION,
      decisive_event: decision?.status === "decided" ? { seq: decision.seq, outcome: decision.outcome } : null,
      deciding_events: decidingEvents,
      epochs: this._epochSummary(market),
      resolution: {
        outcome,
        outcome_label: OUTCOME_LABEL[outcome] ?? "unknown",
        winner_name: winnerName,
        payout_vector: this._payoutVector(outcome),
        // Quorum is a claim about what actually happened on chain, so it is
        // derived from the indexed ResultAttested events. Curated refs, when a
        // caller supplies them, still take precedence — but their absence must
        // never read as "the resolvers never agreed".
        attestations: attestations,
        quorum: reachedQuorum(attestations),
        // Same rule as quorum, one field down: a curated ref wins, but its
        // absence must never read as "nobody challenged this result". The
        // chain records the challenge and this process indexed it.
        challenge: refs.challenge ?? this._indexedChallenge(market, marketRow),
        provisional_at: marketRow.provisional_at ?? null,
        challenge_ends_at: marketRow.challenge_ends_at ?? null,
      },
      invalidation:
        outcome === 4
          ? (() => {
              const code =
                refs.invalidationReason ??
                invalidationReason({
                  store: this.store,
                  market,
                  attestations,
                  quorum: reachedQuorum(attestations),
                  // Same rule as quorum, one field down: a curated ref wins, but its
        // absence must never read as "nobody challenged this result". The
        // chain records the challenge and this process indexed it.
        challenge: refs.challenge ?? this._indexedChallenge(market, marketRow),
                });
              return { reason_code: code, explanation: INVALIDATION_REASONS[code] ?? INVALIDATION_REASONS.unknown };
            })()
          : null,
      chain: {
        close_tx: refs.closeTx ?? null,
        finalize_tx: refs.finalizeTx ?? null,
        claims: refs.claims ?? [],
        finalized_block: marketRow.finalized_block_number ?? null,
        block: marketRow.block_number,
      },
      replay: {
        stream_offset_s: this.playback && decision?.seq ? this.playback.offsetFor(decision.seq) : null,
        log_range: events.length > 0 ? { from: events[0].seq, to: events.at(-1).seq } : null,
      },
    };
  }

  /**
   * Reruns the archived evaluator over the archived log and compares with the
   * recorded outcome. This is the acceptance gate: a replay that does not
   * reproduce the result means the record cannot be trusted.
   */
  async verifyReplay(market) {
    const record = await this.record(market);
    if (!record || !record.closing_condition) return { ok: false, reason: "no condition document" };
    const room = this.store.getRoom(record.room_id);
    const terminalSeq = room?.closed_source_seq ? Number(room.closed_source_seq) : null;
    const decision = evaluateCondition(
      record.closing_condition,
      await this._eventsFor(record.room_id),
      { terminalSeq }
    );
    if (decision.status !== "decided") {
      return { ok: record.resolution.outcome === 4, reason: `replay ${decision.status}`, decision };
    }
    let expected;
    try {
      expected = this._enumFor(decision.outcome);
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    return {
      ok: expected === record.resolution.outcome,
      replayed: decision,
      expected_enum: expected,
      recorded_enum: record.resolution.outcome,
    };
  }

  _enumFor(outcome) {
    if (outcome === "yes") return 1;
    if (outcome === "no") return 2;
    if (outcome === "tie") return 3;
    if (outcome === this.participantKeys.a) return 1;
    if (outcome === this.participantKeys.b) return 2;
    throw new Error(`outcome ${outcome} is neither participant nor a known label`);
  }

  /**
   * The condition that ends the session.
   *
   * It identifies itself: the headline is the one template whose
   * undecided-at-session-end rule is null, because its decision IS the session's
   * end. Every other slot is bounded by it — a replay that bounds them by the
   * room's closing sequence instead can publish an outcome the market did not
   * pay, whenever that sequence sits past the terminal fill.
   */
  _headlineCondition() {
    for (const condition of this.conditions.values()) {
      if (undecidedAtSessionEnd(condition) === null) return condition;
    }
    return null;
  }

  _decidingEvents(decision, events) {
    if (!decision || decision.status !== "decided") return [];
    // Read from the rectified timeline, not the raw log. A fact the provider
    // restated appears in the log twice, and the result was reached on the
    // second one — publishing the first as the evidence for it, or omitting a
    // restatement that arrived after the decisive sequence, prints a figure
    // nobody settled on and calls it proof.
    return rectify(events)
      .filter((event) => event.seq <= decision.seq && event.kind !== "heartbeat")
      .slice(-5)
      .map((event) => ({
        seq: event.seq,
        kind: event.kind,
        participant: event.participant,
        observed_at: event.observed_at,
        facts: event.facts,
        corrected: Boolean(event.corrected_by),
        raw_ref: event.raw_ref,
        raw_hash: event.raw_hash,
        raw_query: event.raw_query,
        stream_offset_s: this.playback ? this.playback.offsetFor(event.seq) : null,
      }));
  }

  _epochSummary(market) {
    const actions = this.store.listActions(market);
    const byEpoch = new Map();
    for (const action of actions) {
      const entry = byEpoch.get(action.epoch) ?? { epoch: action.epoch, executed: 0, refunded: 0, pending: 0 };
      if (action.status === 1) entry.executed++;
      else if (action.status === 2) entry.refunded++;
      else entry.pending++;
      byEpoch.set(action.epoch, entry);
    }
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  }

  _payoutVector(outcome) {
    if (outcome === 1) return { a: "1", b: "0" };
    if (outcome === 2) return { a: "0", b: "1" };
    if (outcome === 3 || outcome === 4) return { a: "0.5", b: "0.5" };
    return null;
  }

  /** Claimable amounts for one account across the room's settled slots. */
  claimsFor(account) {
    const claims = [];
    for (const holding of this.store.listAccountHoldings(account)) {
      const marketRow = this.store.getMarket(holding.market_address);
      if (!marketRow || Number(marketRow.final_outcome ?? 0) === 0) continue;
      const outcome = Number(marketRow.final_outcome);
      const vector = this._payoutVector(outcome);
      const positionA = BigInt(holding.position_a ?? 0n);
      const positionB = BigInt(holding.position_b ?? 0n);
      const lpShares = BigInt(holding.lp_shares ?? 0n);
      // What redeeming would actually pay. A holding that survives settlement
      // is not evidence of money waiting: the losing side redeems for zero, so
      // nobody bothers, and the holding stays on chain forever.
      const redeemable =
        outcome === 3 || outcome === 4
          ? (positionA + positionB) / 2n
          : outcome === 1
            ? positionA
            : outcome === 2
              ? positionB
              : 0n;
      claims.push({
        market: holding.market_address,
        outcome_label: OUTCOME_LABEL[outcome],
        position_a: positionA.toString(),
        position_b: positionB.toString(),
        lp_shares: lpShares.toString(),
        redeemable_value: redeemable.toString(),
        // LP inventory is a separate claim with its own maths, so
        // `redeemable_value` — which is about positions — must not be read as
        // "this LP position is worth nothing".
        lp_inventory_note:
          lpShares > 0n
            ? "LP inventory settles separately through settleLpInventory, and liquidity fees separately again."
            : null,
        claimable: redeemable > 0n || lpShares > 0n,
        payout_vector: vector,
      });
    }
    return claims;
  }
}
