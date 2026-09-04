// Monitoring that pages someone, and processes that come back up.
//
// This build exports metrics and documents the operator processes, which is not
// the same as being operable. An alert rule naming a metric nothing exports is
// an alert that never fires — worse than no rule, because the dashboard shows a
// green check for a thing nobody is watching. And a supervised process is what
// separates "we ran it once" from "it runs": the gate, connector, publisher and
// resolver each have to come back after a crash, a reboot, and an RPC outage.
//
// Neither of these can be proven here. What can be proven is that the rules only
// name metrics this build really exports, that every alert says where to look,
// and that no unit carries a key in its text.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMetrics } from "../src/observability/exporter.mjs";
import { OPERATOR_ROLES } from "../src/operators.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY = join(HERE, "..", "deploy");

/** Every metric name this build can export, from a fully populated snapshot. */
function exportedMetrics() {
  const text = renderMetrics({
    room_ids: ["room-1"],
    chain_head: 100,
    indexer_cursor: 99,
    indexer_health: "current",
    stream_health: "live",
    source_health: "fresh",
    rooms_indexed: 1,
    markets_indexed: 4,
    chat_messages: 7,
    non_chain_history_durable: true,
    durable_bytes: 12_345,
    config_warning: null,
    // Measured by the indexer inside this process, not by an authority, so it
    // arrives here rather than through the operator channel. Present for the
    // same reason the operator rows below are: a fixture missing a signal makes
    // the guard reject an alert on a metric this build does export.
    epoch_clear_seconds: 12,
    reorgs_seen: 0,
    // Every role a deployment can hear from. Leaving these out made the guard
    // below reject an alert on a metric this build does export, which is the
    // same class of mistake the guard exists to catch, pointing the other way.
    operators: [
      { role: "gate", last_success_age_s: 4, failing: false, last_error: null, latencies: { gate_lag_seconds: 3 } },
      { role: "connector", last_success_age_s: 400, failing: true, last_error: "HTTP request failed" },
    ],
  });
  return new Set(
    text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE "))
      .map((line) => line.split(" ")[2])
  );
}

const rules = () => readFileSync(join(DEPLOY, "alerts", "tradermarket.rules.yml"), "utf8");

test("every metric an alert rule names is one this build actually exports", () => {
  const exported = exportedMetrics();
  const referenced = new Set(rules().match(/tradermarket_[a-z_]+/g) ?? []);
  assert.ok(referenced.size > 0, "the rules must actually reference metrics");
  for (const metric of referenced) {
    assert.ok(exported.has(metric), `${metric} is alerted on but never exported`);
  }
});

test("every alert waits before firing and says where to look", () => {
  const text = rules();
  const alerts = text.split(/- alert: /).slice(1);
  assert.ok(alerts.length >= 4, `only ${alerts.length} alert(s) defined`);
  for (const alert of alerts) {
    const name = alert.split("\n")[0].trim();
    assert.match(alert, /\n\s+for: \d+[smh]/, `${name} fires on a single scrape`);
    assert.match(alert, /runbook/i, `${name} does not point at the runbook`);
    assert.match(alert, /summary:/, `${name} has no summary`);
  }
});

test("nothing alerts on a livestream as though it were a market problem", () => {
  // Stream health is presentation only. An alert that treats it as a trading
  // incident teaches an operator exactly the wrong reflex.
  const stream = rules().split(/- alert: /).find((block) => block.includes("tradermarket_stream_health"));
  if (!stream) return;
  assert.match(stream, /severity: info/, "a stream alert must not page anyone");
  assert.match(stream, /never|not a market|presentation/i, "and must say what it does not mean");
});

test("every operator role has a supervised unit, and none of them carries a key", () => {
  const units = readdirSync(join(DEPLOY, "systemd")).filter((name) => name.endsWith(".service"));
  for (const role of [...OPERATOR_ROLES, "api"]) {
    const unit = units.find((name) => name.includes(role));
    assert.ok(unit, `no unit supervises the ${role} process`);
    const text = readFileSync(join(DEPLOY, "systemd", unit), "utf8");
    assert.match(text, /Restart=always/, `${unit} does not restart`);
    assert.match(text, /EnvironmentFile=/, `${unit} does not read its configuration from a file`);
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(text), `${unit} contains something shaped like a private key`);
    assert.ok(!/TM_[A-Z_]*KEY=/.test(text), `${unit} sets a signing key inline`);
  }
});

