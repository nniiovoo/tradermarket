// The operator runtimes.
//
// The Coordinator holds no chain key — that is the point of it. The Gate,
// Publisher, Connector and Resolvers each hold a different one, which is why
// they are separate processes rather than threads of the same server: a
// compromise of the read surface must not be a compromise of the authority to
// sign a permit, publish a market, or attest a result.
//
// Until now they existed assembled only inside the game-day runner. These pin
// the production composition: each refuses to start without what it genuinely
// needs, and none of them can do another's job.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOperator,
  operatorConfigFromEnv,
  verifyOperatorAuthority,
  OPERATOR_ROLES,
} from "../src/operators.mjs";

const ANVIL_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const BASE = {
  TM_ROOM_ID: "room-1",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
  TM_CHAIN_ID: "31337",
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-op-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("every operator role is nameable and distinct", () => {
  // `keeper` is the fifth and the only non-authority: it decides nothing, and
  // every function it may sign for is permissionless. It is listed here rather
  // than special-cased because it is a real supervised process with its own
  // key, and the deployment tests enumerate this list to demand a unit for each.
  assert.deepEqual([...OPERATOR_ROLES].sort(), ["connector", "gate", "keeper", "publisher", "resolver"]);
});

test("an operator refuses to start without its own signing key", () => {
  for (const role of OPERATOR_ROLES) {
    assert.throws(
      () => buildOperator(role, operatorConfigFromEnv({ ...BASE })),
      (error) => {
        assert.match(error.message, /key/i, `${role} must name the key it needs`);
        return true;
      },
      `${role} must not start unsigned`
    );
  }
});

test("an operator refuses to start without a durable store", () => {
  // These processes write the only copy of the evidence log and their own
  // replay-protection state. Running them against memory means a restart
  // re-signs facts already signed and re-issues permits already issued.
  assert.throws(
    () => buildOperator("gate", operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY })),
    /TM_DATA_DIR/
  );
});

test("a built operator carries its role, its address, and nothing else's authority", () => {
  const { dir, clean } = scratch();
  try {
    const gate = buildOperator(
      "gate",
      operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir })
    );

    assert.equal(gate.role, "gate");
    assert.match(gate.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(gate.gate, "it is a gate");
    assert.equal(gate.publisher, undefined, "and not a publisher");
    assert.equal(gate.connector, undefined, "and not a connector");

    // The report is credential-safe: an operator's key must never reach a log.
    const report = gate.report();
    assert.ok(!JSON.stringify(report).includes(ANVIL_KEY.slice(2)), "a key must never appear in a report");
    assert.equal(report.role, "gate");
    assert.equal(report.address, gate.address);
  } finally {
    clean();
  }
});

test("the resolver reconstructs from raw bytes and never from coordinator state", () => {
  const { dir, clean } = scratch();
  try {
    const resolver = buildOperator(
      "resolver",
      operatorConfigFromEnv({
        ...BASE,
        TM_RESOLVER_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a,bob=0x000000000000000000000000000000000000000b",
      })
    );

    assert.ok(resolver.resolver, "it is a resolver");
    assert.ok(resolver.rawArchive, "reading raw provider bytes");
    assert.equal(resolver.store, undefined, "and it is given no projection to read a result from");
  } finally {
    clean();
  }
});

test("the connector needs a source and the participants it is reading", () => {
  const { dir, clean } = scratch();
  try {
    assert.throws(
      () => buildOperator("connector", operatorConfigFromEnv({ ...BASE, TM_CONNECTOR_KEY: ANVIL_KEY, TM_DATA_DIR: dir })),
      /TM_SOURCE|participants/i
    );

    const connector = buildOperator(
      "connector",
      operatorConfigFromEnv({
        ...BASE,
        TM_CONNECTOR_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_SOURCE: "hyperliquid-testnet",
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a,bob=0x000000000000000000000000000000000000000b",
      })
    );
    assert.ok(connector.connector);
    assert.deepEqual(
      connector.participants.map((entry) => entry.key),
      ["alice", "bob"]
    );
  } finally {
    clean();
  }
});

test("operators share one durable store rather than each keeping their own", async () => {
  const { dir, clean } = scratch();
  try {
    const gate = buildOperator("gate", operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir }));
    const connector = buildOperator(
      "connector",
      operatorConfigFromEnv({
        ...BASE,
        TM_CONNECTOR_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_SOURCE: "hyperliquid-testnet",
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
      })
    );

    // The connector writes a fact; the gate must be reading the same log, or
    // it would gate on evidence it cannot see.
    await connector.eventLog.append({ seq: 1, kind: "baseline", hash: "0xa", observed_at: "2026-01-01T00:00:00.000Z" });
    assert.equal((await gate.eventLog.tip()).seq, 1, "one log, many operators");
  } finally {
    clean();
  }
});

