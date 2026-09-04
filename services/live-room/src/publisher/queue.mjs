// The publisher side of the publication channel.
//
// `ProgramPublisher` does the whole publication in one call, with a
// GateAuthority handed to it — right for a game day that drives every component
// in one process, wrong for production, where the gate is a different process
// holding a different key and the only honest way to reach it is to ask and
// wait.
//
// This is the production shape. The publisher does exactly two things, on
// different ticks:
//
//   1. validate a queued question against the frozen catalogue, build the
//      condition document and the complete slot request, and hand it to the
//      gate. It STOPS there — it cannot decide whether the question is still
//      open, and that is the point of the second key.
//   2. take a permit the gate signed and submit it with the publisher key.
//
// Between those two the process may die, and the queue is where the work is,
// so it picks up where it left off.

const DEFAULT_MAX_PERMIT_ATTEMPTS = 3;

/**
 * Whether a failure was the ROOM refusing the transaction, or the network
 * failing to deliver it.
 *
 * The difference decides whether a question dies. A revert is a verdict: the
 * room will refuse this request every time and retrying is pointless. An
 * unreachable endpoint is not a verdict about anything, and treating one as a
 * verdict means every market in flight during an RPC blip is lost and has to
 * be noticed and re-queued by a person.
 *
 * Erring toward "retry" is safe here: a permit expires in minutes, so an
 * outage long enough to matter turns into a re-request rather than an
 * indefinite retry loop.
 */
function isChainRefusal(error) {
  const name = String(error?.name ?? "");
  if (/^(HttpRequestError|TimeoutError|RpcRequestError|SocketClosedError|WebSocketRequestError|InternalRpcError)$/.test(name)) {
    return false;
  }
  const text = String(error?.shortMessage ?? error?.message ?? error);
  if (/revert|rejected|not authori[sz]ed|exceeds|invalid|already known|nonce/i.test(text)) return true;
  // Anything unrecognised is treated as transport. A question wrongly retried
  // costs a tick; a question wrongly discarded costs the market.
  return false;
}

export class QueuedPublisher {
  /**
   * @param options.chain    port: { publishSlot, usedNonce?, slots?, conditionHashOf? }
   * @param options.queue    the durable publication queue
   * @param options.catalog  approved templates (the same frozen catalogue)
   * @param options.config   { minAnnounceDelay, maxPermitAttempts? }
   */
  constructor({ chain, queue, catalog, config }) {
    this.chain = chain;
    this.queue = queue;
    this.catalog = catalog;
    this.config = config;
    this.maxPermitAttempts = config?.maxPermitAttempts ?? DEFAULT_MAX_PERMIT_ATTEMPTS;
  }

  /** Accepts a question. Durable before it is anything else. */
  submit(candidate) {
    return this.queue.submit(candidate);
  }

  async tick({ nowMs = Date.now() } = {}) {
    const actions = [];
    // Reconciliation first: a record this publisher is about to retry may have
    // already landed, and finding that out from the chain is cheaper than
    // finding it out from a duplicate market.
    actions.push(...(await this.reconcile()));
    for (const record of await this.queue.permitted()) actions.push(await this.publish(record, nowMs));
    // One publication in flight at a time.
    //
    // The room requires a permit's slot index to equal its current slot count,
    // so two permits outstanding are two permits for the same index and only
    // one of them can ever be submitted. Serialising here costs a tick per
    // market — a session publishes a handful — and removes a whole class of
    // permits that are dead the moment they are signed.
    const inFlight = (await this.queue.awaitingPermit()).length + (await this.queue.permitted()).length;
    if (inFlight === 0) {
      const next = (await this.queue.queued())[0];
      if (next) actions.push(await this.prepare(next));
    }
    return { actions: actions.filter(Boolean) };
  }

