// Configuration validation and secret-safe startup (Phase 1).
//
// Every numeric setting was read with `Number(env.X)` and no check, so a typo
// produced NaN or a negative and the service started anyway. The failures that
// causes are not cosmetic:
//
//   TM_CHAIN_ID=eleven      -> chainId NaN. Every transaction is signed for a
//                              chain that does not exist and rejected by the
//                              node — which from outside looks like a broken RPC
//                              rather than a typo, the exact confusion the chain
//                              port's own comments describe.
//   TM_CHAT_RATE_LIMIT=abc  -> NaN. Every `count > limit` comparison is false,
//                              so rate limiting is silently OFF.
//   TM_POLL_MS=-500         -> a negative interval fires continuously and
//                              hammers the RPC endpoint.
//   TM_PORT=not-a-port      -> listen(NaN).
//
// A service that refuses to start is an outage someone fixes in a minute. A
// service that starts misconfigured is an incident nobody attributes correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { configFromEnv } from "../src/app.mjs";

const BASE = {
  TM_ROOM_ID: "room-1",
  TM_ROOM_ADDRESS: "0x0000000000000000000000000000000000000001",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x0000000000000000000000000000000000000002",
};

test("a valid configuration still reads exactly as before", () => {
  const config = configFromEnv({ ...BASE, TM_PORT: "9000", TM_CHAIN_ID: "80002", TM_POLL_MS: "5000" });
  assert.equal(config.port, 9000);
  assert.equal(config.chainId, 80002);
  assert.equal(config.pollMs, 5000);
});

test("defaults still apply when a setting is absent", () => {
  const config = configFromEnv(BASE);
  assert.equal(config.port, 8787);
  assert.equal(config.pollMs, 4000);
  assert.equal(config.chainId, null, "an unset chain id is null, not zero");
});

test("a non-numeric chain id is refused rather than signed as NaN", () => {
  assert.throws(
    () => configFromEnv({ ...BASE, TM_CHAIN_ID: "eleven" }),
    /TM_CHAIN_ID/,
    "signing for chain NaN means every transaction is rejected, and it reads as a broken RPC"
  );
});

test("a non-numeric port is refused rather than passed to listen()", () => {
  assert.throws(() => configFromEnv({ ...BASE, TM_PORT: "not-a-port" }), /TM_PORT/);
});

test("a rate limit that is not a number is refused, because NaN disables the limit", () => {
  // Every `count > NaN` is false. The limit does not become large, it stops
  // existing — and nothing in the running service would say so.
  assert.throws(() => configFromEnv({ ...BASE, TM_CHAT_RATE_LIMIT: "abc" }), /TM_CHAT_RATE_LIMIT/);
});

test("a negative or zero poll interval is refused", () => {
  assert.throws(() => configFromEnv({ ...BASE, TM_POLL_MS: "-500" }), /TM_POLL_MS/);
  assert.throws(() => configFromEnv({ ...BASE, TM_POLL_MS: "0" }), /TM_POLL_MS/);
});

test("the error names the variable and what it was given", () => {
  // An operator reading a startup failure has to be able to fix it without
  // reading the source.
  try {
    configFromEnv({ ...BASE, TM_CHAIN_ID: "eleven" });
    assert.fail("expected a throw");
  } catch (error) {
    assert.match(error.message, /TM_CHAIN_ID/, "names the variable");
    assert.match(error.message, /eleven/, "and shows what it was given");
  }
});

test("no configuration error ever quotes a secret's value", () => {
  // The counterpart to naming the value: a message that helpfully echoes what
  // it was given must never do so for a key. Startup errors reach logs, and
  // logs reach places keys must not.
  const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  for (const variable of ["TM_GATE_KEY", "TM_PUBLISHER_KEY", "TM_RESOLVER_KEY", "TM_CONNECTOR_KEY"]) {
    try {
      configFromEnv({ ...BASE, [variable]: key, TM_PORT: "not-a-port" });
    } catch (error) {
      assert.ok(!error.message.includes(key), `${variable}'s value must not appear in a startup error`);
    }
  }
});