test("the connector operator carries a real poller against its configured source", () => {
  const { dir, clean } = scratch();
  try {
    const operator = buildOperator(
      "connector",
      operatorConfigFromEnv({
        ...BASE,
        TM_CONNECTOR_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_SOURCE: "hyperliquid-testnet",
        TM_SOURCE_INFO_URL: "https://api.hyperliquid-testnet.xyz/info",
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a,bob=0x000000000000000000000000000000000000000b",
      })
    );

    assert.ok(operator.poller, "the operator polls, rather than holding a key and doing nothing");
    assert.equal(operator.poller.infoUrl, "https://api.hyperliquid-testnet.xyz/info");
    assert.deepEqual(
      operator.poller.participants.map((entry) => entry.key),
      ["alice", "bob"]
    );
    // Cursors are durable, so a restart resumes rather than re-reading a session.
    assert.ok(operator.poller.cursors, "the poller's cursor survives a restart");
  } finally {
    clean();
  }
});

test("a source this build has no adapter for is refused, not silently idle", () => {
  const { dir, clean } = scratch();
  try {
    assert.throws(
      () =>
        buildOperator(
          "connector",
          operatorConfigFromEnv({
            ...BASE,
            TM_CONNECTOR_KEY: ANVIL_KEY,
            TM_DATA_DIR: dir,
            TM_SOURCE: "some-exchange-nobody-wrote-an-adapter-for",
            TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
          })
        ),
      /adapter|source/i,
      "an operator that cannot read its source must say so rather than run"
    );
  } finally {
    clean();
  }
});

test("the connector operator ingests, corrects and reconciles against a source", async () => {
  const { dir, clean } = scratch();
  const fills = [];
  let now = 10_000;
  try {
    const operator = buildOperator(
      "connector",
      operatorConfigFromEnv({
        ...BASE,
        TM_CONNECTOR_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_SOURCE: "hyperliquid-testnet",
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
      }),
      {
        now: () => now,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body);
          if (body.type === "clearinghouseState") {
            return { ok: true, text: async () => JSON.stringify({ marginSummary: { accountValue: "10000" } }) };
          }
          const inWindow = fills.filter((fill) => fill.time >= body.startTime && fill.time <= body.endTime);
          return { ok: true, text: async () => JSON.stringify(inWindow) };
        },
      }
    );

    await operator.poller.captureBaselines();
    fills.push({ tid: 1, time: 11_000, closedPnl: "100", fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" });
    now = 12_000;
    await operator.poller.pollOnce();

    const { foldMetrics } = await import("../src/domain/conditions.mjs");
    assert.equal(foldMetrics(await operator.eventLog.all()).get("alice").cumRealizedPnlUsd, "100");

    // The provider restates a fill the incremental window has moved past.
    fills[0] = { ...fills[0], closedPnl: "60" };
    now = 30_000;
    await operator.poller.pollOnce();
    await operator.poller.reconcile();

    assert.equal(
      foldMetrics(await operator.eventLog.all()).get("alice").cumRealizedPnlUsd,
      "60",
      "the sweep catches a restatement the forward-only window cannot"
    );
  } finally {
    clean();
  }
});

// ---------------------------------------------------------------------------
// The production composition of the publication and resolution paths.
//
// Both used to exist only inside the game-day runner. The operable publisher
// built a GateAuthority in its own address space and signed the permit with
// its own key — the two-key design reduced to a naming convention — and the
// operable resolver was constructed with no way to sign at all.

test("the publisher holds no gate authority and cannot sign its own permit", () => {
  const { dir, clean } = scratch();
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({
        ...BASE,
        TM_PUBLISHER_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        // The publisher validates a question's participant against this roster
        // before it is signed, so it now refuses to start without one.
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
      })
    );

    assert.ok(publisher.publisher, "it is a publisher");
    assert.equal(publisher.gate, undefined, "a publisher that holds a gate has defeated the separation");
    assert.ok(publisher.queue, "it takes its work from the durable queue");
    assert.equal(
      typeof publisher.publisher.tick,
      "function",
      "and it drives that queue rather than waiting to be called by a script"
    );
  } finally {
    clean();
  }
});