  /**
   * Validates one queued question and hands it to the gate.
   *
   * Everything checkable without the source is checked here, so a question the
   * room would never publish does not consume the gate's attention or a nonce.
   */
  async prepare(record) {
    const candidate = record.candidate;
    const rule = this.catalog.get(candidate.templateId);
    if (!rule) {
      const answer = await this.queue.markRejected(record.id, `template ${candidate.templateId} not approved`);
      return { id: record.id, status: answer.status, reason: answer.reason };
    }
    const announceDelay = candidate.announceDelay ?? this.config.minAnnounceDelay;
    if (announceDelay < this.config.minAnnounceDelay) {
      const answer = await this.queue.markRejected(record.id, "announce delay below the frozen minimum");
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    let conditionDocument;
    try {
      conditionDocument = rule.buildCondition(candidate.params);
    } catch (error) {
      const answer = await this.queue.markRejected(record.id, `bad params: ${error.message}`);
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    // The gate must see the COMPLETE request it is being asked to attest,
    // including the per-slot restricted list, because that is what the permit
    // binds. Anything held back is something the publisher could change after.
    const answer = await this.queue.markAwaitingPermit(record.id, {
      request: {
        templateId: candidate.templateId,
        templateParamsHash: null, // the gate computes this itself
        conditionHash: null, // and this
        announceDelay,
        winnerRewardBps: rule.winnerRewardBps,
        question: candidate.question,
        streamUrl: candidate.streamUrl ?? "",
        imageUrl: candidate.imageUrl ?? "",
      },
      restricted: candidate.restricted ?? [],
      conditionDocument,
    });
    return { id: record.id, status: answer.status };
  }

  /**
   * Submits one gate-signed permit.
   *
   * A permit is time-bounded and single-use, and the room measures its age
   * against block time. One that went stale while this process was down is
   * worth nothing: submitting it spends gas to be told so. Ask again instead.
   */
  async publish(record, nowMs = Date.now()) {
    const permit = record.permit;
    if (!permit) {
      const answer = await this.queue.reopenForPermit(record.id, "no permit on a permitted record");
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    const nowS = Math.floor(nowMs / 1000);
    if (Number(permit.expiresAt) <= nowS) {
      if (Number(record.attempts ?? 0) + 1 >= this.maxPermitAttempts) {
        // Repeatedly outliving its own permits is not a blip. Something is
        // wrong with this publisher's liveness and a market should not be
        // published by a process that keeps discovering it was asleep.
        const answer = await this.queue.markFailed(
          record.id,
          `permit expired ${nowS - Number(permit.expiresAt)}s ago on attempt ${Number(record.attempts ?? 0) + 1}`
        );
        return { id: record.id, status: answer.status, reason: answer.reason };
      }
      const answer = await this.queue.reopenForPermit(
        record.id,
        `permit expired ${nowS - Number(permit.expiresAt)}s ago; asking the gate again`
      );
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    // The room requires the permit's slot index to equal its slot count. If
    // anything else published in the meantime this permit is already dead, and
    // sending it buys a revert and a wasted nonce.
    if (typeof this.chain.slotCount === "function") {
      let slotCount = null;
      try {
        slotCount = Number(await this.chain.slotCount());
      } catch {
        slotCount = null; // an unreachable chain is not evidence of a stale permit
      }
      if (slotCount !== null && Number(permit.slotIndex) !== slotCount) {
        const answer = await this.queue.reopenForPermit(
          record.id,
          `permit is for slot ${Number(permit.slotIndex)}; the room is at slot ${slotCount}`
        );
        return { id: record.id, status: answer.status, reason: answer.reason };
      }
    }

    try {
      const market = await this.chain.publishSlot(record.request, permit, record.signature, record.restricted);
      const answer = await this.queue.markPublished(record.id, { market });
      return { id: record.id, status: answer.status, market: answer.market };
    } catch (error) {
      const reason = String(error?.shortMessage ?? error?.message ?? error).split("\n")[0];
      // It may have landed anyway — a receipt can be lost after a transaction
      // is mined. Ask the chain before deciding, rather than assuming either way.
      const landed = await this._findLanded(record);
      if (landed) {
        const answer = await this.queue.markPublished(record.id, { market: landed });
        return { id: record.id, status: answer.status, market: answer.market };
      }
      if (!isChainRefusal(error)) {
        // Left where it is, permit intact, to be tried again next tick. If the
        // outage outlasts the permit, the expiry path re-requests it.
        return { id: record.id, status: record.status, error: reason };
      }
      const answer = await this.queue.markFailed(record.id, reason);
      return { id: record.id, status: answer.status, reason: answer.reason };
    }
  }

  /**
   * Reconciles in-flight records against chain state.
   *
   * The dangerous window is between a publication transaction being mined and
   * this process recording it: a crash there leaves a record saying "permitted"
   * for a market that already exists, and a naive retry publishes the same
   * question twice. The permit nonce settles it exactly — the room marks it
   * used inside the same call that deploys the market, so a consumed nonce
   * means the publication happened and nothing else does.
   */
  async reconcile() {
    if (typeof this.chain.usedNonce !== "function") return [];
    const actions = [];
    for (const record of await this.queue.permitted()) {
      if (!record.permit) continue;
      let used;
      try {
        used = await this.chain.usedNonce(record.permit.nonce);
      } catch {
        continue; // an unreachable chain answers nothing; the tick will retry
      }
      if (!used) continue;
      const market = await this._findLanded(record);
      const answer = await this.queue.markPublished(record.id, { market: market ?? null });
      actions.push({ id: record.id, status: answer.status, market: answer.market, reconciled: true });
    }
    return actions;
  }

  /** Names the market a consumed permit produced, by its condition hash. */
  async _findLanded(record) {
    if (typeof this.chain.usedNonce !== "function" || !record.permit) return null;
    try {
      if (!(await this.chain.usedNonce(record.permit.nonce))) return null;
    } catch {
      return null;
    }
    if (typeof this.chain.marketForConditionHash !== "function") return null;
    try {
      return await this.chain.marketForConditionHash(record.permit.conditionHash);
    } catch {
      return null;
    }
  }
}
