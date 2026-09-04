// The anti-fabrication backbone.
//
// Every consumer surface — the website, the API, the help centre — must be able
// to ask "is this actually configured?" and get an honest answer. Nothing may
// claim gas sponsorship, a live stream, chat, referrals, or a deployment that
// does not exist. A capability is only ever "available" when the concrete thing
// it depends on is present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Capabilities, CAPABILITY_KEYS } from "../src/config/capabilities.mjs";

test("everything is unavailable by default, with a reason", () => {
  const capabilities = new Capabilities({});
  for (const key of CAPABILITY_KEYS) {
    const entry = capabilities.get(key);
    assert.equal(entry.available, false, `${key} must default to unavailable`);
    assert.ok(entry.reason, `${key} must explain why it is unavailable`);
  }
});

test("gas sponsorship is never claimed without a bundler, paymaster, and policy", () => {
  const partial = new Capabilities({
    paymaster: { bundlerUrl: "https://bundler.example", paymasterUrl: "" },
  });
  const entry = partial.get("gas_sponsorship");
  assert.equal(entry.available, false);
  assert.match(entry.reason, /paymaster/i);

  const noPolicy = new Capabilities({
    paymaster: { bundlerUrl: "https://bundler.example", paymasterUrl: "https://pm.example" },
  });
  assert.equal(noPolicy.get("gas_sponsorship").available, false, "a policy is required, not just endpoints");
  assert.match(noPolicy.get("gas_sponsorship").reason, /policy/i);

  // Four credentials and a policy that covers no action kind sponsors nothing:
  // the deployment would announce sponsorship and decline every request.
  const emptyPolicy = new Capabilities({
    paymaster: {
      bundlerUrl: "https://bundler.example",
      paymasterUrl: "https://pm.example",
      policyId: "testnet-forecasters",
      entryPoint: "0xEP",
    },
  });
  assert.equal(emptyPolicy.get("gas_sponsorship").available, false);
  assert.match(emptyPolicy.get("gas_sponsorship").reason, /at least one action kind/i);

  const configured = new Capabilities({
    paymaster: {
      bundlerUrl: "https://bundler.example",
      paymasterUrl: "https://pm.example",
      policyId: "testnet-forecasters",
      entryPoint: "0xEP",
      sponsoredKinds: ["predict", "provide_liquidity"],
    },
  });
  assert.equal(configured.get("gas_sponsorship").available, true);
});

test("the user-facing gas statement is truthful in both states", () => {
  const unconfigured = new Capabilities({});
  assert.match(unconfigured.gasStatement(), /pay .*own .*gas/i);
  // Naming sponsorship to DENY it is fine and useful; claiming it is not.
  assert.match(unconfigured.gasStatement(), /not configured/i);
  assert.ok(
    !/(is|are) sponsored/i.test(unconfigured.gasStatement()),
    "must never state that gas is sponsored when it is not"
  );

  const configured = new Capabilities({
    paymaster: { bundlerUrl: "b", paymasterUrl: "p", policyId: "x", entryPoint: "0xEP" },
  });
  assert.match(configured.gasStatement(), /sponsor/i);
});

test("a live room is only claimed when both an API and a room id are configured", () => {
  assert.equal(new Capabilities({ room: { apiUrl: "https://api" } }).get("live_room").available, false);
  assert.equal(new Capabilities({ room: { roomId: "r" } }).get("live_room").available, false);
  assert.equal(
    new Capabilities({ room: { apiUrl: "https://api", roomId: "r" } }).get("live_room").available,
    true
  );
});

test("a stream is only claimed when a playback source exists", () => {
  assert.equal(new Capabilities({}).get("livestream").available, false);
  assert.equal(new Capabilities({ stream: { playbackUrl: "https://x.m3u8" } }).get("livestream").available, true);
});

test("chat, referrals, and social proof each require their own configuration", () => {
  const capabilities = new Capabilities({ room: { apiUrl: "https://api", roomId: "r" } });
  assert.equal(capabilities.get("chat").available, false, "a room does not imply chat");
  assert.equal(capabilities.get("referrals").available, false);
  assert.equal(capabilities.get("social_proof").available, false);

  const withChat = new Capabilities({
    room: { apiUrl: "https://api", roomId: "r" },
    chat: { enabled: true },
  });
  assert.equal(withChat.get("chat").available, true);
});

test("the livestream oracle is claimed only with durable storage and operator authentication", () => {
  assert.equal(new Capabilities({ oracle: { dataDir: "/durable" } }).get("livestream_oracle").available, false);
  assert.equal(
    new Capabilities({ oracle: { dataDir: "/durable", operatorTokenConfigured: true } })
      .get("livestream_oracle").available,
    true
  );
});

test("a deployment is only claimed with a factory address and a chain", () => {
  assert.equal(new Capabilities({}).get("deployment").available, false);
  assert.equal(new Capabilities({ chain: { factory: "0xF" } }).get("deployment").available, false);
  assert.equal(new Capabilities({ chain: { factory: "0xF", chainId: 80002 } }).get("deployment").available, true);
});

test("legal approval can never be configured on", () => {
  // There is no configuration flag that makes this true. Claiming legal
  // availability is a decision for qualified advice, not a deploy variable.
  const capabilities = new Capabilities({
    legal: { approved: true, reviewed: true, jurisdictions: ["everywhere"] },
  });
  const entry = capabilities.get("legal_availability");
  assert.equal(entry.available, false);
  assert.match(entry.reason, /legal review/i);
});

