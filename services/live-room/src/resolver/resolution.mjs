// The resolver's production loop.
//
// `ResolverNode` knows how to rebuild one market's result from raw provider
// bytes and attest it. What it never had was a way to find out that a market
// needed resolving: that lived inside the game-day script, so the operable
// resolver held a key, counted its own incidents, and resolved nothing.
//
// This is the loop. It answers three questions per tick, in order:
//
//   1. which markets have closed and are still unresolved (from the CHAIN,
//      never from a projection — a resolver that learns what to resolve from
//      the Coordinator is resolving the Coordinator's opinion);
//   2. what question each of them actually asked (the frozen condition
//      document, from the durable publication record, and used only if it
//      hashes to the binding the chain holds);
//   3. what the raw bytes say the answer is.
//
// It is fail-closed at every one of those. A market whose document is missing,
// tampered with, or unhashable produces no attestation and a visible refusal —
// because a market resolved from a document the chain does not endorse is
// worse than a market that fails to Invalid.

import { conditionHash } from "../domain/conditions.mjs";
import { ChainVerifier } from "../domain/eventlog.mjs";

export class ResolutionService {
  /**
   * @param options.resolver     ResolverNode, wired to a signing chain port
   * @param options.chain        port: { closedSlots, headlineMarket, conditionHashOf, resolutionDueAtOf }
   * @param options.queue        durable publication queue (condition documents)
   * @param options.log          SqliteResolutionLog for THIS resolver's address
   * @param options.eventLog     the Session Event Log (read for its raw pointers)
   * @param options.participants [{ key, address }] the frozen linked accounts
   */
  constructor({ resolver, chain, queue, log, eventLog, participants, verifySignature = null }) {
    this.resolver = resolver;
    this.chain = chain;
    this.queue = queue;
    this.log = log;
    this.eventLog = eventLog;
    this.participants = participants;
    // The log is the evidence this resolver attests from, and until now it was
    // read bare — `verifyChain` existed with no production caller at all. Every
    // operator role opens the same database file, so a writer with access to it
    // could insert a self-consistent event and BOTH resolvers would agree,
    // because they were reading the same tampered bytes. Agreement between two
    // readers of one corrupted source is not the independence ADR 0024 claims.
    //
    // Held per service so the verified watermark survives across ticks. Without
    // a signature verifier the structural checks still run: a gap, a broken
    // link or a hash mismatch needs no key, and refusing to check what CAN be
    // checked because one thing is unavailable would be the wrong trade.
    this.chainVerifier = new ChainVerifier({ verifySignature });
  }

  /**
   * The condition document for one market, or null with the reason it cannot
   * be used. The hash check is the whole point: the document lives in a local
   * database, the hash lives on chain, and only the second one is evidence.
   */
  async _conditionFor(market, records) {
    const record = records.get(String(market).toLowerCase());
    if (!record?.conditionDocument) {
      return { reason: `no condition document recorded for ${market}` };
    }
    let onChain;
    try {
      onChain = await this.chain.conditionHashOf(market);
    } catch (error) {
      return { reason: `cannot read the condition binding: ${error.message ?? error}` };
    }
    const computed = conditionHash(record.conditionDocument);
    if (computed !== onChain) {
      return {
        reason: `condition hash mismatch: the record hashes to ${computed}, the chain holds ${onChain}`,
      };
    }
    return { document: record.conditionDocument, hash: computed };
  }

  /** Published records indexed by the market they produced. */
  async _publishedRecords() {
    const byMarket = new Map();
    for (const record of await this.queue.published()) {
      if (record.market) byMarket.set(String(record.market).toLowerCase(), record);
    }
    return byMarket;
  }

