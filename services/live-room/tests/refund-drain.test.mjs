// Issue 41: the refunds owed to everyone who traded near the close.
//
// Every action submitted during the epoch in which a market closes is refunded
// rather than executed (LivePredictionMarket.sol:521-524). That is deliberate —
// it is what stops anyone taking an irreversible fill after seeing the winning
// moment — but the refund is not automatic. Someone has to call processEpoch,
// and nothing did: `_clearCompletedEpochs` iterates `openSlots()`, a closed slot
// leaves that set immediately, and `_afterClose` carried the comment "the only
// remaining duty is pushing refunds through" above a body that pushed none.
//
// In a livestream product most volume lands nearest the decisive moment, so the
// escrow holding the most user money was the one nothing was responsible for.
//
// The subtlety these tests pin down: `_epochActionIds` NEVER shrinks. The
// contract tracks progress in `epochCursor`, so "does this epoch still hold
// work" is `epochCursor < epochActionIds.length` — not `length > 0`, which is
// permanently true once anyone has ever traded and would make the gate re-send
// the same drain every tick forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";
import { buildEvent } from "../src/domain/eventlog.mjs";
import { Metrics } from "../src/observability/metrics.mjs";

const gateAccount = privateKeyToAccount(generatePrivateKey());
const HEADLINE = "0xHEADLINE";
const MICRO = "0xMICRO";
const CONDITION = { condition_version: "1.0.0", template: "first_to_realized_pnl", params: { target: "10000" } };

/** A store with one observation, so the gate has a tip to reason from. */
async function storeWithTip(observedAtMs) {
  const store = new MemoryEventStore();
  await store.append(
    buildEvent({
      tip: null,
      ingestedAt: new Date(observedAtMs).toISOString(),
      draft: {
        room_id: "room-drain",
        source: "hyperliquid-testnet",
        source_event_id: "heartbeat-1",
        kind: "heartbeat",
        observed_at: new Date(observedAtMs).toISOString(),
        raw_ref: "mem://raw/1",
        raw_hash: "0x" + "11".repeat(32),
        raw_query: {},
        facts: {},
      },
    })
  );
  return store;
}

async function harness({ epochDurationS = 10, metrics = null } = {}) {
  const store = await storeWithTip(1_000_000);
  const chain = new FakeRoomChain();
  chain.addSlot(HEADLINE, 0, "0xcond-headline");
  chain.addSlot(MICRO, 1, "0xcond-micro");
  const gate = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions: new Map([[HEADLINE, CONDITION], [MICRO, CONDITION]]),
    metrics,
    config: {
      epochDurationS,
      sourceFinalityDelayS: 10,
      freshnessThresholdMs: 20_000,
      maxPermitLifetimeS: 300,
      headlineMarket: HEADLINE,
    },
  });
  return { store, chain, gate };
}

test("the epoch a market closed in is drained, so the traders caught by the close get their money back", async () => {
  const { chain, gate } = await harness();
  // A trader submits into epoch 5, and the market closes in that same epoch.
  chain.submitAction(MICRO, 5);
  await chain.closeSlots(3, [MICRO]);
  chain.setClosedEpoch(MICRO, 5);
  chain.setCurrentEpoch(6);

  await gate.tick(1_000_000);

  assert.equal(
    await chain.unprocessedActions(MICRO, 5),
    false,
    "the closing epoch was processed, so the refund actually went through"
  );
  assert.ok(
    chain.calls.some(([name, markets, epochs]) => name === "processRoom" && markets.includes(MICRO) && epochs.includes(5)),
    "and it was processRoom that did it"
  );
});

test("a slot that closed while the room stayed open is drained too", async () => {
  // Per-slot close is the normal case for a micro-market: the room keeps
  // running. Draining only in `_afterClose` would strand every micro-market's
  // refunds until the whole room ended.
  const { chain, gate } = await harness();
  chain.submitAction(MICRO, 4);
  await chain.closeSlots(3, [MICRO]);
  chain.setClosedEpoch(MICRO, 4);
  chain.setCurrentEpoch(5);

  assert.equal(Number(await chain.roomClosedSequence()), 0, "the room itself is still open");
  await gate.tick(1_000_000);

  assert.equal(await chain.unprocessedActions(MICRO, 4), false);
});

test("a fully drained epoch is not re-sent on every tick forever", async () => {
  // `_epochActionIds` never shrinks, so a `length > 0` predicate would be
  // permanently true and the gate would burn a transaction every tick against
  // an epoch with nothing left in it.
  const { chain, gate } = await harness();
  chain.submitAction(MICRO, 5);
  await chain.closeSlots(3, [MICRO]);
  chain.setClosedEpoch(MICRO, 5);
  chain.setCurrentEpoch(6);

  await gate.tick(1_000_000);
  const afterFirst = chain.calls.filter(([name]) => name === "processRoom").length;
  await gate.tick(1_000_100);
  const afterSecond = chain.calls.filter(([name]) => name === "processRoom").length;

  assert.equal(afterSecond, afterFirst, "nothing left to drain means nothing sent");
});

test("the drain does not depend on state the gate holds in memory", async () => {
  // A gate restarted after the close still owes those refunds. If the duty
  // lived in `clearedEpochs`-style in-process state it would be lost exactly
  // when a crash made it matter.
  const { chain } = await harness();
  chain.submitAction(MICRO, 5);
  await chain.closeSlots(3, [MICRO]);
  chain.setClosedEpoch(MICRO, 5);
  chain.setCurrentEpoch(6);

  // A brand-new gate object against the same chain — the restart.
  const store = await storeWithTip(1_000_000);
  const restarted = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions: new Map([[HEADLINE, CONDITION], [MICRO, CONDITION]]),
    config: {
      epochDurationS: 10,
      sourceFinalityDelayS: 10,
      freshnessThresholdMs: 20_000,
      maxPermitLifetimeS: 300,
      headlineMarket: HEADLINE,
    },
  });

  await restarted.tick(1_000_000);
  assert.equal(await chain.unprocessedActions(MICRO, 5), false, "a restarted gate still pays what is owed");
});

test("draining an epoch a previous tick should have taken increments the page counter", async () => {
  // `refunds_from_missed_clearance` is a page-severity rule that, before this,
  // was incremented nowhere in production — the alarm for this exact failure
  // mode was itself dead.
  const metrics = new Metrics({ config: { epochDurationS: 10, sourceFinalityDelayS: 10 } });
  const { chain, gate } = await harness({ metrics });
  chain.submitAction(MICRO, 5);
  await chain.closeSlots(3, [MICRO]);
  chain.setClosedEpoch(MICRO, 5);
  chain.setCurrentEpoch(6);

  await gate.tick(1_000_000);

  assert.ok(
    metrics.count("refunds_from_missed_clearance") > 0,
    "a refund the gate had to sweep up is counted, so the rule that pages on it can fire"
  );
});

test("the room closing drains every slot, and says so rather than only closing them", async () => {
  const { chain, gate } = await harness();
  chain.submitAction(HEADLINE, 7);
  chain.submitAction(MICRO, 7);
  await chain.closeRoom(9);
  for (const market of [HEADLINE, MICRO]) {
    chain.setClosedEpoch(market, 7);
  }
  chain.setCurrentEpoch(8);

  await gate.tick(1_000_000);

  assert.equal(await chain.unprocessedActions(HEADLINE, 7), false, "the headline's refunds went through");
  assert.equal(await chain.unprocessedActions(MICRO, 7), false, "and the micro-market's");
});
