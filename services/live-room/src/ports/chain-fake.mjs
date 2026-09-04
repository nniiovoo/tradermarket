// In-memory RoomChain port implementation, faithful to LiveRoom + market
// semantics that the Gate Authority depends on: non-decreasing room sequence,
// strictly-increasing per-market safe sequences, irreversible closes, and
// skipped-not-reverted child failures.

export class FakeRoomChain {
  constructor({ epochDuration = 10, sourceFinalityDelay = 10 } = {}) {
    this.epochDuration = epochDuration;
    this.sourceFinalityDelay = sourceFinalityDelay;
    this.lastObserved = 0;
    this.roomClosed = 0;
    this.slots = []; // { market, slotIndex, conditionHash, closed, suspended, lastSafeSeq, safeEpochs:Set, processedEpochs:[] }
    this.calls = [];
    this.skips = [];
    // Publication state. A nonce is consumed by the same call that deploys the
    // market, so "was this nonce used" answers "did my publication land".
    this.usedNonces = new Set();
    this.published = [];
  }

  addSlot(market, slotIndex, conditionHash) {
    this.slots.push({
      market,
      slotIndex,
      conditionHash,
      closed: false,
      suspended: false,
      lastSafeSeq: 0,
      safeEpochs: new Set(),
      processedEpochs: [],
      // Settlement timing, mirroring LivePredictionMarket's own state. The
      // defaults match contracts/script/CreateAmoyRoom.s.sol.
      provisionalOutcome: 0,
      provisionalAt: 0,
      challenged: false,
      challengedAt: 0,
      challengeWindow: 600,
      challengeTimeout: 1800,
      // Deliberately NOT initialised. `resolutionDueAtOf` defaults an unset
      // deadline to MAX_SAFE_INTEGER — "no deadline known", so nothing is
      // overdue — and setting it to 0 here made every market read as past its
      // resolution deadline, which stopped the resolver attesting anything.
      finalOutcome: 0,
    });
  }

  _slot(market) {
    const slot = this.slots.find((entry) => entry.market === market);
    if (!slot) throw new Error(`unknown market ${market}`);
    return slot;
  }

  _advance(seq) {
    if (this.roomClosed !== 0) throw new Error("RoomIsClosed");
    if (seq < this.lastObserved) throw new Error("SequenceRegression");
    this.lastObserved = seq;
  }

  async lastObservedSequence() {
    return this.lastObserved;
  }

  async roomClosedSequence() {
    return this.roomClosed;
  }

  async openSlots() {
    return this.slots.filter((slot) => !slot.closed).map(({ market, slotIndex, conditionHash }) => ({ market, slotIndex, conditionHash }));
  }

  async isEpochSafe(market, epoch) {
    return this._slot(market).safeEpochs.has(epoch);
  }

  /// Whether an epoch holds work worth a gate transaction. The fake has no
  /// action book, so it reports true and preserves the previous ordering.
  async hasPendingActions() {
    return true;
  }

  async gateStateOf(market) {
    const slot = this._slot(market);
    return slot.closed ? "closed" : slot.suspended ? "suspended" : "open";
  }

  async markRoomEpochsSafe(seq, markets, epochs) {
    this._advance(seq);
    this.calls.push(["markRoomEpochsSafe", seq, [...markets], [...epochs]]);
    markets.forEach((market, index) => {
      const slot = this._slot(market);
      const epoch = epochs[index];
      // Child semantics: strictly increasing per-market sequence, no re-mark, no post-close mark.
      if (slot.closed || slot.safeEpochs.has(epoch) || seq <= slot.lastSafeSeq) {
        this.skips.push([market, epoch, "child-revert"]);
        return;
      }
      slot.safeEpochs.add(epoch);
      slot.lastSafeSeq = seq;
    });
  }

  async suspendRoom(seq) {
    this._advance(seq);
    this.calls.push(["suspendRoom", seq]);
    for (const slot of this.slots) if (!slot.closed) slot.suspended = true;
  }