test("the public snapshot never leaks credentials", () => {
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p", policyId: "x", entryPoint: "0xEP", apiKey: "SECRET" },
    room: { apiUrl: "https://api", roomId: "r" },
    chat: { enabled: true, moderatorKey: "ALSO-SECRET" },
  });
  const snapshot = JSON.stringify(capabilities.publicSnapshot());
  assert.ok(!snapshot.includes("SECRET"), "no secret may appear in the public snapshot");
  assert.ok(!snapshot.includes("ALSO-SECRET"));
  assert.ok(!/apiKey|moderatorKey/.test(snapshot), "no credential field names either");
});

test("the snapshot lists every capability with a stable shape", () => {
  const snapshot = new Capabilities({}).publicSnapshot();
  assert.deepEqual(Object.keys(snapshot.capabilities).sort(), [...CAPABILITY_KEYS].sort());
  for (const entry of Object.values(snapshot.capabilities)) {
    assert.equal(typeof entry.available, "boolean");
    assert.equal(typeof entry.reason, "string");
  }
  // With no chain configured there is nothing to base the claim on, so it is
  // reported as unknown rather than asserted.
  assert.equal(snapshot.testnet, null, "an unconfigured build makes no claim about the chain");
  assert.match(snapshot.collateral_notice, /not known/i);

  const configured = new Capabilities({ chain: { chainId: 80002 } }).publicSnapshot();
  assert.equal(configured.testnet, true);
  assert.match(configured.collateral_notice, /no real-world value/i);
});

test("the testnet claim is about the configured chain, not an assumption", () => {
  // `testnet: true` and "no real-world value" were asserted unconditionally.
  // They are true of every chain this software is meant for — and asserting
  // them without looking is how a build pointed at the wrong chain reassures
  // someone that their money is play money.
  const unknown = new Capabilities({ room: { apiUrl: "http://x" } });
  assert.equal(unknown.publicSnapshot().testnet, null, "no chain id means no claim");
  assert.match(unknown.publicSnapshot().collateral_notice, /not known|cannot|unknown/i);

  const amoy = new Capabilities({ room: { apiUrl: "http://x" }, chain: { chainId: 80002 } });
  assert.equal(amoy.publicSnapshot().testnet, true);
  assert.match(amoy.publicSnapshot().collateral_notice, /no real-world value/i);

  // A chain this build does not recognise as a test network must not be
  // described as one.
  const mainnet = new Capabilities({ room: { apiUrl: "http://x" }, chain: { chainId: 137 } });
  assert.equal(mainnet.publicSnapshot().testnet, false);
  assert.ok(
    !/no real-world value/.test(mainnet.publicSnapshot().collateral_notice),
    "a chain that is not a known test network must not be called valueless"
  );
});

test("settlement records are not claimed available when they are switched off", () => {
  // The service omits settlement records entirely without a participant
  // mapping — guessing which competitor is Outcome A would mislabel who won.
  // Reporting the capability as available on an API URL alone told every
  // reader a settlement record existed for a market that has none.
  const noMapping = new Capabilities({ room: { apiUrl: "http://x", roomId: "r" } });
  assert.equal(noMapping.get("settlement_api").available, false);
  assert.match(noMapping.get("settlement_api").reason, /participant/i);

  const mapped = new Capabilities({
    room: { apiUrl: "http://x", roomId: "r" },
    settlement: { participantKeys: { a: "alice", b: "bob" } },
  });
  assert.equal(mapped.get("settlement_api").available, true);

  // Half a mapping is not a mapping.
  const half = new Capabilities({
    room: { apiUrl: "http://x", roomId: "r" },
    settlement: { participantKeys: { a: "alice" } },
  });
  assert.equal(half.get("settlement_api").available, false);
});

test("a configured paymaster is not reported as unconfigured", async () => {
  // The mirror of the settlement_api defect: a capability saying "no" while
  // its dependency is present. The composition root built the paymaster config
  // without sponsoredKinds, so the one check that reads it could never pass —
  // an operator could set every documented variable, pay for a paymaster, and
  // have every user told "Gas sponsorship is not configured", with every
  // sponsorship request declined.
  //
  // This asserts the configuration is READ. It is not a claim that sponsorship
  // works: no paymaster credentials exist in this build and none have been
  // exercised against a bundler.
  const { buildService, configFromEnv } = await import("../src/app.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dataDir = mkdtempSync(join(tmpdir(), "tm-paymaster-"));
  try {
    const env = {
      TM_ROOM_ID: "room-1",
      TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
      TM_ROOM_API_URL: "http://127.0.0.1:8787",
      TM_RPC_URL: "http://127.0.0.1:9",
      TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
      TM_CHAIN_ID: "31337",
      TM_DATA_DIR: dataDir,
      TM_BUNDLER_URL: "https://bundler.example",
      TM_PAYMASTER_URL: "https://paymaster.example",
      TM_ENTRY_POINT: "0x0000000000000000000000000000000000000003",
      TM_PAYMASTER_POLICY_ID: "policy-1",
      TM_PAYMASTER_SPONSORED_KINDS: "predict,provide_liquidity",
    };
    const service = buildService(configFromEnv(env));
    const gas = service.capabilities.get("gas_sponsorship");
    assert.equal(gas.available, true, gas.reason);

    // And with the policy left empty it is still refused, for the real reason:
    // four endpoints that sponsor nothing are not sponsorship.
    const withoutKinds = buildService(configFromEnv({ ...env, TM_PAYMASTER_SPONSORED_KINDS: "" }));
    const refused = withoutKinds.capabilities.get("gas_sponsorship");
    assert.equal(refused.available, false);
    assert.match(refused.reason, /at least one action kind/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
