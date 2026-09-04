// Source Gate Authority (issue 05): the single-writer loop that evaluates
// frozen conditions over the Session Event Log and drives the LiveRoom gate,
// plus Publication Permit signing. Holds GATE_SIGNER_ROLE and nothing else.
//
// Safety rules enforced here, independently of the contract's own checks:
// - never mark an epoch safe past a sequence not fully evaluated for that market
// - never mark safe a market whose condition was satisfied at or before the
//   epoch's final sequence
// - never sign a non-increasing sequence, never sign after close
// - never sign a permit for a condition that is not `undecided`, and never
//   accept a hash it did not compute itself from the submitted document
// - prefer suspension to a guess
//
// Restart safety: the nonce counter, the audit log, and the unevaluable clock
// are persisted through an injected key-value store, and suspension is
// reconciled from CHAIN state rather than from memory. A restarted gate must
// never reissue a consumed nonce, must still reopen a room it suspended before
// the restart, and must not restart a grace period it had already begun.

import { evaluateCondition, conditionHash, EVALUATOR_VERSION } from "../domain/conditions.mjs";
import { freshnessAgeMs, canonicalize } from "../domain/eventlog.mjs";
import { keccak256, toHex } from "viem";
import { slotRequestHash } from "../domain/slotrequest.mjs";
import { assertQuestionMatches } from "../publisher/publisher.mjs";

export class GateAuthority {
  /**
   * @param options.roomAddress   LiveRoom clone address (EIP-712 verifyingContract)
   * @param options.chainId       chain id for the permit domain
   * @param options.chain         RoomChain port
   * @param options.store         EventStore port (the Session Event Log)
   * @param options.signer        viem local account holding GATE_SIGNER_ROLE
   * @param options.conditions    map market -> condition document (verified against on-chain hash)
   * @param options.config        { epochDurationS, sourceFinalityDelayS, freshnessThresholdMs,
   *                               maxPermitLifetimeS, headlineMarket, auditLog? }
   */
  constructor({ roomAddress, chainId, chain, store, signer, conditions, config, state = null, metrics = null, catalog = null }) {
    this.roomAddress = roomAddress;
    this.chainId = chainId;
    this.chain = chain;
    this.store = store;
    this.signer = signer;
    this.conditions = conditions;
    this.config = config;
    // The approved template catalogue, when the deployment supplies one. With
    // it the gate refuses a permit whose question text disagrees with the rule
    // that settles it; without it that check simply does not run.
    this.catalog = catalog;
    // Durable state. Without it the gate is restart-unsafe: nonces restart at
    // 1, the record of what was attested is lost, and a grace period resets.
    this.state = state;
    // Optional observability port. `Metrics` satisfies it; so does anything
    // with `observe(name, value)`. Optional on purpose: a gate that refused to
    // act because nobody was watching would trade a blind spot for an outage.
    this.metrics = metrics;
    // Loaded on first use rather than here: the store is async, and a
    // constructor cannot await. Defaults are what a gate with no durable state
    // legitimately starts from, so a gate that is constructed and never ticked
    // is in the same state either way.
    this._loaded = false;
    this.audit = [];
    this.nextNonce = 1;
    // market -> epoch millis when its condition first became unevaluable
    this.unevaluableSince = new Map();
    this.clearedEpochs = new Map(); // rebuilt from chain, never trusted from memory
  }

  async _load(key, fallback) {
    if (!this.state) return fallback;
    const value = await this.state.get(`gate.${key}`, null);
    return value === null || value === undefined ? fallback : value;
  }

  async _save(key, value) {
    if (this.state) await this.state.set(`gate.${key}`, value);
  }

  /**
   * Restores durable state explicitly.
   *
   * Public because "has this gate resumed?" is a question callers legitimately
   * ask before the first tick — a restarted gate's audit and nonce are empty
   * until something loads them, and code that reads `gate.audit` straight after
   * construction would otherwise see an empty log and conclude the gate had
   * never signed anything.
   */
  async load() {
    return this._ensureLoaded();
  }

