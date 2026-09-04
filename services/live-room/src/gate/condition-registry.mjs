// Loading the gate's condition documents from the durable publication record.
//
// `GateAuthority` evaluates `conditions.get(market)` for every open slot and
// throws when a market is not in the map. In the game day that map was filled
// by the script that published the markets, so the question never came up. In
// production nothing filled it: a gate restarted mid-session, or started after
// a publication, had an empty map and threw on every tick — a gate that has
// stopped gating, reported as a failing tick and nothing else.
//
// The documents are already durable: the publisher writes each one into the
// publication queue before the gate is ever asked to sign it. This loads them
// back, and — exactly as the resolver does — refuses to use one that does not
// hash to the binding the chain holds. The database is convenient; only the
// chain is evidence.
//
// A market whose document cannot be verified is registered as UNEVALUABLE
// rather than skipped. That is not a workaround: "I cannot tell what this
// market asked" is precisely the condition the gate already handles correctly
// — suspend, hold for the grace period, then close for recovery or
// invalidation. Leaving it out of the map instead would throw, and a market
// nobody can evaluate must not take the rest of the room down with it.

import { conditionHash } from "../domain/conditions.mjs";

/** What gets registered for a market whose document does not check out. */
export function unverifiableCondition(reason) {
  return { condition_version: "1.0.0", template: "unverifiable", params: { reason } };
}

/**
 * Fills `gate.conditions` from the publication queue, verified against chain,
 * and tells the gate which slot is the headline.
 *
 * The headline matters as much as the documents. It is the room's terminal
 * condition: its decision is what closes the ROOM rather than one slot, and
 * every other slot is evaluated inside the window it ends. A gate configured
 * with `headlineMarket: null` — which is what a production gate had, because
 * nothing ever told it — still closes individual slots on their own decisions
 * but never ends the session, so Integrity Bonds never release and the room
 * sits open on a question that has already been answered.
 *
 * Slot 0 is the headline by construction: the room refuses any other template
 * there. So this is read from the chain, not from configuration.
 *
 * @returns { loaded, unverified, headlineMarket } — `unverified` is an
 *          operator's problem and is returned so it can be logged and
 *          exported, not swallowed.
 */
export async function syncConditions(gate, queue, chain) {
  const loaded = [];
  const unverified = [];

  let headlineMarket = null;
  if (typeof chain.headlineMarket === "function") {
    try {
      headlineMarket = await chain.headlineMarket();
    } catch {
      headlineMarket = null; // an unreadable room is the gate tick's problem
    }
  }
  if (headlineMarket) gate.config.headlineMarket = headlineMarket;

  const documents = new Map();
  for (const record of await queue.published()) {
    if (record.market && record.conditionDocument) {
      documents.set(String(record.market).toLowerCase(), record.conditionDocument);
    }
  }

  for (const slot of await chain.openSlots()) {
    const key = String(slot.market).toLowerCase();
    const document = documents.get(key);
    if (!document) {
      const reason = `no condition document recorded for ${slot.market}`;
      gate.conditions.set(slot.market, unverifiableCondition(reason));
      unverified.push({ market: slot.market, reason });
      continue;
    }
    // `openSlots` already carries the binding on some ports; ask the chain
    // directly when it does not, and treat an unreadable binding as unverified
    // rather than assuming the document is fine.
    let onChain = slot.conditionHash ?? null;
    if (onChain === null && typeof chain.conditionHashOf === "function") {
      try {
        onChain = await chain.conditionHashOf(slot.market);
      } catch (error) {
        const reason = `cannot read the condition binding: ${error.shortMessage ?? error.message ?? error}`;
        gate.conditions.set(slot.market, unverifiableCondition(reason));
        unverified.push({ market: slot.market, reason });
        continue;
      }
    }
    const computed = conditionHash(document);
    if (onChain !== null && computed !== onChain) {
      const reason = `condition hash mismatch: the record hashes to ${computed}, the chain holds ${onChain}`;
      gate.conditions.set(slot.market, unverifiableCondition(reason));
      unverified.push({ market: slot.market, reason });
      continue;
    }
    gate.conditions.set(slot.market, document);
    loaded.push(slot.market);
  }

  return { loaded, unverified, headlineMarket };
}
