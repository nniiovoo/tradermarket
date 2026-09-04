// P0: a real paymaster abstraction that never pretends sponsorship exists.
//
// The point of this module is what it REFUSES to do. Until a bundler, a
// paymaster, an entry point, and a policy all exist, every request for
// sponsorship is declined with a reason, and the caller is told plainly that
// the user pays their own gas. Nothing here fabricates a sponsorship result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GasPolicy, UnconfiguredPaymaster, HttpPaymaster, createPaymaster } from "../src/paymaster/paymaster.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";

const ACTION = { account: "0xUSER", market: "0xM0", kind: "buy", amount: "100000000" };

test("an unconfigured deployment declines sponsorship and says who pays", async () => {
  const paymaster = createPaymaster({ capabilities: new Capabilities({}) });
  assert.ok(paymaster instanceof UnconfiguredPaymaster);
  assert.equal(paymaster.available, false);

  const quote = await paymaster.sponsor(ACTION);
  assert.equal(quote.sponsored, false);
  assert.match(quote.reason, /not configured/i);
  assert.match(quote.payer, /user/i);
  assert.equal(quote.userOperation, null, "nothing is fabricated");
});

test("createPaymaster refuses a partially configured provider rather than degrading quietly", () => {
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p" }, // no entry point, no policy
  });
  const paymaster = createPaymaster({ capabilities });
  assert.equal(paymaster.available, false);
  assert.match(paymaster.reason, /entry point|policy/i);
});

test("a configured provider produces a sponsorship request, not a promise", async () => {
  const calls = [];
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p", entryPoint: "0xEP", policyId: "pol", sponsoredKinds: ["predict"] },
  });
  const paymaster = createPaymaster({
    capabilities,
    transport: async (url, body) => {
      calls.push({ url, body });
      return { result: { paymasterAndData: "0xdeadbeef", preVerificationGas: "0x1" } };
    },
    policy: new GasPolicy({ allowedKinds: ["buy"], maxSponsoredWeiPerAction: 10n ** 15n }),
  });
  assert.ok(paymaster instanceof HttpPaymaster);
  assert.equal(paymaster.available, true);

  const quote = await paymaster.sponsor(ACTION);
  assert.equal(quote.sponsored, true);
  assert.equal(quote.payer, "paymaster");
  assert.equal(quote.userOperation.paymasterAndData, "0xdeadbeef");
  assert.equal(calls.length, 1, "the provider was actually asked");
});

test("the policy is enforced before the provider is asked", async () => {
  const calls = [];
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p", entryPoint: "0xEP", policyId: "pol", sponsoredKinds: ["predict"] },
  });
  const paymaster = createPaymaster({
    capabilities,
    transport: async (url, body) => {
      calls.push({ url, body });
      return { result: {} };
    },
    policy: new GasPolicy({ allowedKinds: ["buy"], maxSponsoredWeiPerAction: 1n }),
  });

  const wrongKind = await paymaster.sponsor({ ...ACTION, kind: "liquidity" });
  assert.equal(wrongKind.sponsored, false);
  assert.match(wrongKind.reason, /not covered/i);
  assert.equal(calls.length, 0, "a policy rejection never reaches the provider");

  const tooExpensive = await paymaster.sponsor({ ...ACTION, estimatedGasWei: 10n ** 18n });
  assert.equal(tooExpensive.sponsored, false);
  assert.match(tooExpensive.reason, /exceeds/i);
});

test("a provider failure declines rather than claiming success", async () => {
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p", entryPoint: "0xEP", policyId: "pol", sponsoredKinds: ["predict"] },
  });
  const paymaster = createPaymaster({
    capabilities,
    transport: async () => {
      throw new Error("paymaster 503");
    },
    policy: new GasPolicy({ allowedKinds: ["buy"] }),
  });
  const quote = await paymaster.sponsor(ACTION);
  assert.equal(quote.sponsored, false);
  assert.match(quote.reason, /503|unavailable/i);
  assert.match(quote.payer, /user/i, "the user must be told they now pay");
});