test("the operator units keep the authorities in separate processes", () => {
  // One process holding two authority keys is the separation the whole design
  // rests on, undone by a deployment convenience.
  for (const role of OPERATOR_ROLES) {
    const text = readFileSync(join(DEPLOY, "systemd", `tradermarket-${role}.service`), "utf8");
    const started = text.match(/ExecStart=.*/)[0];
    for (const other of OPERATOR_ROLES) {
      if (other === role) continue;
      assert.ok(!started.includes(` ${other}`), `the ${role} unit also starts ${other}`);
    }
  }
});

test("the standard install starts two independently configured resolvers", () => {
  const systemd = join(DEPLOY, "systemd");
  const resolverUnits = readdirSync(systemd)
    .filter((name) => /^tradermarket-resolver(?:-\d+)?\.service$/.test(name))
    .sort();
  assert.equal(resolverUnits.length, 2, "one resolver can never reach the contract's two-signer quorum");

  const environmentFiles = resolverUnits.map((unit) => {
    const text = readFileSync(join(systemd, unit), "utf8");
    assert.match(text, /ExecStart=.*operator\.mjs resolver/, `${unit} does not run a resolver`);
    return /EnvironmentFile=(.*)/.exec(text)?.[1]?.trim();
  });
  assert.equal(new Set(environmentFiles).size, 2, "the resolvers must not read the same signing-key file");

  const install = readFileSync(join(systemd, "README.md"), "utf8");
  for (const unit of resolverUnits) {
    assert.match(install, new RegExp(unit.replace(/\.service$/, "")), `the install command never enables ${unit}`);
  }
});

// ---------------------------------------------------------------------------
// An authority that dies quietly.
//
// The gate, publisher, connector and resolver run as separate processes with
// their own keys. Each catches its own errors and keeps ticking, which is
// right — an authority that exits on a bad RPC response stops a live session
// over a blip. But it means a gate that cannot reach the chain at all fails
// silently and forever, and nothing outside that process can tell: the room
// simply stops progressing, and the first sign is a stalled session.
//
// The contracts have the last-resort answer (anyone may close a stalled room
// after the timeout), so money is not trapped. Nobody being able to SEE it is
// still the gap: this is the one process failure with real consequences and no
// signal at all.

test("an operator records whether its last tick actually worked", async () => {
  const { recordTick, operatorHealth } = await import("../src/operators.mjs");
  const state = new Map();
  const store = { get: async (key, fallback = null) => (state.has(key) ? state.get(key) : fallback), set: async (key, value) => state.set(key, value) };

  await recordTick(store, "gate", { ok: true, nowMs: 1_000 });
  // `latencies` is present and empty for an authority that has measured
  // nothing — which is the honest shape. Absent would be indistinguishable from
  // "this build cannot report latencies at all".
  assert.deepEqual(await operatorHealth(store, ["gate"], 4_000), [
    { role: "gate", last_success_age_s: 3, failing: false, last_error: null, latencies: {} },
  ]);

  await recordTick(store, "gate", { ok: false, error: new Error("HTTP request failed"), nowMs: 2_000 });
  const failing = (await operatorHealth(store, ["gate"], 60_000))[0];
  assert.equal(failing.failing, true, "a failed tick has to be visible");
  assert.equal(failing.last_success_age_s, 59, "and the age still counts from the last SUCCESS");
  assert.match(failing.last_error, /HTTP request failed/);

  // A role that has never run is unknown, not healthy and not failing.
  assert.deepEqual(await operatorHealth(store, ["publisher"], 60_000), []);
});

test("a silent operator is exported as an age, and alerted on", () => {
  const text = renderMetrics({
    room_ids: ["room-1"],
    operators: [
      { role: "gate", last_success_age_s: 400, failing: true, last_error: "HTTP request failed" },
      { role: "connector", last_success_age_s: 3, failing: false, last_error: null },
    ],
  });
  assert.match(text, /tradermarket_operator_last_success_age_seconds\{role="gate"\} 400/);
  assert.match(text, /tradermarket_operator_failing\{role="gate"\} 1/);
  assert.match(text, /tradermarket_operator_failing\{role="connector"\} 0/);

  // Nothing measured, nothing exported: a role nobody has heard from must not
  // read as a role that is fine.
  const silent = renderMetrics({ room_ids: ["room-1"] });
  assert.ok(!silent.includes("tradermarket_operator_"), "an unmeasured operator is absent, not zero");

  const rules = readFileSync(join(DEPLOY, "alerts", "tradermarket.rules.yml"), "utf8");
  assert.match(rules, /tradermarket_operator_last_success_age_seconds/, "the silent-authority case must page someone");
});