  /**
   * Reads durable state once, before the gate does anything that depends on it.
   *
   * A restart that ticked before loading would sign from nonce 1 again — the
   * room rejects a reused nonce, so the symptom is a gate that cannot publish
   * and gives no reason. Every entry point calls this first.
   */
  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    this.audit = await this._load("audit", []);
    this.nextNonce = await this._load("nextNonce", 1);
    this.unevaluableSince = new Map(Object.entries(await this._load("unevaluableSince", {})));
  }

  /** Everything a restart needs, and what the runbook inspects. */
  async durableState() {
    await this._ensureLoaded();
    return {
      nextNonce: this.nextNonce,
      audit: this.audit,
      unevaluableSince: Object.fromEntries(this.unevaluableSince),
    };
  }

  async _log(entry) {
    this.audit.push({ at: new Date().toISOString(), evaluator: EVALUATOR_VERSION, ...entry });
    await this._save("audit", this.audit);
  }

  /** Suspension is a CHAIN fact, not a memory flag: a restarted gate must be
   *  able to reopen a room it suspended before it died, and must not
   *  re-suspend one that is already suspended. */
  async _isSuspendedOnChain() {
    if (typeof this.chain.isSuspended === "function") return this.chain.isSuspended();
    for (const slot of await this.chain.openSlots()) {
      if ((await this.chain.gateStateOf(slot.market)) === "suspended") return true;
    }
    return false;
  }

  /**
   * Whether every open slot is already frozen.
   *
   * "Is the room suspended" is answered — by the chain port and by the fallback
   * alike — with "is ANY slot suspended", which is the right question for
   * reopening and the wrong one for suspending. Short-circuiting on it meant
   * that once the first slot was frozen the gate stopped calling suspendRoom,
   * so a slot published while the outage was still running was never frozen at
   * all: it opened, and accepted orders, against a feed that had stopped.
   */
  async _everyOpenSlotSuspended() {
    const open = await this.chain.openSlots();
    if (open.length === 0) return await this._isSuspendedOnChain();
    for (const slot of open) {
      if (typeof this.chain.gateStateOf !== "function") break;
      if ((await this.chain.gateStateOf(slot.market)) !== "suspended") return false;
    }
    if (typeof this.chain.gateStateOf !== "function") return this._isSuspendedOnChain();
    return true;
  }

  async _suspend(reason) {
    if (await this._everyOpenSlotSuspended()) return false;
    const seq = await this._roomSequence(await this._tipSeq());
    await this._log({ action: "suspendRoom", reason, seq });
    await this.chain.suspendRoom(seq);
    return true;
  }

  async _reopen() {
    if (!(await this._isSuspendedOnChain())) return false;
    const seq = await this._roomSequence(await this._tipSeq());
    await this._log({ action: "reopenRoom", seq });
    await this.chain.reopenRoom(seq);
    return true;
  }

  /** Records when a market's condition first became unevaluable, durably.
   *  Returns how long it has been unevaluable, in milliseconds. */
  async _markUnevaluable(market, nowMs, reason) {
    if (!this.unevaluableSince.has(market)) {
      this.unevaluableSince.set(market, nowMs);
      await this._save("unevaluableSince", Object.fromEntries(this.unevaluableSince));
      await this._log({ action: "unevaluable", market, reason, since: nowMs });
    }
    return nowMs - this.unevaluableSince.get(market);
  }

  async _clearUnevaluable(market) {
    if (this.unevaluableSince.delete(market)) {
      await this._save("unevaluableSince", Object.fromEntries(this.unevaluableSince));
      await this._log({ action: "evaluable-again", market });
    }
  }

  /** The strongest safe statement: the tip sequence, with the log fully evaluated. */
  async _tipSeq() {
    const tip = await this.store.tip();
    return tip ? tip.seq : 0;
  }

  conditionFor(market) {
    const condition = this.conditions.get(market);
    if (!condition) throw new Error(`no condition document for ${market}`);
    return condition;
  }

  /**
   * A sequence the chain will accept for a close.
   *
   * The room refuses a sequence behind its watermark, and each market refuses
   * one that is not strictly ahead of its own — both correct, and both able to
   * strand a decided room. Two things push a decision behind the watermark: a
   * provider restating an earlier fill so the terminal condition turns out to
   * have been met sooner than anyone knew, and a decision landing on the same
   * sequence an epoch just cleared at.
   *
   * The chain gets a sequence it accepts. The audit keeps the sequence the
   * session actually ended at, which is the one that means anything.
   */
  /**
   * A sequence the room will accept for any gate action.
   *
   * The room's watermark only moves forward, and closing a slot pushes it one
   * past the sequence that decided it. When that sequence came from the log
   * tip, the watermark now EXCEEDS the tip — and every later call that sends
   * the tip sequence reverts. Suspension is the one that matters: a source
   * going quiet is exactly the moment this happens, so the gate would throw on
   * every tick and leave the room OPEN on a dead feed for the whole outage.
   */
  async _roomSequence(candidate) {
    const watermark = Number(await this.chain.lastObservedSequence());
    return candidate > watermark ? candidate : watermark;
  }

  async _closingSequence(decisiveSeq) {
    const watermark = Number(await this.chain.lastObservedSequence());
    return decisiveSeq > watermark ? decisiveSeq : watermark + 1;
  }

  /**
   * One evaluation pass at wall-clock `nowMs`. Ordering per tick:
   * 1. decisive events (close first — never clear an epoch a decision precedes)
   * 2. freshness (suspend/reopen)
   * 3. epoch clearance for open, undecided markets
   * 4. processing of cleared epochs
   */
  async tick(nowMs) {
    await this._ensureLoaded();
    const events = await this.store.all();
    if (Number(await this.chain.roomClosedSequence()) !== 0) return this._afterClose(nowMs);

    const open = await this.chain.openSlots();
    const headline = open.find((slot) => slot.market === this.config.headlineMarket);
    const graceMs = this.config.unevaluableGraceMs ?? 120_000;

    // 1. Decisions. The headline's decision is the room's terminal condition.
    if (headline) {
      const decision = evaluateCondition(this.conditionFor(headline.market), events, {
        participants: this.config.participants ?? null,
      });
      if (decision.status === "decided") {
        const closeAt = await this._closingSequence(decision.seq);
        await this._log({
          action: "closeRoom",
          seq: decision.seq,
          closedAtSequence: closeAt,
          retroactive: closeAt !== decision.seq,
          outcome: decision.outcome,
        });
        await this.chain.closeRoom(closeAt);
        await this.chain.closeRemainingSlots(open.map((slot) => slot.market));
        return;
      }
      if (decision.status === "unevaluable") {
        // Fail closed: suspend rather than guess. But suspension is not a
        // resting place — a room cannot hang there forever, or Integrity Bonds
        // never release and Forecasters never learn where they stand. After the
        // frozen grace period the room closes and Resolution takes over:
        // recovery if the facts can be reconstructed, Invalid if they cannot.
        const persistedMs = await this._markUnevaluable(headline.market, nowMs, decision.reason);
        await this._suspend(`headline unevaluable: ${decision.reason}`);
        if (persistedMs >= graceMs) {
          const seq = await this._closingSequence(await this._tipSeq());
          await this._log({
            action: "closeRoom",
            seq,
            reason: `headline unevaluable for ${persistedMs}ms: closing for recovery, then invalidation`,
          });
          await this.chain.closeRoom(seq);
          await this.chain.closeRemainingSlots(open.map((slot) => slot.market));
        }
        return;
      }
      await this._clearUnevaluable(headline.market);
    }

    // Micro slots: a decision closes one; a persistently unevaluable condition
    // also closes one, alone, so a single broken question never ends a session.
    const toClose = [];
    for (const slot of open) {
      if (headline && slot.market === headline.market) continue;
      const decision = evaluateCondition(this.conditionFor(slot.market), events, {
        headlineCondition: this.config.headlineMarket ? this.conditionFor(this.config.headlineMarket) : null,
        participants: this.config.participants ?? null,
      });
      if (decision.status === "decided") {
        toClose.push({ slot, seq: decision.seq });
        await this._clearUnevaluable(slot.market);
      } else if (decision.status === "unevaluable") {
        const persistedMs = await this._markUnevaluable(slot.market, nowMs, decision.reason);
        if (persistedMs >= graceMs) {
          await this._log({ action: "closeSlot", market: slot.market, reason: `unevaluable for ${persistedMs}ms` });
          toClose.push({ slot, seq: await this.chain.lastObservedSequence() });
        }
      } else {
        await this._clearUnevaluable(slot.market);
      }
    }
    if (toClose.length > 0) {
      const seq = await this._closingSequence(Math.max(...toClose.map((entry) => entry.seq)));
      await this._log({ action: "closeSlots", seq, markets: toClose.map((entry) => entry.slot.market) });
      await this.chain.closeSlots(seq, toClose.map((entry) => entry.slot.market));
    }

    // 2. Freshness. Suspension state comes from chain, never from memory.
    const age = freshnessAgeMs(await this.store.tip(), nowMs);
    if (age > this.config.freshnessThresholdMs) {
      await this._suspend(`stale ${age}ms`);
      return; // stale source clears nothing
    }
    await this._reopen();

    // 3. Epoch clearance for every remaining open slot.
    await this._clearCompletedEpochs(nowMs, events);

    // 4. Refunds owed by slots that have already closed. A micro-market closes
    // on its own decision while the room keeps running, so this cannot wait for
    // `_afterClose` — doing that would strand every micro-market's refunds
    // until the whole session ended.
    await this._drainClosedEpochs();
  }

  async _clearCompletedEpochs(nowMs, events) {
    const { epochDurationS, sourceFinalityDelayS } = this.config;
    const open = await this.chain.openSlots();
    const tipSeq = await this._tipSeq();
    if (tipSeq === 0) return;

    const nowS = Math.floor(nowMs / 1000);
    const currentEpoch = Math.floor(nowS / epochDurationS);
    let toClear = [];
    for (const slot of open) {
      const decision = evaluateCondition(this.conditionFor(slot.market), events, {
        participants: this.config.participants ?? null,
      });
      if (decision.status !== "undecided") continue; // decided or unevaluable clears nothing
      let cleared = this.clearedEpochs.get(slot.market);
      if (!cleared) {
        cleared = new Set();
        this.clearedEpochs.set(slot.market, cleared);
      }
      // At most ONE epoch per market per tick: the market requires a strictly
      // increasing source sequence per market, so a second epoch at the same
      // watermark would revert.
      //
      // Which one matters. Clearing the oldest eligible epoch wastes the tick
      // on an empty epoch, and while wall-clock advances the pointer never
      // catches the epoch that actually holds the action — a backlog that
      // starves forever and refunds a Forecaster who did nothing wrong. So
      // epochs holding pending actions come first; empty ones are skipped
      // entirely, since marking them safe achieves nothing.
      //
      // The window must cover every epoch that could still hold a pending
      // action, which is maxPendingTime deep.
      const lookback = Math.max(
        3,
        Math.ceil((this.config.maxPendingTimeS ?? epochDurationS * 3) / epochDurationS) + 1
      );
      const candidates = [];
      for (let epoch = Math.max(0, currentEpoch - lookback); epoch < currentEpoch; epoch++) {
        const epochEndS = (epoch + 1) * epochDurationS;
        if (nowS < epochEndS + sourceFinalityDelayS) continue;
        // The log must have been observed past the epoch end (heartbeats give this in quiet periods).
        const tip = await this.store.tip();
        if (Date.parse(tip.observed_at) < epochEndS * 1000) continue;
        if (cleared.has(epoch) || (await this.chain.isEpochSafe(slot.market, epoch))) {
          cleared.add(epoch);
          continue;
        }
        candidates.push(epoch);
      }
      let chosen = null;
      for (const epoch of candidates) {
        if (typeof this.chain.hasPendingActions !== "function") {
          chosen = epoch;
          break;
        }
        if (await this.chain.hasPendingActions(slot.market, epoch)) {
          chosen = epoch;
          break;
        }
      }
      if (chosen !== null) toClear.push({ market: slot.market, epoch: chosen });
    }
    if (toClear.length === 0) return;
    const clearSeq = await this._roomSequence(tipSeq);
    await this._log({ action: "markRoomEpochsSafe", seq: clearSeq, entries: toClear });
    await this.chain.markRoomEpochsSafe(clearSeq, toClear.map((entry) => entry.market), toClear.map((entry) => entry.epoch));

    // Read back what the chain actually did. `markRoomEpochsSafe` isolates
    // child failures — a market that rejects the call is skipped and logged
    // while the room reports success — and recording the epoch as cleared
    // without looking meant the gate's own short-circuit never attempted it
    // again. The Forecaster actions waiting in it were then never executed,
    // only refunded when they timed out.
    //
    // The skip is routine, not exotic: a market rejects any sequence at or
    // below its own watermark, and reopening after an outage raises that
    // watermark to the tip, so the first clearance after every recovery lands
    // on exactly that sequence.
    const confirmed = [];
    for (const { market, epoch } of toClear) {
      const safe =
        typeof this.chain.isEpochSafe === "function" ? await this.chain.isEpochSafe(market, epoch) : true;
      if (safe) {
        this.clearedEpochs.get(market).add(epoch);
        confirmed.push({ market, epoch });
      } else {
        await this._log({ action: "epochSkipped", market, epoch, seq: tipSeq });
      }
    }
    if (confirmed.length === 0) return;
    toClear = confirmed;

    // Gate lag, as metrics.mjs defines it: source `observed_at` to on-chain
    // safe mark. This is the only place both halves of that subtraction are in
    // scope, and until now nothing in a running deployment measured it — the
    // sole observation lived in the single-process game-day script and timed
    // how long `tick()` took, which is a different quantity with the same name.
    // The runbook pages on this metric, so an unobserved one is not a missing
    // dashboard, it is a page that can never fire.
    const observedAt = Date.parse((await this.store.tip())?.observed_at ?? "");
    if (this.metrics && Number.isFinite(observedAt)) {
      this.metrics.observe("gate_lag_seconds", Math.max(0, (nowMs - observedAt) / 1000), {
        markets: toClear.length,
      });
    }

    await this.chain.processRoom(toClear.map((entry) => entry.market), toClear.map((entry) => entry.epoch), 1000);
  }

  async _afterClose(nowMs) {
    // The room is closed; the only remaining duty is pushing refunds through.
    const open = await this.chain.openSlots();
    if (open.length > 0) {
      await this.chain.closeRemainingSlots(open.map((slot) => slot.market));
    }
    // ...which this used to say and not do. Closing the remaining slots is not
    // pushing refunds through; it is the step before it.
    await this._drainClosedEpochs();
  }

  /**
   * Pushes through the refunds owed to everyone who traded into the epoch a
   * market closed in.
   *
   * Every action submitted at or after `closedEpoch` is refunded rather than
   * executed — deliberately, so nobody takes an irreversible fill after seeing
   * the winning moment. But the refund only happens when someone calls
   * `processEpoch`, and nothing did: `_clearCompletedEpochs` iterates
   * `openSlots()`, and a slot leaves that set the moment it closes. The epoch
   * holding the most user money in a livestream market — the one nearest the
   * decisive moment — was the one nothing was responsible for.
   *
   * Deliberately stateless. The duty outlives any single gate process, so it is
   * derived from chain state on every tick rather than from `clearedEpochs`-style
   * memory that a restart would silently discard exactly when it mattered.
   *
   * These epochs are NOT marked safe first, and must not be: `markEpochSafe`
   * reverts `WrongEpoch` at or past `closedEpoch`. `canRefund` is already true
   * for them, so `processRoom` alone is the whole job.
   */
  async _drainClosedEpochs() {
    // Ports that predate this (and the in-memory game-day doubles) simply have
    // nothing to drain.
    if (typeof this.chain.closedSlots !== "function") return;
    if (typeof this.chain.refundWindowOf !== "function") return;
    if (typeof this.chain.unprocessedActions !== "function") return;

    const closed = await this.chain.closedSlots();
    if (closed.length === 0) return;

    const toDrain = [];
    for (const slot of closed) {
      const { closedEpoch, currentEpoch } = await this.chain.refundWindowOf(slot.market);
      // One epoch per market per tick, matching the clearance path: the room
      // batches by market, so a second epoch for the same market in one call
      // would need a second entry the contract pairs positionally.
      for (let epoch = closedEpoch; epoch <= currentEpoch; epoch++) {
        if (await this.chain.unprocessedActions(slot.market, epoch)) {
          toDrain.push({ market: slot.market, epoch });
          break;
        }
      }
    }
    if (toDrain.length === 0) return;

    await this._log({ action: "processRoom", reason: "refund-on-close", entries: toDrain });
    await this.chain.processRoom(
      toDrain.map((entry) => entry.market),
      toDrain.map((entry) => entry.epoch),
      1000
    );

    // Counted only for what the chain confirms was actually swept, not for what
    // was attempted. `refunds_from_missed_clearance` is a page-severity rule
    // that, until now, nothing in production ever incremented — the alarm for
    // this failure mode was itself dead.
    if (!this.metrics) return;
    let swept = 0;
    for (const { market, epoch } of toDrain) {
      if (!(await this.chain.unprocessedActions(market, epoch))) swept += 1;
    }
    if (swept > 0) this.metrics.increment("refunds_from_missed_clearance", swept);
  }

  // ------------------------------------------------------------ permits

  /**
   * Signs a Publication Permit for a candidate question, or refuses.
   * The gate computes BOTH hashes itself from the submitted documents and
   * evaluates the condition at the current tip. Every outcome is logged.
   */
  async requestPermit(options) {
    await this._ensureLoaded();
    const { slotIndex, templateId, params, conditionDocument, announceDelay, request, restricted = [] } = options;
    const events = await this.store.all();
    const tipSeq = await this._tipSeq();
    const computedConditionHash = conditionHash(conditionDocument);
    const computedParamsHash = keccak256(toHex(canonicalize({ templateId, params })));


    if (Number(await this.chain.roomClosedSequence()) !== 0) {
      await this._log({ permit: "refused", reason: "room closed", slotIndex });
      return { refused: true, reason: "room closed" };
    }
    // A permit authorises a market on a source. Signing one while that source
    // has stopped reporting authorises trading against a feed that is not
    // there — and the new market opens UNFROZEN into a room the gate has
    // already suspended, because suspension only reaches slots that existed
    // when it happened.
    //
    // Suspension is the clock-free form of the question and the one that is
    // always checked: it is a chain fact, and it is exactly the gate's own
    // judgement that this feed has stopped. When the caller also supplies the
    // clock it is running on, freshness is checked directly, which catches the
    // window between a source going quiet and the next tick freezing the room.
    if (await this._isSuspendedOnChain()) {
      await this._log({ permit: "refused", reason: "room suspended", slotIndex });
      return { refused: true, reason: "room suspended: the source has stopped reporting" };
    }
    if (options.nowMs !== undefined) {
      const age = freshnessAgeMs(await this.store.tip(), options.nowMs);
      if (age > this.config.freshnessThresholdMs) {
        await this._log({ permit: "refused", reason: "source stale", ageMs: age, slotIndex });
        return { refused: true, reason: `source stale: ${Math.round(age / 1000)}s since the last observation` };
      }
    }

    const decision = evaluateCondition(conditionDocument, events, {
      participants: this.config.participants ?? null,
    });
    if (decision.status !== "undecided") {
      await this._log({
        permit: "refused",
        reason: `condition ${decision.status}`,
        detail: decision.reason ?? decision.outcome,
        seq: tipSeq,
        conditionHash: computedConditionHash,
        slotIndex,
      });
      return { refused: true, reason: `condition ${decision.status}`, decision };
    }

    // The words must say what the rule settles.
    //
    // The gate binds the question text into `requestHash` and, until now, never
    // read it — so `--question "Who reaches $5,000 first?" --param target=10000`
    // was signed, published, and immutable. Every forecaster read one claim and
    // traded against another, and the signature made it provably attributable
    // rather than provably correct.
    //
    // Checked HERE and not only in the publisher on purpose: the gate's whole
    // job is to not trust the publisher. A second publisher client, or one with
    // a stale catalogue, would otherwise walk straight past the check.
    if (this.catalog) {
      try {
        assertQuestionMatches(this.catalog, templateId, params, request?.question);
      } catch (error) {
        await this._log({ permit: "refused", reason: "question does not match its rule", slotIndex });
        return { refused: true, reason: error.message };
      }
    }

    // Only now, once the question is known to be open, does the gate bind the
    // COMPLETE request it was shown — computing the hash itself, so the
    // publisher cannot vary the template, winner setting, question, media, or
    // restricted list after this signature exists.
    if (!request) throw new Error("requestPermit needs the complete slot request to bind");
    const computedRequestHash = slotRequestHash(
      { ...request, templateParamsHash: computedParamsHash, conditionHash: computedConditionHash },
      restricted
    );

    // Issuance is anchored to CHAIN time when a chain clock is available: the
    // contract bounds permit age against block.timestamp, and a signer clock
    // that drifts ahead would mint permits the room rejects as not-yet-issued.
    const nowS = this.config.chainNow ? await this.config.chainNow() : Math.floor(Date.now() / 1000);
    const permit = {
      slotIndex,
      requestHash: computedRequestHash,
      conditionHash: computedConditionHash,
      undecidedThroughSequence: BigInt(tipSeq),
      announceDelay: BigInt(announceDelay),
      issuedAt: BigInt(nowS),
      expiresAt: BigInt(nowS + this.config.maxPermitLifetimeS),
      nonce: BigInt(this.nextNonce++),
    };
    // Persist the counter BEFORE handing the permit out: a crash between
    // signing and saving must never let the next start reissue this nonce.
    await this._save("nextNonce", this.nextNonce);
    const signature = await this.signer.signTypedData({
      domain: {
        name: "TraderMarket LiveRoom",
        version: "1",
        chainId: this.chainId,
        verifyingContract: this.roomAddress,
      },
      types: {
        PublicationPermit: [
          { name: "room", type: "address" },
          { name: "slotIndex", type: "uint32" },
          { name: "requestHash", type: "bytes32" },
          { name: "conditionHash", type: "bytes32" },
          { name: "undecidedThroughSequence", type: "uint256" },
          { name: "announceDelay", type: "uint64" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "PublicationPermit",
      message: { room: this.roomAddress, ...permit },
    });
    await this._log({
      permit: "signed",
      seq: tipSeq,
      conditionHash: computedConditionHash,
      requestHash: computedRequestHash,
      nonce: Number(permit.nonce),
      slotIndex,
    });
    return { refused: false, permit, signature, templateParamsHash: computedParamsHash };
  }
}
