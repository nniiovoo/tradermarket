// The two chain ports must answer the same questions.
//
// Every test in this suite runs against `FakeRoomChain`; only a deployment
// runs against `OnChainRoom`. A method the fake has and the real port does not
// is therefore invisible to the whole suite and fatal in production — and that
// is not hypothetical: `slotCount` existed on the fake, in the ABI, and in the
// call the gate makes, but not as a method on the real port. Every permit
// request failed with "this.gate.chain.slotCount is not a function", forever,
// and the first thing that noticed was a room that published nothing.

import test from "node:test";
import assert from "node:assert/strict";

import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { OnChainRoom } from "../src/ports/chain-viem.mjs";

/** Methods a caller may reasonably reach for, on whichever port it was given. */
function methodsOf(instance) {
  const names = new Set();
  for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || name.startsWith("_")) continue;
      if (typeof instance[name] === "function") names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

function realPort() {
  return new OnChainRoom({
    publicClient: {},
    rpc: "http://127.0.0.1:8545",
    room: "0x2222222222222222222222222222222222222222",
    gateAccount: { address: "0x0000000000000000000000000000000000000001", type: "local" },
  });
}

test("every question the fake chain answers, the real one answers too", () => {
  const fake = methodsOf(new FakeRoomChain());
  const real = methodsOf(realPort());

  // The fake's own test scaffolding is not part of the port.
  //
  // `challenge` puts the fake into the bonded-challenge state. On a real chain
  // that state is produced by an audience member calling `challengeResult` with
  // their own bond — the operator ports never create a challenge, they only read
  // one and vote on it. So it is scaffolding, not a missing method.
  // The settlement-timing setters are the same kind of scaffolding: on a real
  // chain those values are written by the contract itself when a market closes,
  // a quorum registers a provisional result, or an audience member bonds a
  // challenge. The keeper only ever reads them.
  const scaffolding = new Set([
    "addSlot",
    "challenge",
    "setSettlementTiming",
    "registerProvisional",
    "setChallengedAt",
    "setResolutionDueAt",
    "failNextWrite",
    // Refund-on-close scaffolding. On a real chain a Forecaster submits the
    // action and the market records its own closed epoch; the gate only reads.
    "submitAction",
    "setClosedEpoch",
    "setCurrentEpoch",
  ]);
  const missing = [...fake].filter((name) => !scaffolding.has(name) && !real.has(name));

  assert.deepEqual(
    missing,
    [],
    `the real chain port is missing ${missing.join(", ")} — a deployment would fail on the first call`
  );
});

test("the calls the publisher, gate and resolver make exist on both ports", () => {
  // Named explicitly rather than derived, so adding a call to a service and
  // forgetting one port fails here rather than in a room that publishes nothing.
  const required = [
    // gate
    "openSlots", "lastObservedSequence", "roomClosedSequence", "isEpochSafe", "hasPendingActions",
    "markRoomEpochsSafe", "suspendRoom", "reopenRoom", "closeSlots", "closeRoom", "closeRemainingSlots",
    // resolver, challenge half — absent from the real port until 2026-08-23,
    // which is exactly why no service could adjudicate a bonded challenge.
    "challengeStateOf", "attestChallengeVerdict",
    "processRoom", "slotCount",
    // publisher
    "publishSlot", "usedNonce", "marketForConditionHash",
    // resolver
    "closedSlots", "headlineMarket", "conditionHashOf", "resolutionDueAtOf", "attestResult",
    // keeper — the calls that make a market final and its payouts claimable.
    // Absent from the real port until 2026-08-24, which is exactly why no
    // service could finalize anything and every payout waited on a human.
    "settlementStateOf", "finalizeUnchallenged", "expireChallenge", "invalidateUnresolved",
    // gate, refund-on-close: the epochs a closed market still owes refunds for.
    "refundWindowOf", "unprocessedActions",
    // startup authority check
    "publisherAddress", "gateSigner",
  ];
  const fake = methodsOf(new FakeRoomChain());
  const real = methodsOf(realPort());

  assert.deepEqual(required.filter((name) => !real.has(name)), [], "missing on the real chain port");
  assert.deepEqual(required.filter((name) => !fake.has(name)), [], "missing on the in-memory port");
});