  async reopenRoom(seq) {
    this._advance(seq);
    this.calls.push(["reopenRoom", seq]);
    for (const slot of this.slots) if (!slot.closed) slot.suspended = false;
  }

  async closeSlots(seq, markets) {
    this._advance(seq);
    this.calls.push(["closeSlots", seq, [...markets]]);
    for (const market of markets) this._closeOne(market, seq);
  }

  async closeRoom(seq) {
    this._advance(seq);
    this.calls.push(["closeRoom", seq]);
    this.roomClosed = seq;
  }

  async closeRemainingSlots(markets) {
    if (this.roomClosed === 0) throw new Error("RoomNotClosed");
    this.calls.push(["closeRemainingSlots", [...markets]]);
    for (const market of markets) this._closeOne(market, this.roomClosed);
  }

  /**
   * Child semantics for `closeForDecisiveEvent`: the market requires a sequence
   * strictly ahead of its own safe watermark and reverts otherwise, which the
   * room swallows as a skip. A fake that closed anyway would let a market that
   * the real contract leaves open pass as closed.
   */
  _closeOne(market, seq) {
    const slot = this._slot(market);
    if (slot.closed || seq <= slot.lastSafeSeq) {
      this.skips.push([market, 0, "child-revert"]);
      return;
    }
    slot.closed = true;
    slot.decisiveSeq = seq;
  }

  async processRoom(markets, epochs, maxActions) {
    this.calls.push(["processRoom", [...markets], [...epochs], maxActions]);
    markets.forEach((market, index) => {
      const slot = this._slot(market);
      const epoch = epochs[index];
      slot.processedEpochs.push(epoch);
      // Advance the cursor exactly as the contract does — up to `maxActions`
      // of what the epoch holds — so a caller that must decide "is there work
      // left" gets the same answer here as on chain.
      const total = slot.epochActions?.get(epoch) ?? 0;
      if (total === 0) return;
      slot.epochCursor = slot.epochCursor ?? new Map();
      const cursor = slot.epochCursor.get(epoch) ?? 0;
      slot.epochCursor.set(epoch, Math.min(total, cursor + Number(maxActions ?? total)));
    });
  }

  // ----------------------------------------------------------- publication
  //
  // Publication semantics the publisher depends on: the caller must hold the
  // publisher role, a permit nonce is single-use, and the nonce is consumed in
  // the same call that deploys the market — which is what makes a consumed
  // nonce a reliable answer to "did my publication land".

  async publishSlot(request, permit, _signature, restricted = []) {
    if (this.roomClosed !== 0) throw new Error("RoomIsClosed");
    if (this.usedNonces.has(String(permit.nonce))) throw new Error("PermitReplayed");
    this.usedNonces.add(String(permit.nonce));
    this.lastObserved = Number(permit.undecidedThroughSequence);
    const slotIndex = this.slots.length;
    const market = `0x${(slotIndex + 1).toString(16).padStart(40, "0")}`;
    this.addSlot(market, slotIndex, request.conditionHash ?? permit.conditionHash);
    this.published.push({ market, slotIndex, request, permit, restricted: [...restricted] });
    this.calls.push(["publishSlot", slotIndex, market]);
    return market;
  }

  async usedNonce(nonce) {
    return this.usedNonces.has(String(nonce));
  }

  async slotCount() {
    return this.slots.length;
  }

  /// The addresses the room recognises. Settable, because the interesting case
  /// is an operator holding a key the room does not know.
  async publisherAddress() {
    return this.publisherOf ?? null;
  }

  async gateSigner() {
    return this.gateSignerOf ?? null;
  }

  async marketForConditionHash(hash) {
    const slot = this.slots.find((entry) => entry.conditionHash === hash);
    return slot ? slot.market : null;
  }

  // ----------------------------------------------------------- resolution

  async finalOutcomeOf(market) {
    return this._slot(market).finalOutcome ?? 0;
  }

  async resolutionDueAtOf(market) {
    return this._slot(market).resolutionDueAt ?? Number.MAX_SAFE_INTEGER;
  }

  async conditionHashOf(market) {
    return this._slot(market).conditionHash;
  }