test("the operator process writes its liveness where the Coordinator can read it", async () => {
  // End to end: run a real gate operator against an RPC endpoint that is not
  // there, then read the durable state the API process would read.
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { openDatabase, SqliteKeyValue } = await import("../src/ports/sqlite-stores.mjs");
  const { operatorHealth } = await import("../src/operators.mjs");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-operator-health-"));
  const child = execFile("node", ["--no-warnings", join(HERE, "..", "scripts", "operator.mjs"), "gate"], {
    env: {
      ...process.env,
      TM_ROOM_ID: "room-1",
      TM_RPC_URL: "http://127.0.0.1:9",
      TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
      TM_DATA_DIR: dataDir,
      TM_OPERATOR_POLL_MS: "500",
      TM_GATE_KEY: "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
    },
  });
  try {
    // Wait for the fact, not for a duration. A fixed sleep passes on an idle
    // machine and fails under a loaded one, which makes the suite a coin toss
    // rather than a check.
    let health = [];
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && health.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const database = openDatabase(join(dataDir, "room.db"));
        health = await operatorHealth(new SqliteKeyValue(database), ["gate"], Date.now());
        database.close();
      } catch {
        // The operator has not created the database yet.
      }
    }

    assert.equal(health.length, 1, "the gate has been heard from, so it is not unknown");
    assert.equal(health[0].failing, true, "and what it reports is that it cannot work");
    assert.match(health[0].last_error, /.+/, "with the reason, in one line");
    assert.ok(!health[0].last_error.includes("\n"), "not a stack trace in a database column");
  } finally {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the Coordinator actually exports what the operators wrote", async () => {
  // The guard above proves the metric CAN be exported. This proves the running
  // service does: a metric that only exists when a test constructs the snapshot
  // by hand is a metric no alert will ever fire on.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { buildService, configFromEnv } = await import("../src/app.mjs");
  const { openDatabase, SqliteKeyValue } = await import("../src/ports/sqlite-stores.mjs");
  const { recordTick } = await import("../src/operators.mjs");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-coordinator-metrics-"));
  try {
    // Two authorities, in the two states that matter. The gate worked and then
    // stopped; the publisher has never worked at all — a misconfigured endpoint
    // from the first tick, which is the likelier of the two in practice.
    const seed = openDatabase(join(dataDir, "room.db"));
    const seedState = new SqliteKeyValue(seed);
    await recordTick(seedState, "gate", { ok: true, nowMs: Date.now() - 400_000 });
    await recordTick(seedState, "gate", { ok: false, error: new Error("HTTP request failed"), nowMs: Date.now() });
    await recordTick(seedState, "publisher", { ok: false, error: new Error("HTTP request failed"), nowMs: Date.now() });
    seed.close();

    // Built the way a deployment builds it, from the environment, rather than
    // from a hand-made object that happens to satisfy this test.
    const service = buildService(
      configFromEnv({
        TM_ROOM_ID: "room-1",
        TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
        // Nothing here reaches the chain: metrics() reads the projections and
        // the durable state, so this asserts what the process reports.
        TM_RPC_URL: "http://127.0.0.1:9",
        TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
        TM_CHAIN_ID: "31337",
        TM_DATA_DIR: dataDir,
      })
    );
    try {
      const snapshot = await service.metrics();
      const gate = (snapshot.operators ?? []).find((entry) => entry.role === "gate");
      assert.ok(gate, "the Coordinator reads the authorities' liveness from the shared state");
      assert.equal(gate.failing, true);
      assert.ok(gate.last_success_age_s >= 400, `age was ${gate.last_success_age_s}`);

      const text = renderMetrics(snapshot);
      assert.match(text, /tradermarket_operator_failing\{role="gate"\} 1/);
      assert.match(text, /tradermarket_operator_last_success_age_seconds\{role="gate"\} \d+/);

      // The publisher has never succeeded, so it has no age since its last
      // success — and inventing one would be the same lie as exporting zero.
      // The rules have to catch this case on `operator_failing` instead, and
      // the file has to say so, or a process that never worked at all sits
      // under an alert that structurally cannot fire for it.
      assert.match(text, /tradermarket_operator_failing\{role="publisher"\} 1/);
      assert.ok(
        !/tradermarket_operator_last_success_age_seconds\{role="publisher"\}/.test(text),
        "an authority that never worked has no age since it last worked"
      );
      const rules = readFileSync(join(DEPLOY, "alerts", "tradermarket.rules.yml"), "utf8");
      assert.match(rules, /never succeeded/i, "the rules must name the case the age series cannot cover");

      // And the same facts have to reach /v1/health over HTTP on the service a
      // deployment actually builds — not only on a server a test wires by hand
      // — because that is where the alert sends someone.
      const address = await service.server.listen(0);
      try {
        const body = await (await fetch(`http://127.0.0.1:${address.port}/v1/health`)).json();
        const served = body.operators ?? [];
        assert.ok(
          served.some((entry) => entry.role === "gate" && entry.failing),
          `the built service must serve the authorities' state; got ${JSON.stringify(served)}`
        );
      } finally {
        await service.server.close();
      }
    } finally {
      await service.close?.();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("/v1/health reports what the authorities said, because an alert points people there", async () => {
  // The AuthorityFailing rule tells an operator the reason is on /v1/health.
  // An alert that sends someone to a page that does not have the answer is its
  // own small lie, and the one that costs most at 3am.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { RoomApiServer } = await import("../src/api/server.mjs");
  const { LiveRoomCoordinator } = await import("../src/coordinator/coordinator.mjs");
  const { ProjectionStore } = await import("../src/indexer/projection.mjs");
  const { MemoryEventStore } = await import("../src/ports/stores.mjs");
  const { openDatabase, SqliteKeyValue } = await import("../src/ports/sqlite-stores.mjs");
  const { recordTick, operatorHealth } = await import("../src/operators.mjs");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-health-operators-"));
  const database = openDatabase(join(dataDir, "room.db"));
  const state = new SqliteKeyValue(database);
  await recordTick(state, "connector", { ok: false, error: new Error("hyperliquid info 503"), nowMs: Date.now() });

  const store = new ProjectionStore();
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog: new MemoryEventStore(),
    publishTo: () => {},
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });
  coordinator.tick();
  const server = new RoomApiServer({
    coordinator,
    store,
    eventLog: new MemoryEventStore(),
    operators: async () => await operatorHealth(state),
  });
  const address = await server.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    const body = await response.json();
    const connector = (body.operators ?? []).find((entry) => entry.role === "connector");
    assert.ok(connector, "/v1/health has to carry what the authorities reported");
    assert.equal(connector.failing, true);
    assert.match(connector.last_error, /503/, "including the reason, which is the point of looking");
  } finally {
    await server.close();
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("the durable store's size is measured, because it only grows", async () => {
  // The event log and the raw archive are never pruned: they are the evidence a
  // resolver reconstructs from and a challenger re-derives from, and pruning
  // them would make settled markets unverifiable. Measured at ~1.6 KB per
  // recorded fact, that is roughly half a gigabyte a day at four facts a
  // second. When the disk fills, SQLite writes fail, the connector stops
  // recording, and the room suspends on a stale source — a correct failure
  // reached for a reason nobody was watching.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { buildService, configFromEnv } = await import("../src/app.mjs");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-durable-bytes-"));
  try {
    const service = buildService(
      configFromEnv({
        TM_ROOM_ID: "room-1",
        TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
        TM_RPC_URL: "http://127.0.0.1:9",
        TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
        TM_CHAIN_ID: "31337",
        TM_DATA_DIR: dataDir,
      })
    );
    const snapshot = await service.metrics();
    assert.ok(snapshot.durable_bytes > 0, `durable_bytes was ${snapshot.durable_bytes}`);
    assert.match(renderMetrics(snapshot), /tradermarket_durable_bytes \d+/);

    // A process holding history in memory has no file to measure, and must not
    // report a zero — that reads as a database using no disk at all.
    const inMemory = buildService(
      configFromEnv({
        TM_ROOM_ID: "room-1",
        TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
        TM_RPC_URL: "http://127.0.0.1:9",
        TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
        TM_CHAIN_ID: "31337",
      })
    );
    assert.equal((await inMemory.metrics()).durable_bytes, null);
    assert.ok(!renderMetrics(await inMemory.metrics()).includes("tradermarket_durable_bytes"));

    const rules = readFileSync(join(DEPLOY, "alerts", "tradermarket.rules.yml"), "utf8");
    assert.match(rules, /tradermarket_durable_bytes/, "a disk that fills silently is the failure this metric exists for");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("gate lag reaches the Coordinator, so the metric the runbook pages on can actually fire", async () => {
  // The runbook's failure playbook has an entry for `gate_lag_seconds` paging.
  // Until now that page could never fire: nothing in a running deployment
  // observed the metric, no exporter emitted it, and no alert rule named it.
  // An operator reading that playbook was being told how to respond to a signal
  // the system could not produce.
  //
  // This closes the loop the same way operator liveness already does — through
  // the durable state both processes share — and asserts the Coordinator's own
  // /metrics output, not a hand-built snapshot.
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { buildService, configFromEnv } = await import("../src/app.mjs");
  const { openDatabase, SqliteKeyValue } = await import("../src/ports/sqlite-stores.mjs");
  const { recordTick } = await import("../src/operators.mjs");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-gate-lag-"));
  try {
    const seed = openDatabase(join(dataDir, "room.db"));
    const seedState = new SqliteKeyValue(seed);
    await recordTick(seedState, "gate", { ok: true, nowMs: Date.now(), latencies: { gate_lag_seconds: 12.5 } });
    seed.close();

    const service = buildService(
      configFromEnv({
        TM_ROOM_ID: "room-1",
        TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
        TM_RPC_URL: "http://127.0.0.1:9",
        TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
        TM_CHAIN_ID: "31337",
        TM_DATA_DIR: dataDir,
      })
    );
    const body = renderMetrics(await service.metrics());

    assert.match(
      body,
      /tradermarket_gate_lag_seconds\{role="gate"\} 12\.5/,
      `the Coordinator must export the gate lag the gate wrote; got:\n${body}`
    );
    // And an authority that has measured nothing must not get a fabricated zero.
    assert.ok(
      !/tradermarket_gate_lag_seconds\{role="publisher"\}/.test(body),
      "only the authority that measured gate lag reports it"
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("every alert rule still names a metric this build exports, gate lag included", () => {
  // Guards the pairing in both directions: adding the exporter without a rule
  // leaves a blind spot, adding a rule without an exporter leaves a page that
  // cannot fire. The gate-lag gap was the second kind for the whole of issue 12.
  const rules = readFileSync(join(HERE, "..", "deploy", "alerts", "tradermarket.rules.yml"), "utf8");
  assert.match(rules, /tradermarket_gate_lag_seconds/, "a gate-lag alert rule must exist");
});

test("no metric is declared twice in one exposition", () => {
  // A name declared by two publishers is malformed exposition, not merely
  // redundant — and it happened: epoch_clear_seconds was briefly on the operator
  // channel AND emitted by the indexer, producing two HELP/TYPE blocks for one
  // metric with different label sets. A measurement belongs to one publisher.
  const text = renderMetrics({
    room_ids: ["room-1"],
    chain_head: 100,
    indexer_cursor: 99,
    epoch_clear_seconds: 12,
    reorgs_seen: 1,
    operators: [{ role: "gate", last_success_age_s: 4, failing: false, last_error: null, latencies: { gate_lag_seconds: 3 } }],
  });
  const declared = text.split("\n").filter((line) => line.startsWith("# TYPE ")).map((line) => line.split(" ")[2]);
  const duplicated = declared.filter((name, index) => declared.indexOf(name) !== index);
  assert.deepEqual([...new Set(duplicated)], [], "each metric is declared exactly once");
});

test("every block.timestamp in deployed code is justified in writing", async () => {
  // ADR 0027 enumerates all 19 and states, per window, why validator drift
  // cannot decide an outcome. The guard is that a NEW one has to be justified
  // rather than absorbed into a warning count nobody reads — which is what
  // happens to a category that is merely described as "expected".
  const { execFileSync } = await import("node:child_process");
  const adr = readFileSync(
    join(HERE, "..", "..", "..", "docs", "adr", "0027-account-for-block-timestamp-dependence-and-the-market-size-ceiling.md"),
    "utf8"
  );
  let output = "";
  try {
    output = execFileSync("forge", ["lint", "src"], {
      cwd: join(HERE, "..", "..", "..", "contracts"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const sites = [...new Set(output.match(/src\/[A-Za-z]+\.sol:\d+/g) ?? [])];
  if (sites.length === 0) return; // forge unavailable in this environment

  const unjustified = sites.filter((site) => {
    const [file, line] = site.split(":");
    const contract = file.split("/").pop().replace(".sol", "");
    return !adr.includes(`${contract}:${line}`) && !adr.includes(`:${line}`);
  });
  assert.deepEqual(unjustified, [], `these block.timestamp uses have no row in ADR 0027: ${unjustified.join(", ")}`);
});
