// Deployment preflight.
//
// A public deployment needs a funded signer, which is not something this repo
// can supply. Everything *around* that is checkable, and checking it before
// anyone spends is the difference between a deployment and a debugging session
// with real gas: are the addresses distinct, is the chain the one intended, is
// the collateral contract actually a contract, does each authority hold enough
// to act.
//
// It never sends a transaction. Its whole job is to say what would fail.

import test from "node:test";
import assert from "node:assert/strict";

import { preflight } from "../src/deploy/preflight.mjs";

const OK = {
  chainId: 80002,
  expectedChainId: 80002,
  usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
  usdcIsContract: true,
  balances: {
    deployer: 500_000_000_000_000_000n,
    gate: 200_000_000_000_000_000n,
    publisher: 200_000_000_000_000_000n,
    resolver1: 100_000_000_000_000_000n,
    resolver2: 100_000_000_000_000_000n,
    resolver3: 100_000_000_000_000_000n,
  },
  authorities: {
    gate: "0x0000000000000000000000000000000000000001",
    publisher: "0x0000000000000000000000000000000000000002",
    resolver1: "0x0000000000000000000000000000000000000003",
    resolver2: "0x0000000000000000000000000000000000000004",
    resolver3: "0x0000000000000000000000000000000000000005",
  },
  minimumWei: 50_000_000_000_000_000n,
};

test("a complete, funded, distinct setup passes", () => {
  const result = preflight(OK);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test("a chain that is not the intended one is blocking", () => {
  const result = preflight({ ...OK, chainId: 137 });
  assert.equal(result.ok, false);
  assert.match(result.blocking.join(" "), /chain 137.*80002|expected/i);
});

test("two authorities sharing an address is blocking, and named", () => {
  const shared = { ...OK.authorities, publisher: OK.authorities.gate };
  const result = preflight({ ...OK, authorities: shared });
  assert.equal(result.ok, false);
  // Publication needs the publisher role AND a gate signature; one key holding
  // both makes the pair meaningless.
  assert.match(result.blocking.join(" "), /gate.*publisher|publisher.*gate/i);
});

test("resolvers that are not three different addresses is blocking", () => {
  const shared = { ...OK.authorities, resolver2: OK.authorities.resolver1 };
  const result = preflight({ ...OK, authorities: shared });
  assert.equal(result.ok, false);
  assert.match(result.blocking.join(" "), /resolver/i);
});

test("an unfunded authority is named individually, not as a total", () => {
  const result = preflight({ ...OK, balances: { ...OK.balances, resolver2: 0n } });
  assert.equal(result.ok, false);
  assert.match(result.blocking.join(" "), /resolver2/);
  assert.ok(!result.blocking.join(" ").includes("resolver1"), "a funded signer is not reported as unfunded");
});

test("collateral that is not a contract is blocking", () => {
  const result = preflight({ ...OK, usdcIsContract: false });
  assert.equal(result.ok, false);
  assert.match(result.blocking.join(" "), /USDC|collateral/i);
});

test("the report separates what blocks from what is merely worth knowing", () => {
  const result = preflight({ ...OK, balances: { ...OK.balances, resolver3: 51_000_000_000_000_000n } });
  assert.equal(result.ok, true, "above the minimum is not blocking");
  assert.match(result.warnings.join(" "), /resolver3/, "but a thin balance is worth saying");
});

test("preflight never claims a deployment happened", () => {
  const result = preflight(OK);
  assert.ok(!/deployed|deployment succeeded/i.test(JSON.stringify(result)));
  assert.match(result.notice, /nothing was sent|no transaction/i);
});

test("an unreachable chain is reported as one, not as a stack trace", async () => {
  // The preflight exists so nobody spends on a deployment that was going to
  // fail. The most ordinary thing that goes wrong — the RPC endpoint is not
  // there — printed a viem stack trace naming a file inside node_modules. An
  // operator reading that has no idea whether their deployment is unsafe or
  // their URL is a typo.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const run = promisify(execFile);
  const result = await run("node", ["--no-warnings", join(here, "..", "scripts", "preflight.mjs")], {
    env: { ...process.env, TM_RPC_URL: "http://127.0.0.1:9", TM_EXPECTED_CHAIN_ID: "80002" },
  }).catch((error) => error);

  assert.equal(result.code, 1, "a preflight that could not run must not exit 0");
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /127\.0\.0\.1:9/, "it has to name the endpoint it could not reach");
  assert.ok(!output.includes("node_modules"), "and must not answer with a library's internals");
  assert.ok(!/\n\s+at /.test(output), "or with a stack trace");
});

// The adjudicator and the connector were absent from MUST_DIFFER entirely, so
// a deployment could hand one key two powers that exist to constrain each
// other and the preflight would call it ready.
test("the adjudicator is checked against every other authority", () => {
  for (const role of ["gate", "publisher", "resolver1", "resolver2", "resolver3"]) {
    const result = preflight({
      ...OK,
      authorities: { ...OK.authorities, adjudicator: OK.authorities[role] },
    });
    assert.equal(result.ok, false, `adjudicator sharing ${role} must block`);
    assert.ok(
      result.blocking.some((line) => line.includes("adjudicator") && line.includes(role)),
      `the block must name adjudicator and ${role}; got ${JSON.stringify(result.blocking)}`
    );
  }
});

// ADR 0024 requires each resolver to rebuild the result from raw provider bytes
// independently. A resolver holding the connector's key attests facts it signed
// itself, which is not a reconstruction and not independent — and it is exactly
// the kind of thing that looks fine until a disputed settlement.
test("the connector is checked against every resolver and authority", () => {
  for (const role of ["gate", "publisher", "resolver1", "resolver2", "resolver3"]) {
    const result = preflight({
      ...OK,
      authorities: { ...OK.authorities, connector: OK.authorities[role] },
    });
    assert.equal(result.ok, false, `connector sharing ${role} must block`);
    assert.ok(
      result.blocking.some((line) => line.includes("connector") && line.includes(role)),
      `the block must name connector and ${role}; got ${JSON.stringify(result.blocking)}`
    );
  }
});

// A setup that names them and keeps them distinct is still ready.
test("distinct adjudicator and connector addresses do not block", () => {
  const result = preflight({
    ...OK,
    authorities: {
      ...OK.authorities,
      adjudicator: "0x0000000000000000000000000000000000000006",
      connector: "0x0000000000000000000000000000000000000007",
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.blocking));
});