  async tick({ nowMs = Date.now() } = {}) {
    const attested = [];
    const refused = [];
    const skipped = [];

    const closed = await this.chain.closedSlots();
    if (closed.length === 0) return { attested, refused, skipped };

    const records = await this._publishedRecords();

    // The headline defines the session's terminal boundary, so every slot's
    // evaluation depends on it. If it cannot be trusted, nothing in the room
    // can be — and saying so once is better than resolving five markets
    // against a boundary nobody verified.
    const headlineMarket = await this.chain.headlineMarket();
    const headline = headlineMarket
      ? await this._conditionFor(headlineMarket, records)
      : { reason: "the room reports no headline slot" };
    if (!headline.document) {
      for (const slot of closed) {
        const reason = `headline unusable: ${headline.reason}`;
        const existing = await this.log.get(slot.market);
        if (!existing || existing.reason !== reason) {
          await this.log.record(slot.market, { status: "refused", reason });
        }
        refused.push({ market: slot.market, reason });
      }
      return { attested, refused, skipped };
    }

    const logEvents = await this.eventLog.all();

    // Verified before anything is reconstructed from it. Fail closed: a log
    // that does not verify is not evidence, and attesting from it would put
    // this resolver's signature behind bytes it cannot vouch for.
    const verification = await this.chainVerifier.verify(logEvents);
    if (!verification.ok) {
      const detail = verification.failures
        .slice(0, 3)
        .map((failure) => `seq ${failure.seq}: ${failure.reason}`)
        .join("; ");
      const reason =
        `the session event log does not verify (${verification.failures.length} failure(s)) — ${detail}`;
      for (const slot of closed) {
        const existing = await this.log.get(slot.market);
        if (!existing || existing.reason !== reason) {
          await this.log.record(slot.market, { status: "refused", reason });
        }
        refused.push({ market: slot.market, reason });
      }
      return { attested, refused, skipped };
    }

    for (const slot of closed) {
      const market = slot.market;
      if (await this.log.attested(market)) {
        skipped.push({ market, reason: "already attested by this resolver" });
        continue;
      }

      const nowS = Math.floor(nowMs / 1000);
      let dueAt = null;
      try {
        dueAt = Number(await this.chain.resolutionDueAtOf(market));
      } catch {
        dueAt = null; // an unreadable deadline is not a missed one
      }
      if (dueAt !== null && Number.isFinite(dueAt) && nowS > dueAt) {
        // The market refuses an attestation past this point, so sending one
        // buys a revert. It has to be recorded: a market that ran out of
        // resolution time settles to Invalid and somebody must know why.
        const reason = `resolution deadline passed ${nowS - dueAt}s ago`;
        await this.log.record(market, { status: "missed", reason });
        refused.push({ market, reason });
        continue;
      }

      // The headline resolves against ITSELF: `evaluateSlot` compares the two
      // conditions by identity to know it is evaluating the terminal question,
      // so the same object has to be passed twice.
      const isHeadline = String(market).toLowerCase() === String(headlineMarket).toLowerCase();
      const found = isHeadline ? headline : await this._conditionFor(market, records);
      if (!found.document) {
        await this.log.record(market, { status: "refused", reason: found.reason });
        refused.push({ market, reason: found.reason });
        continue;
      }

      let result;
      try {
        result = await this.resolver.resolveSlot({
          market,
          condition: isHeadline ? headline.document : found.document,
          conditionHash: found.hash,
          headlineCondition: headline.document,
          logEvents,
          participantAKey: this.participants[0]?.key,
          participantBKey: this.participants[1]?.key,
        });
      } catch (error) {
        // A failed attestation transaction is not a decision. Leave no record
        // of a verdict this resolver did not put its signature behind.
        const reason = String(error?.shortMessage ?? error?.message ?? error).split("\n")[0];
        refused.push({ market, reason });
        continue;
      }

      if (!result.attested) {
        await this.log.record(market, { status: "refused", reason: result.reason ?? "unevaluable" });
        refused.push({ market, reason: result.reason ?? "unevaluable" });
        continue;
      }
      await this.log.record(market, {
        status: "attested",
        outcome: result.outcomeEnum,
        evidenceHash: result.evidenceHash,
      });
      attested.push({ market, outcome: result.outcomeEnum, evidenceHash: result.evidenceHash });
    }

    const adjudicated = await this._adjudicateChallenges({ headline, logEvents, records, refused, skipped });

    return { attested, refused, skipped, adjudicated };
  }

