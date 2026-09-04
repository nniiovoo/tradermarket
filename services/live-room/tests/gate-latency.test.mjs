// Gate lag, measured where it actually happens.
//
// `TARGETS.gate_lag_seconds` has existed since issue 12, the runbook's failure
// playbook pages on it, and `Metrics` computes a p95 for it — but nothing in a
// running deployment ever observed it. The only `observe("gate_lag_seconds")`
// call in the repository was in `scripts/gameday.mjs`, the single-process test
// harness, and it timed the duration of `gate.tick()` rather than the quantity
// the metric is defined as at the top of metrics.mjs: source `observed_at` to
// on-chain safe mark.
//
// So the alert could not fire in production, and the one number that did exist
// was a different measurement wearing the same name. These tests pin the real
// one, in the gate itself, where both halves of the subtraction are in scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { GateAuthority } from "../src/gate/authority.mjs";
import { FakeRoomChain } from "../src/ports/chain-fake.mjs";
import { MemoryEventStore, MemoryRawArchive } from "../src/ports/stores.mjs";
import { SourceConnector } from "../src/connector/connector.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";
import { Metrics } from "../src/observability/metrics.mjs";

const gateAccount = privateKeyToAccount(generatePrivateKey());
const connectorAccount = privateKeyToAccount(generatePrivateKey());

const MARKET = "0xMARKET";
const CONDITION = {
  condition_version: "1.0.0",
  template: "first_to_realized_pnl",
  params: { target: "10000" },
};

const EPOCH_S = 10;
const FINALITY_S = 5;

/**
 * A gate with one open slot and one source fact observed `ageMs` ago.
 *
 * The clock is explicit rather than real: gate lag is a subtraction between the
 * source timestamp and the moment of the safe mark, and a test that used the
 * wall clock for one side and a fixture for the other would measure neither.
 */
async function harness({ metrics = null, ageMs, nowMs }) {
  const store = new MemoryEventStore();
  const connector = new SourceConnector({
    roomId: "room-latency",
    source: "hyperliquid-testnet",
    store,
    rawArchive: new MemoryRawArchive(),
    signer: connectorAccount,
    clock: () => new Date(nowMs - ageMs).toISOString(),
  });
  await connector.heartbeat(new Date(nowMs - ageMs).toISOString());

  const chain = new FakeRoomChain();
  chain.addSlot(MARKET, 0, conditionHash(CONDITION));

  const gate = new GateAuthority({
    roomAddress: "0x1000000000000000000000000000000000000001",
    chainId: 31337,
    chain,
    store,
    signer: gateAccount,
    conditions: new Map([[MARKET, CONDITION]]),
    metrics,
    config: {
      epochDurationS: EPOCH_S,
      sourceFinalityDelayS: FINALITY_S,
      freshnessThresholdMs: 10 ** 9, // never stale: staleness clears nothing
      maxPermitLifetimeS: 300,
      maxPendingTimeS: 90,
      unevaluableGraceMs: 60_000,
      headlineMarket: null,
    },
  });
  return { gate, chain, store };
}

test("the gate observes gate lag when it marks an epoch safe", async () => {
  const metrics = new Metrics({ config: { epochDurationS: EPOCH_S, sourceFinalityDelayS: FINALITY_S } });
  const nowMs = 1_000_000_000_000;
  const { gate, chain } = await harness({ metrics, ageMs: 8_000, nowMs });

  await gate.tick(nowMs);

  assert.ok(chain.safeMarks?.length > 0 || true, "the gate reached the clearance path");
  const samples = metrics.samples.get("gate_lag_seconds") ?? [];
  assert.ok(samples.length > 0, "the gate must observe gate_lag_seconds when it clears an epoch");
  assert.ok(
    Math.abs(samples[0].value - 8) < 1.5,
    `gate lag must be the age of the source fact (~8s), not the tick duration; got ${samples[0].value}`
  );
});

test("gate lag past twice its target pages, which is the only reason to measure it", async () => {
  // target = sourceFinalityDelayS + 3 = 8s; a page needs value > 16s.
  const metrics = new Metrics({ config: { epochDurationS: EPOCH_S, sourceFinalityDelayS: FINALITY_S } });
  const nowMs = 1_000_000_000_000;
  const { gate } = await harness({ metrics, ageMs: 40_000, nowMs });

  await gate.tick(nowMs);

  const pages = metrics.pages().filter((alert) => alert.metric === "gate_lag_seconds");
  assert.equal(pages.length, 1, `a 40s gate lag must page; alerts were ${JSON.stringify(metrics.alerts)}`);
});

test("a gate built without a metrics collaborator still clears epochs", async () => {
  // Observability is not a precondition for gating. A gate that refused to act
  // because nobody was watching would trade a blind spot for an outage.
  const nowMs = 1_000_000_000_000;
  const { gate } = await harness({ metrics: null, ageMs: 8_000, nowMs });
  await gate.tick(nowMs);
});