  /// Slot 0 is the headline by construction: the room refuses any other
  /// template there, and every other slot's condition is evaluated against it.
  async headlineMarket() {
    return this.slots.find((slot) => slot.slotIndex === 0)?.market ?? null;
  }

  /// Markets whose forecasting has closed and which nobody has finalized.
  async closedSlots() {
    const closed = [];
    for (const slot of this.slots) {
      if (!slot.closed) continue;
      if ((slot.finalOutcome ?? 0) !== 0) continue;
      closed.push({ market: slot.market, slotIndex: slot.slotIndex, conditionHash: slot.conditionHash });
    }
    return closed;
  }

  async attestResult(market, outcomeEnum, evidenceHash) {
    const slot = this._slot(market);
    if (!slot.closed) throw new Error("InvalidState");
    slot.attestations = slot.attestations ?? [];
    slot.attestations.push({ outcomeEnum, evidenceHash });
    this.calls.push(["attestResult", market, outcomeEnum, evidenceHash]);
    return { market, outcomeEnum, evidenceHash };
  }

  /** Test helper: put a market into the bonded-challenge state. */
  challenge(market, { evidenceHash = "0xcounter", provisionalOutcome = 1 } = {}) {
    const slot = this._slot(market);
    slot.challenged = true;
    slot.challengeEvidenceHash = evidenceHash;
    slot.provisionalOutcome = provisionalOutcome;
  }

  async challengeStateOf(market) {
    const slot = this._slot(market);
    return {
      challenged: Boolean(slot.challenged),
      evidenceHash: slot.challengeEvidenceHash ?? null,
      provisionalOutcome: Number(slot.provisionalOutcome ?? 0),
      finalOutcome: Number(slot.finalOutcome ?? 0),
    };
  }

  async attestChallengeVerdict(market, acceptChallenge) {
    const slot = this._slot(market);
    if (!slot.challenged) throw new Error("InvalidState");
    slot.challengeVerdicts = slot.challengeVerdicts ?? [];
    slot.challengeVerdicts.push(acceptChallenge);
    this.calls.push(["attestChallengeVerdict", market, acceptChallenge]);
    return { market, acceptChallenge };
  }

  // ------------------------------------------------------ refund-on-close
  //
  // Faithful to the contract's own bookkeeping: `_epochActionIds` grows and
  // never shrinks, and progress lives in a separate `epochCursor`. A fake that
  // modelled "processed" by emptying the list would hide the bug this exists to
  // prevent — a drain predicate of `length > 0` looks correct against such a
  // fake and re-sends forever against a real chain.

  /** Test helper: a Forecaster submits an action into an epoch. */
  submitAction(market, epoch) {
    const slot = this._slot(market);
    slot.epochActions = slot.epochActions ?? new Map();
    slot.epochActions.set(epoch, (slot.epochActions.get(epoch) ?? 0) + 1);
    slot.epochCursor = slot.epochCursor ?? new Map();
    if (!slot.epochCursor.has(epoch)) slot.epochCursor.set(epoch, 0);
  }

  /** Test helper: the epoch the market was closed in. */
  setClosedEpoch(market, epoch) {
    this._slot(market).closedEpoch = Number(epoch);
  }

  /** Test helper: the room-wide wall-clock epoch. */
  setCurrentEpoch(epoch) {
    this.currentEpochValue = Number(epoch);
  }

  async refundWindowOf(market) {
    const slot = this._slot(market);
    return {
      closedEpoch: Number(slot.closedEpoch ?? 0),
      currentEpoch: Number(this.currentEpochValue ?? slot.closedEpoch ?? 0),
    };
  }

  async unprocessedActions(market, epoch) {
    const slot = this._slot(market);
    const total = slot.epochActions?.get(epoch) ?? 0;
    const cursor = slot.epochCursor?.get(epoch) ?? 0;
    return cursor < total;
  }