  /**
   * Votes on every market paused on a bonded audience challenge.
   *
   * The contract has always had `attestChallengeVerdict`, and nothing ever
   * called it — the function was not even in the chain port's ABI. A challenger
   * bonded, the market paused, and the only outcome available was the timeout,
   * which invalidates. That made a well-founded challenge and a frivolous one
   * indistinguishable in effect, and never asked the resolvers whose judgement
   * is supposed to decide it.
   *
   * How a resolver decides: it rebuilds the result from raw provider bytes, the
   * same way it does for an attestation, and compares that to the provisional
   * outcome standing on chain. Agreement means the challenge is contradicted by
   * the evidence and is rejected; disagreement means the standing result is not
   * what the evidence supports and the challenge is accepted, invalidating.
   *
   * It deliberately does NOT try to evaluate the challenger's own evidence
   * document. That hash is on chain for humans and for audit; a resolver
   * mechanically "reviewing" an arbitrary off-chain blob would be asserting
   * something it cannot establish trustlessly, and the whole design rests on
   * resolvers reconstructing rather than being told.
   *
   * A resolver that cannot rebuild does not vote. An unanswered challenge times
   * out to Invalid, which is the safe direction; voting "reject" because it
   * could not check would let a market finalize on a result nobody verified,
   * using one resolver's silence as another's agreement.
   */
  async _adjudicateChallenges({ headline, logEvents, records, refused, skipped }) {
    const adjudicated = [];
    if (typeof this.chain.challengeStateOf !== "function") return adjudicated;

    const slots = await this.chain.closedSlots();
    const headlineMarket = await this.chain.headlineMarket();

    for (const slot of slots) {
      const market = slot.market;
      let state;
      try {
        state = await this.chain.challengeStateOf(market);
      } catch {
        continue; // an unreadable market is not a challenged one
      }
      if (!state.challenged || state.finalOutcome !== 0) continue;

      if (await this.log.verdict(market)) {
        skipped.push({ market, reason: "this resolver already voted on the challenge" });
        continue;
      }

      const isHeadline = String(market).toLowerCase() === String(headlineMarket).toLowerCase();
      const found = isHeadline ? headline : await this._conditionFor(market, records);
      if (!found.document) {
        const reason = `challenge unreviewable: ${found.reason}`;
        refused.push({ market, reason });
        continue;
      }

      let result;
      try {
        result = await this.resolver.reconstructSlot({
          market,
          condition: isHeadline ? headline.document : found.document,
          conditionHash: found.hash,
          headlineCondition: headline.document,
          logEvents,
          participantAKey: this.participants[0]?.key,
          participantBKey: this.participants[1]?.key,
        });
      } catch (error) {
        refused.push({ market, reason: String(error?.shortMessage ?? error?.message ?? error).split("\n")[0] });
        continue;
      }

      if (!result || result.outcomeEnum === null || result.outcomeEnum === undefined) {
        refused.push({ market, reason: "challenge unreviewable: the raw bytes do not decide this question" });
        continue;
      }

      const accept = Number(result.outcomeEnum) !== Number(state.provisionalOutcome);
      try {
        await this.chain.attestChallengeVerdict(market, accept);
      } catch (error) {
        // Nothing is recorded: a verdict this resolver did not get on chain is
        // not a verdict it cast.
        refused.push({ market, reason: String(error?.shortMessage ?? error?.message ?? error).split("\n")[0] });
        continue;
      }
      // Its OWN row. Writing this into `resolution_attempt` erased the record
      // of having attested, and the next tick — seeing no attestation — attested
      // the same market a second time.
      await this.log.recordVerdict(market, {
        accepted: accept,
        outcome: result.outcomeEnum,
        reason: accept
          ? `challenge accepted: the raw bytes support ${result.outcomeEnum}, not the provisional ${state.provisionalOutcome}`
          : `challenge rejected: the raw bytes still support the provisional ${state.provisionalOutcome}`,
      });
      adjudicated.push({ market, accept, outcome: result.outcomeEnum });
    }
    return adjudicated;
  }
}