test("the gate serves permit requests as well as evaluating conditions", () => {
  const { dir, clean } = scratch();
  try {
    const gate = buildOperator("gate", operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir }));
    assert.ok(gate.permitServer, "a gate nobody can ask for a permit publishes nothing");
    assert.ok(gate.queue, "and it reads the requests from the durable queue");
  } finally {
    clean();
  }
});

test("a question queued against one process is visible to the other", async () => {
  const { dir, clean } = scratch();
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({
        ...BASE,
        TM_PUBLISHER_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        // The publisher validates a question's participant against this roster
        // before it is signed, so it now refuses to start without one.
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
      })
    );
    const gate = buildOperator("gate", operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir }));

    const { id } = await publisher.queue.submit({ slotIndex: 0, templateId: "tpl-participant-v1", params: { target: "1" } });
    assert.equal((await gate.queue.get(id)).status, "queued", "one queue, two processes");
  } finally {
    clean();
  }
});

test("the resolver can actually sign an attestation", () => {
  const { dir, clean } = scratch();
  try {
    const resolver = buildOperator(
      "resolver",
      operatorConfigFromEnv({
        ...BASE,
        TM_RESOLVER_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a,bob=0x000000000000000000000000000000000000000b",
      })
    );

    assert.ok(
      resolver.resolver.signerChain,
      "a resolver with no signing connection holds a key and attests nothing"
    );
    assert.ok(resolver.resolution, "and it needs a loop that finds the markets to resolve");
    assert.equal(typeof resolver.resolution.tick, "function");
    assert.equal(resolver.store, undefined, "still given no projection to read a result from");
  } finally {
    clean();
  }
});

test("an operator signs for the chain it was configured for, not for foundry", () => {
  const { dir, clean } = scratch();
  try {
    const amoy = buildOperator(
      "gate",
      operatorConfigFromEnv({ ...BASE, TM_CHAIN_ID: "80002", TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir })
    );
    // A wallet client signs the chain id it was GIVEN, not the one its RPC is
    // on. Defaulting to foundry's 31337 on a testnet deployment produces
    // transactions the node rejects — the failure is total and looks like a
    // broken RPC rather than a misconfiguration.
    assert.equal(amoy.chain.wallet.chain.id, 80002, "the wallet must sign for the configured chain");
    assert.equal(amoy.chain.chain.id, 80002);
  } finally {
    clean();
  }
});

test("an operator whose key does not hold its role on chain refuses to start", async () => {
  const { dir, clean } = scratch();
  try {
    const publisher = buildOperator(
      "publisher",
      operatorConfigFromEnv({
        ...BASE,
        TM_PUBLISHER_KEY: ANVIL_KEY,
        TM_DATA_DIR: dir,
        // The publisher validates a question's participant against this roster
        // before it is signed, so it now refuses to start without one.
        TM_PARTICIPANTS: "alice=0x000000000000000000000000000000000000000a",
      })
    );

    // The room names one publisher address and rejects every other caller. A
    // process whose key is not that address can validate, queue, ask the gate
    // for a permit and burn it on a transaction the room was always going to
    // refuse — once per request, indefinitely, with the room publishing nothing.
    const someoneElse = "0x000000000000000000000000000000000000dEaD";
    publisher.chain.publisherAddress = async () => someoneElse;
    const problem = await verifyOperatorAuthority(publisher);
    assert.ok(problem, "a publisher the room does not recognise must say so");
    assert.match(problem, /publisher/i);
    assert.ok(problem.includes(publisher.address), "and name the address it actually holds");

    publisher.chain.publisherAddress = async () => publisher.address;
    assert.equal(await verifyOperatorAuthority(publisher), null, "and start when it is the publisher");
  } finally {
    clean();
  }
});

test("the gate checks the room's signer, and an unreachable chain is not a verdict", async () => {
  const { dir, clean } = scratch();
  try {
    const gate = buildOperator("gate", operatorConfigFromEnv({ ...BASE, TM_GATE_KEY: ANVIL_KEY, TM_DATA_DIR: dir }));

    gate.chain.gateSigner = async () => "0x000000000000000000000000000000000000dEaD";
    assert.match(await verifyOperatorAuthority(gate), /gate/i);

    // An RPC that is down says nothing about whether this key holds the role.
    // Refusing to start on it would turn a network blip into an outage.
    gate.chain.gateSigner = async () => {
      throw new Error("connection refused");
    };
    assert.equal(await verifyOperatorAuthority(gate), null, "an unreadable chain is not a failed check");
  } finally {
    clean();
  }
});
