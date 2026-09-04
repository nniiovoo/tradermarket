// The signing port and its selector allow-list.
//
// Issue 05 required both and was marked resolved with neither. These tests pin
// the two properties that make the port worth having: every operator signs
// through one seam, and that seam refuses a call the role has no business
// making — so a stolen gate key cannot be used to publish a market, and a stolen
// publisher key cannot be used to close a room.

import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector } from "viem";

import { createSigner, selectorsFor, ROLE_SELECTORS, SelectorNotAllowed } from "../src/ports/signer.mjs";
import { LIVE_ROOM_ABI, MARKET_ABI } from "../src/ports/chain-viem.mjs";

const KEY = generatePrivateKey();
const toSelector = (entry) => toFunctionSelector(entry);

function selectorOf(abi, name) {
  const entry = abi.find((item) => item.type === "function" && item.name === name);
  assert.ok(entry, `${name} exists in the ABI`);
  return toFunctionSelector(entry);
}

test("a signer keeps the address its key derives, whatever adapter produced it", () => {
  const signer = createSigner({ role: "gate", privateKey: KEY });
  assert.equal(signer.address, privateKeyToAccount(KEY).address);
});

test("every role's allow-list names only functions this build actually compiled", () => {
  // The guard against a tightened allow-list quietly becoming an open one: a
  // renamed function must fail here, not silently drop out of the set.
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  for (const role of Object.keys(ROLE_SELECTORS)) {
    const selectors = selectorsFor(role, abi, { toSelector });
    assert.equal(
      selectors.size,
      ROLE_SELECTORS[role].length,
      `${role}: every named function must resolve to a selector`
    );
  }
});

test("a name that is not in the ABI is a startup failure, not a silently smaller allow-list", () => {
  assert.throws(
    () => selectorsFor("gate", [{ type: "function", name: "somethingElse", inputs: [], outputs: [] }], { toSelector }),
    /not a function in the ABI/
  );
});

test("the gate signer refuses to sign a publication", async () => {
  // The whole point. Publication needs the publisher role AND a gate signature;
  // a gate key that can also sign publishSlot collapses that pair if stolen.
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  const signer = createSigner({
    role: "gate",
    privateKey: KEY,
    allowedSelectors: selectorsFor("gate", abi, { toSelector }),
  });

  const publish = selectorOf(LIVE_ROOM_ABI, "publishSlot");
  await assert.rejects(
    () => signer.signTransaction({ to: "0x0000000000000000000000000000000000000001", data: publish, chainId: 31337 }),
    SelectorNotAllowed
  );
});

test("the gate signer does sign the calls a gate is for", async () => {
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  const signer = createSigner({
    role: "gate",
    privateKey: KEY,
    allowedSelectors: selectorsFor("gate", abi, { toSelector }),
  });

  const safe = selectorOf(LIVE_ROOM_ABI, "markRoomEpochsSafe");
  const signed = await signer.signTransaction({
    to: "0x0000000000000000000000000000000000000001",
    data: safe,
    chainId: 31337,
    nonce: 0,
    gas: 100000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
  });
  assert.match(signed, /^0x[0-9a-f]+$/i);
});

test("a bare value transfer is refused, because none of these roles sends one", async () => {
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  const signer = createSigner({
    role: "publisher",
    privateKey: KEY,
    allowedSelectors: selectorsFor("publisher", abi, { toSelector }),
  });
  await assert.rejects(
    () => signer.signTransaction({ to: "0x0000000000000000000000000000000000000002", value: 1n, chainId: 31337 }),
    SelectorNotAllowed
  );
});

test("the connector signs no transaction at all, and that is a rule rather than an omission", async () => {
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  assert.deepEqual(ROLE_SELECTORS.connector, []);
  const signer = createSigner({
    role: "connector",
    privateKey: KEY,
    allowedSelectors: selectorsFor("connector", abi, { toSelector }),
  });
  const safe = selectorOf(LIVE_ROOM_ABI, "markRoomEpochsSafe");
  await assert.rejects(
    () => signer.signTransaction({ to: "0x0000000000000000000000000000000000000001", data: safe, chainId: 31337 }),
    SelectorNotAllowed
  );
});

test("the connector can still sign the event log, which is the only thing it signs", async () => {
  const abi = [...LIVE_ROOM_ABI, ...MARKET_ABI];
  const signer = createSigner({
    role: "connector",
    privateKey: KEY,
    allowedSelectors: selectorsFor("connector", abi, { toSelector }),
  });
  const signature = await signer.signMessage({ message: "a source fact" });
  assert.match(signature, /^0x[0-9a-f]+$/i);
});