test("a provider that returns no paymaster data is not treated as sponsorship", async () => {
  const capabilities = new Capabilities({
    paymaster: { bundlerUrl: "https://b", paymasterUrl: "https://p", entryPoint: "0xEP", policyId: "pol", sponsoredKinds: ["predict"] },
  });
  const paymaster = createPaymaster({
    capabilities,
    transport: async () => ({ result: {} }),
    policy: new GasPolicy({ allowedKinds: ["buy"] }),
  });
  const quote = await paymaster.sponsor(ACTION);
  assert.equal(quote.sponsored, false);
  assert.match(quote.reason, /no paymaster data/i);
});

test("the abstraction is provider-agnostic: no vendor name is hard-coded", async () => {
  const source = (await import("node:fs")).readFileSync(
    new URL("../src/paymaster/paymaster.mjs", import.meta.url),
    "utf8"
  );
  for (const vendor of ["alchemy", "pimlico", "stackup", "biconomy", "coinbase", "thirdweb"]) {
    assert.ok(!new RegExp(vendor, "i").test(source), `must not hard-code ${vendor}`);
  }
});

test("a declined quote never carries a user operation", async () => {
  const paymaster = createPaymaster({ capabilities: new Capabilities({}) });
  for (const action of [ACTION, { ...ACTION, kind: "sell" }, { ...ACTION, amount: "0" }]) {
    const quote = await paymaster.sponsor(action);
    assert.equal(quote.sponsored, false);
    assert.equal(quote.userOperation, null);
  }
});

test("a paymaster with no policy sponsors nothing, and does not claim otherwise", () => {
  // `policy ?? new GasPolicy({})` has an empty allowedKinds set, so every
  // action is declined — while gasStatement() announces "Gas is sponsored for
  // eligible actions under the configured paymaster policy". A deployment with
  // all four credentials and no policy tells every reader it sponsors and
  // sponsors none of them.
  const configured = new Capabilities({
    room: { apiUrl: "http://x" },
    paymaster: { bundlerUrl: "http://b", paymasterUrl: "http://p", entryPoint: "0xEP", policyId: "pol" },
  });

  assert.equal(configured.get("gas_sponsorship").available, false, "a policy that covers nothing is not sponsorship");
  assert.match(configured.get("gas_sponsorship").reason, /policy/i);
  assert.ok(
    !/is sponsored/.test(configured.gasStatement()),
    `the statement must not announce sponsorship: ${configured.gasStatement()}`
  );

  const withPolicy = new Capabilities({
    room: { apiUrl: "http://x" },
    paymaster: {
      bundlerUrl: "http://b",
      paymasterUrl: "http://p",
      entryPoint: "0xEP",
      policyId: "pol",
      sponsoredKinds: ["predict"],
    },
  });
  assert.equal(withPolicy.get("gas_sponsorship").available, true);
});

test("createPaymaster builds the policy the capability was checked against", async () => {
  const capabilities = new Capabilities({
    room: { apiUrl: "http://x" },
    paymaster: {
      bundlerUrl: "http://b",
      paymasterUrl: "http://p",
      entryPoint: "0xEP",
      policyId: "pol",
      sponsoredKinds: ["predict"],
    },
  });
  const paymaster = createPaymaster({
    capabilities,
    transport: async () => ({ result: { paymasterAndData: "0xabc" } }),
  });

  const covered = await paymaster.sponsor({ account: "0xA", kind: "predict", estimatedGasWei: 1n });
  assert.equal(covered.sponsored, true, "a kind the policy covers is sponsored");

  const uncovered = await paymaster.sponsor({ account: "0xA", kind: "claim", estimatedGasWei: 1n });
  assert.equal(uncovered.sponsored, false);
  assert.match(uncovered.reason, /not covered/i);
});
