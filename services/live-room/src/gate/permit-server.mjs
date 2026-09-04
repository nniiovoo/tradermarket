// The gate side of the publication channel.
//
// The Gate Authority already knows how to decide whether a question may be
// published — `requestPermit` evaluates the frozen condition at the log tip,
// checks the source is still reporting, computes both hashes itself, and signs.
// What it did not have was a way to be ASKED by another process.
//
// It had one only in the sense that the publisher constructed a GateAuthority
// inside itself and called the method directly. That made the permit signature
// come from whatever key the publisher happened to hold, which is the whole
// two-key design dissolved into a naming convention.
//
// This is the missing half: the gate process drains requests other processes
// left in the durable queue, signs them with the gate key, and writes the
// answer back. A refusal is an answer too, and is recorded as one.

export class PermitServer {
  /**
   * @param options.gate   the GateAuthority holding GATE_SIGNER_ROLE
   * @param options.queue  the durable publication queue
   * @param options.maxPerTick  how many requests one tick will sign
   */
  constructor({ gate, queue, maxPerTick = 5 }) {
    this.gate = gate;
    this.queue = queue;
    this.maxPerTick = maxPerTick;
  }

  /**
   * Signs (or refuses) every request waiting on the gate.
   *
   * Bounded per tick on purpose: signing is the one thing only this process can
   * do, and a backlog of a hundred requests must not stop it evaluating the
   * conditions of the markets that are already open.
   */
  async tick({ nowMs = Date.now() } = {}) {
    const actions = [];
    const awaitingPermit = await this.queue.awaitingPermit();
    for (const record of awaitingPermit.slice(0, this.maxPerTick)) {
      actions.push(await this.serve(record, nowMs));
    }
    return { actions };
  }

  async serve(record, nowMs = Date.now()) {
    const { candidate, request, restricted, conditionDocument } = record;
    if (!request || !conditionDocument) {
      // The publisher is the only thing that writes these, and it writes both
      // or neither. A row with one missing is corruption, not a question.
      const answer = await this.queue.markRefused(
        record.id,
        "incomplete request: no slot request or condition document"
      );
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    // The slot index is the room's own slot count, read now. The room requires
    // the permit's index to equal it exactly, so an operator typing a number
    // into a queued request is guessing at something only the chain knows —
    // and guessing wrong is a permit that can never be submitted.
    let slotIndex = candidate.slotIndex;
    if (slotIndex === null || slotIndex === undefined) {
      try {
        slotIndex = Number(await this.gate.chain.slotCount());
      } catch (error) {
        return {
          id: record.id,
          status: "awaiting_permit",
          error: `cannot read the room's slot count: ${String(error?.shortMessage ?? error?.message ?? error).split("\n")[0]}`,
        };
      }
    }

    let result;
    try {
      result = await this.gate.requestPermit({
        slotIndex,
        templateId: candidate.templateId,
        params: candidate.params,
        conditionDocument,
        announceDelay: Number(request.announceDelay),
        request,
        restricted,
        nowMs,
      });
    } catch (error) {
      // A gate that cannot reach the chain has not refused the question — it
      // has failed to answer it. Leaving the row where it is means the next
      // tick asks again, which is what should happen after an RPC blip.
      return {
        id: record.id,
        status: "awaiting_permit",
        error: String(error?.shortMessage ?? error?.message ?? error).split("\n")[0],
      };
    }

    if (result.refused) {
      const answer = await this.queue.markRefused(record.id, result.reason);
      return { id: record.id, status: answer.status, reason: answer.reason };
    }

    // The gate computes both hashes itself; the request the publisher submits
    // has to carry the gate's values, or the requestHash in the permit will
    // not match what the room recomputes and the publication reverts.
    const bound = {
      ...request,
      templateParamsHash: result.templateParamsHash,
      conditionHash: result.permit.conditionHash,
    };
    const answer = await this.queue.markPermitted(record.id, {
      permit: result.permit,
      signature: result.signature,
      request: bound,
    });
    return { id: record.id, status: answer.status, nonce: Number(result.permit.nonce) };
  }
}