  // --------------------------------------------------------- settlement
  //
  // The three permissionless finalization calls, and the state a keeper reads
  // to decide which of them is currently legal. Faithful to
  // LivePredictionMarket:772-793 including the reverts: a fake that accepted a
  // call the contract would refuse would let a keeper bug pass this suite and
  // fail against a real chain, which is the one thing a fake must never do.

  /** Test helper: set the frozen per-market windows. */
  setSettlementTiming(market, { challengeWindow, challengeTimeout } = {}) {
    const slot = this._slot(market);
    if (challengeWindow !== undefined) slot.challengeWindow = Number(challengeWindow);
    if (challengeTimeout !== undefined) slot.challengeTimeout = Number(challengeTimeout);
  }

  /** Test helper: the state after two resolvers reached quorum. */
  registerProvisional(market, { outcome, atS }) {
    const slot = this._slot(market);
    slot.provisionalOutcome = Number(outcome);
    slot.provisionalAt = Number(atS);
  }

  /** Test helper: when the bonded challenge was raised. */
  setChallengedAt(market, atS) {
    this._slot(market).challengedAt = Number(atS);
  }

  /** Test helper: the contract's hardcoded 30-minute deadline, as a value. */
  setResolutionDueAt(market, atS) {
    this._slot(market).resolutionDueAt = Number(atS);
  }

  /** Test helper: make the next write to one market revert, as a chain would. */
  failNextWrite(market, message) {
    this._failures = this._failures ?? new Map();
    this._failures.set(market, message);
  }

  _maybeFail(market) {
    const message = this._failures?.get(market);
    if (!message) return;
    this._failures.delete(market);
    throw new Error(message);
  }

  async settlementStateOf(market) {
    const slot = this._slot(market);
    return {
      gateState: slot.closed ? "closed" : slot.suspended ? "suspended" : "open",
      provisionalOutcome: Number(slot.provisionalOutcome ?? 0),
      finalOutcome: Number(slot.finalOutcome ?? 0),
      challenged: Boolean(slot.challenged),
      provisionalAt: Number(slot.provisionalAt ?? 0),
      challengedAt: Number(slot.challengedAt ?? 0),
      challengeWindow: Number(slot.challengeWindow ?? 0),
      challengeTimeout: Number(slot.challengeTimeout ?? 0),
      resolutionDueAt: Number(slot.resolutionDueAt ?? 0),
    };
  }

  async finalizeUnchallenged(market, nowS) {
    const slot = this._slot(market);
    this._maybeFail(market);
    if (
      slot.provisionalOutcome === 0
      || slot.finalOutcome !== 0
      || slot.challenged
      || Number(nowS) < slot.provisionalAt + slot.challengeWindow
    ) {
      throw new Error("TooEarly");
    }
    slot.finalOutcome = slot.provisionalOutcome;
    this.calls.push(["finalizeUnchallenged", market]);
    return { market, finalOutcome: slot.finalOutcome };
  }

  async expireChallenge(market, nowS) {
    const slot = this._slot(market);
    this._maybeFail(market);
    if (!slot.challenged || slot.finalOutcome !== 0 || Number(nowS) < slot.challengedAt + slot.challengeTimeout) {
      throw new Error("TooEarly");
    }
    // Invalid, and the challenger's bond goes back — an unanswered challenge is
    // not a lost one.
    slot.finalOutcome = 4;
    slot.challengeBondReturned = true;
    this.calls.push(["expireChallenge", market]);
    return { market, finalOutcome: 4 };
  }

  async invalidateUnresolved(market, nowS) {
    const slot = this._slot(market);
    this._maybeFail(market);
    // An unset deadline is never due. `nowS < undefined` is NaN-false, which
    // would have made a market with no deadline invalidatable immediately —
    // the opposite of what an unset value means.
    const dueAt = slot.resolutionDueAt ?? Number.MAX_SAFE_INTEGER;
    if (!slot.closed || slot.finalOutcome !== 0 || slot.provisionalOutcome !== 0 || Number(nowS) < dueAt) {
      throw new Error("TooEarly");
    }
    slot.finalOutcome = 4;
    this.calls.push(["invalidateUnresolved", market]);
    return { market, finalOutcome: 4 };
  }
}
