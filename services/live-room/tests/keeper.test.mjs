// The keeper: the process that actually finalizes markets.
//
// Every payout path on the market contract is `onlyFinal`. Until this role
// existed, nothing in production ever called `finalizeUnchallenged`,
// `expireChallenge` or `invalidateUnresolved` — the only callers were two
// game-day harnesses, the prototype's manual buttons, and a break-glass CLI.
// A market whose challenge window had elapsed simply sat at
// `finalOutcome == Unset` with everyone's collateral behind it, waiting for a
// human. Funds were never trapped (all three functions are permissionless) but
// they were unattended, with no upper bound on time-to-payout.
//
// The rule this file holds the keeper to: it may only ever call a function the
// contract would already accept. It must never widen a window, never pre-empt a
// challenge, and never treat a revert as fatal — the contract is the authority
// on whether it is time, and a keeper that decided that for itself would be a
// second, weaker implementation of the same rule.

import test from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";

import { KeeperService } from "../src/keeper/keeper.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { selectorsFor, ROLE_SELECTORS } from "../src/ports/signer.mjs";
import { LIVE_ROOM_ABI, MARKET_ABI } from "../src/ports/chain-viem.mjs";
import { OPERATOR_ROLES } from "../src/operators.mjs";

const MARKET = "0x00000000000000000000000000000000000000a1";

/** A room with one closed, unfinalized market — what a keeper actually meets. */
async function closedRoom({ challengeWindow = 600, challengeTimeout = 1800 } = {}) {
  const chain = new FakeRoomChain();
  chain.addSlot(MARKET, 0, "0xcondition");
  await chain.closeSlots(1, [MARKET]);
  chain.setSettlementTiming(MARKET, { challengeWindow, challengeTimeout });
  return chain;
}

const keeperFor = (chain, chainNowS) => new KeeperService({ chain, chainNow: async () => chainNowS() });

test("a market past its challenge window is finalized, with no human involved", async () => {
  const chain = await closedRoom();
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });

  let now = 1_000 + 600; // exactly at the boundary — the contract accepts `>=`
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(
    result.actions.map((a) => [a.action, a.market]),
    [["finalizeUnchallenged", MARKET]]
  );
  assert.equal(await chain.finalOutcomeOf(MARKET), 1, "the provisional outcome becomes final");
});

test("a market still inside its challenge window is left alone", async () => {
  const chain = await closedRoom();
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });

  // One second short. The challenge window is the audience's entire opportunity
  // to dispute; a keeper that rounds it down takes that away.
  let now = 1_000 + 599;
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(result.actions, []);
  assert.equal(await chain.finalOutcomeOf(MARKET), 0, "still unresolved, correctly");
});

test("a market with an open challenge is never finalized on the provisional result", async () => {
  const chain = await closedRoom();
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });
  chain.challenge(MARKET, { provisionalOutcome: 1 });
  chain.setChallengedAt(MARKET, 1_100);

  // Past the challenge window, but a challenge is open: finalizing on the
  // provisional outcome here would settle the market the challenge exists to
  // dispute.
  let now = 1_000 + 900;
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(result.actions, [], "neither finalize nor expire is legal yet");
  assert.equal(await chain.finalOutcomeOf(MARKET), 0);
});

test("a challenge nobody adjudicated expires to Invalid once its timeout passes", async () => {
  const chain = await closedRoom({ challengeTimeout: 1_800 });
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });
  chain.challenge(MARKET, { provisionalOutcome: 1 });
  chain.setChallengedAt(MARKET, 1_100);

  let now = 1_100 + 1_800;
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(
    result.actions.map((a) => a.action),
    ["expireChallenge"]
  );
  assert.equal(await chain.finalOutcomeOf(MARKET), 4, "an unanswered challenge fails closed to Invalid");
});

test("a closed market that never reached quorum is invalidated once resolution is due", async () => {
  const chain = await closedRoom();
  chain.setResolutionDueAt(MARKET, 5_000);
  // No provisional result at all: nobody attested, or quorum was never reached.

  let now = 5_000;
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(
    result.actions.map((a) => a.action),
    ["invalidateUnresolved"]
  );
  assert.equal(await chain.finalOutcomeOf(MARKET), 4);
});

test("a closed market before its resolution deadline is left for the resolvers", async () => {
  const chain = await closedRoom();
  chain.setResolutionDueAt(MARKET, 5_000);

  let now = 4_999;
  const result = await keeperFor(chain, () => now).tick();

  assert.deepEqual(result.actions, [], "the resolvers still have time to reach quorum");
  assert.equal(await chain.finalOutcomeOf(MARKET), 0);
});

test("an already-final market is never touched again", async () => {
  const chain = await closedRoom();
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });
  let now = 1_000 + 600;
  await keeperFor(chain, () => now).tick();
  const callsAfterFirst = chain.calls.length;

  const second = await keeperFor(chain, () => now + 10_000).tick();
  assert.deepEqual(second.actions, [], "a finalized market has left the keeper's work set");
  assert.equal(chain.calls.length, callsAfterFirst, "and no transaction was sent");
});

test("a reverting market is reported and does not stop the rest of the room", async () => {
  const chain = await closedRoom();
  const second = "0x00000000000000000000000000000000000000b2";
  chain.addSlot(second, 1, "0xcondition-2");
  await chain.closeSlots(2, [second]);
  chain.setSettlementTiming(second, { challengeWindow: 600, challengeTimeout: 1_800 });
  chain.registerProvisional(MARKET, { outcome: 1, atS: 1_000 });
  chain.registerProvisional(second, { outcome: 2, atS: 1_000 });
  // The contract is the authority on whether it is time. A revert is a normal
  // answer to "is it time yet", not an incident.
  chain.failNextWrite(MARKET, "TooEarly");

  const result = await keeperFor(chain, () => 1_000 + 600).tick();

  const failed = result.actions.find((a) => a.market === MARKET);
  assert.match(failed.error, /TooEarly/, "the refusal is reported");
  assert.equal(await chain.finalOutcomeOf(second), 2, "the other market still finalized");
});

test("the keeper is a liveness role, not an authority: its signer refuses every privileged call", async () => {
  assert.ok(OPERATOR_ROLES.includes("keeper"), "keeper is a real operator role");

  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  const allowed = selectorsFor("keeper", abi, { toSelector: toFunctionSelector });
  const selectorOf = (name) =>
    toFunctionSelector(abi.find((entry) => entry.type === "function" && entry.name === name));

  for (const permitted of ["finalizeUnchallenged", "expireChallenge", "invalidateUnresolved"]) {
    assert.ok(allowed.has(selectorOf(permitted)), `a keeper must be able to call ${permitted}`);
  }
  // The whole point of a fifth key is that it holds no authority. If a keeper
  // could attest or publish, the role separation everything else rests on would
  // be one compromised key away from meaningless.
  for (const forbidden of ["attestResult", "attestChallengeVerdict", "publishSlot", "closeRoom", "markRoomEpochsSafe"]) {
    assert.ok(!allowed.has(selectorOf(forbidden)), `a keeper must NOT be able to call ${forbidden}`);
  }
  assert.ok(
    !ROLE_SELECTORS.keeper.includes("attestResult"),
    "and the allow-list itself must say so, not merely happen to omit it"
  );
});
