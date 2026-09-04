#!/usr/bin/env node
// Runs one operator role against a configured room.
//
//   node scripts/operator.mjs gate
//   node scripts/operator.mjs publisher
//   node scripts/operator.mjs connector
//   node scripts/operator.mjs resolver
//
// One role per process, each with its own key. Splitting them is not
// ceremony: publication needs the Program Publisher role *and* a Gate
// signature, and a single process holding both keys would make that pair
// meaningless. The Coordinator (scripts/serve.mjs) holds no key at all.

import {
  buildOperator,
  operatorConfigFromEnv,
  recordTick,
  verifyOperatorAuthority,
  OPERATOR_ROLES,
} from "../src/operators.mjs";
import { syncConditions } from "../src/gate/condition-registry.mjs";

const role = process.argv[2];
if (!OPERATOR_ROLES.includes(role)) {
  console.error(`Usage: node scripts/operator.mjs <${OPERATOR_ROLES.join("|")}>`);
  process.exit(1);
}

let operator;
try {
  operator = buildOperator(role, operatorConfigFromEnv(process.env));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// The schema, once, before anything reads or writes. Async, and construction is
// not — so it happens here rather than inside buildOperator. A no-op on SQLite.
try {
  await operator.migrate();
} catch (error) {
  console.error(`The ${role} cannot start: ${error.shortMessage ?? error.message}`);
  await operator.close();
  process.exit(1);
}

const report = operator.report();
console.log(`${role} operator running`);
console.log(`  address     ${report.address}`);
console.log(`  room        ${report.room_id} at ${report.room}`);
console.log(`  chain       ${report.chain_id ?? "unspecified"}`);
console.log(`  state       ${report.state_location}`);

// Before the first tick: does the room actually recognise this key? A process
// started with the wrong one does every step and is refused by the contract
// every time, which from outside is a room that publishes nothing.
const authorityProblem = await verifyOperatorAuthority(operator);
if (authorityProblem) {
  console.error(`The ${role} cannot start: ${authorityProblem}`);
  await operator.close();
  process.exit(1);
}

const { pollMs } = operator.config;
let baselined = false;
let lastReconcileAt = 0;

/** One tick of this role's work. Failures are reported, never smoothed over. */
async function tick() {
  try {
    if (role === "gate") {
      // The conditions the gate evaluates come from the durable publication
      // record and are verified against the chain's own binding before use. A
      // gate started after a publication, or restarted mid-session, had an
      // empty map and threw on every tick: a gate that had stopped gating.
      const { unverified } = await syncConditions(operator.gate, operator.queue, operator.chain);
      for (const entry of unverified) {
        // Loud, every tick, on purpose. A market the gate cannot evaluate will
        // suspend the room and then close for invalidation, and nobody should
        // learn that from the outcome.
        console.error(`[gate] UNVERIFIED ${entry.market}: ${entry.reason}`);
      }

      await operator.gate.tick(Date.now());

      // Permits second: signing a new market while the room's own state is
      // stale would authorise it against evidence the gate has not looked at.
      const served = await operator.permitServer.tick({ nowMs: Date.now() });
      for (const action of served.actions) {
        // The error case is the one that matters: a gate that cannot answer is
        // left on the queue and retried, and without printing WHY it looks
        // identical to a gate that is deliberately holding the request back.
        if (action.error) {
          console.error(`[gate] request ${action.id} could not be answered: ${action.error}`);
          continue;
        }
        console.log(`[gate] request ${action.id} -> ${action.status}${action.reason ? `: ${action.reason}` : ""}`);
      }
    } else if (role === "publisher") {
      const result = await operator.publisher.tick({ nowMs: Date.now() });
      for (const action of result.actions) {
        // A transport failure leaves the record where it is and is reported as
        // an error, not as a transition: "still permitted, could not reach the
        // chain" and "still permitted, nothing to do" are different facts.
        if (action.error) {
          console.error(`[publisher] request ${action.id} could not be submitted: ${action.error}`);
          continue;
        }
        console.log(
          `[publisher] request ${action.id} -> ${action.status}` +
            (action.market ? ` (${action.market})` : "") +
            (action.reason ? `: ${action.reason}` : "")
        );
      }
    } else if (role === "connector") {
      if (!baselined) {
        // The session baseline: return_pct is measured against it, and a
        // session without one can be scored on absolute PnL and nothing else.
        await operator.poller.captureBaselines();
        baselined = true;
        console.log(`[connector] baselines captured for ${operator.participants.length} participant(s)`);
      }
      const appended = await operator.poller.pollOnce();
      if (appended.length > 0) console.log(`[connector] ${appended.length} fact(s)`);

      // The incremental window only moves forward, so a provider that restates
      // a fill from earlier in the session would never be asked for it again.
      // The sweep re-asks; the dedupe drops what has not changed.
      if (Date.now() - lastReconcileAt >= operator.config.reconcileEveryMs) {
        lastReconcileAt = Date.now();
        const corrections = await operator.poller.reconcile();
        const restated = corrections.filter((event) => event.corrects);
        if (restated.length > 0) console.log(`[connector] ${restated.length} correction(s) from reconciliation`);
      }
    } else if (role === "resolver") {
      const result = await operator.resolution.tick({ nowMs: Date.now() });
      for (const entry of result.attested) {
        console.log(`[resolver] attested ${entry.market} outcome ${entry.outcome} evidence ${entry.evidenceHash}`);
      }
      for (const entry of result.refused) {
        // A refusal is the resolver's most important output: a market it will
        // not attest does not reach quorum, and the only other symptom is a
        // market that quietly never resolves.
        console.error(`[resolver] REFUSED ${entry.market}: ${entry.reason}`);
      }
    } else if (role === "keeper") {
      const result = await operator.keeper.tick();
      for (const entry of result.actions) {
        if (entry.error) {
          // Ordinary, not alarming: another keeper or a passer-by may have got
          // there first, and a chain a second behind our read simply says
          // TooEarly. Printed because a keeper that can NEVER act — a wrong
          // chain, an unfunded key — looks identical from outside to a room
          // with nothing to finalize.
          console.error(`[keeper] ${entry.action ?? "read"} ${entry.market} refused: ${entry.error}`);
          continue;
        }
        console.log(`[keeper] ${entry.action} ${entry.market} — payouts are now claimable`);
      }
    }
    // Every tick, whether or not it did anything, so a process that is alive
    // and one that cannot reach the chain are distinguishable from outside.
    // Latencies the role measured this tick, published for the Coordinator.
    // Only the gate has one today; the shape is the same for any other.
    const latencies = operator.metrics
      ? { gate_lag_seconds: operator.metrics.percentile("gate_lag_seconds") }
      : null;
    await recordTick(operator.durableState, role, { ok: true, latencies });
  } catch (error) {
    // One line: this is read back out through a metrics endpoint and a runbook,
    // and a viem stack trace repeated every five seconds is not a diagnosis.
    console.error(`[${role}] tick failed: ${error.shortMessage ?? error.message?.split("\n")[0] ?? error}`);
    await recordTick(operator.durableState, role, { ok: false, error });
  }
}

await tick();
// The interval is what keeps this process alive, and it must NOT be unref'd.
// It was: every operator ran exactly one tick and exited code 0 the moment the
// event loop emptied, which under a supervisor that restarts always looks like
// a working deployment doing one tick per restart, and under one that does not
// looks like a room whose authorities all quietly stopped.
const timer = setInterval(tick, pollMs);

const shutdown = async () => {
  clearInterval(timer);
  // Closes whichever backend this role opened — a Pool ends, a file closes.
  await operator.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
