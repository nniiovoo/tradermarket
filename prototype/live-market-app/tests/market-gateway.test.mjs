import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

globalThis.__VITE_ENV__ = {};
register(new URL("./helpers/jsx-loader.mjs", import.meta.url), pathToFileURL("./"));

const {
  confirmTransaction,
  createMarketGateway,
} = await import("../src/web3/marketGateway.js");

const MARKET_A = "0x1111111111111111111111111111111111111111";
const MARKET_B = "0x2222222222222222222222222222222222222222";
const ROOM = "0x3333333333333333333333333333333333333333";
const USDC = "0x4444444444444444444444444444444444444444";
const ACCOUNT = "0x5555555555555555555555555555555555555555";
const HASH = `0x${"a".repeat(64)}`;
const REPLACEMENT_HASH = `0x${"b".repeat(64)}`;

function successfulReceipt(transactionHash = HASH) {
  return { status: "success", transactionHash };
}

test("a reverted receipt is never reported as a confirmed market action", async () => {
  const client = {
    waitForTransactionReceipt: async () => ({ status: "reverted", transactionHash: HASH }),
  };

  await assert.rejects(
    confirmTransaction(client, HASH),
    /reverted|failed/i
  );
});

test("a wallet cancellation is not mistaken for the original market action", async () => {
  const client = {
    waitForTransactionReceipt: async ({ onReplaced }) => {
      onReplaced({
        reason: "cancelled",
        transactionReceipt: successfulReceipt(REPLACEMENT_HASH),
      });
      return successfulReceipt(REPLACEMENT_HASH);
    },
  };

  await assert.rejects(
    confirmTransaction(client, HASH),
    /cancelled/i
  );
});

test("a repriced transaction returns the hash that actually confirmed", async () => {
  const client = {
    waitForTransactionReceipt: async ({ onReplaced }) => {
      onReplaced({
        reason: "repriced",
        transactionReceipt: successfulReceipt(REPLACEMENT_HASH),
      });
      return successfulReceipt(REPLACEMENT_HASH);
    },
  };

  const result = await confirmTransaction(client, HASH);
  assert.equal(result.hash, REPLACEMENT_HASH);
  assert.equal(result.replacement.reason, "repriced");
});

test("market reads use the selected room market rather than the build-time address", async () => {
  const seen = [];
  const publicClient = {
    getBytecode: async ({ address }) => {
      seen.push(["bytecode", address]);
      return "0x01";
    },
    multicall: async ({ contracts }) => {
      seen.push(...contracts.map((call) => [call.functionName, call.address]));
      return [
        "Will A win?", "A", "B", "", "",
        ACCOUNT, MARKET_A, ACCOUNT, MARKET_A,
        0, 0, 0n, 60n, false, 0,
        1_000_000n, 1_000_000n, 1_000_000n, 0n, 100,
        1_000_000n, 1n, 9n,
      ];
    },
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({ writeContract: async () => HASH }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });

  const snapshot = await gateway.loadMarketSnapshot(undefined, { marketAddress: MARKET_B });

  assert.equal(snapshot.marketAddress, MARKET_B);
  assert.ok(seen.length > 5);
  assert.ok(seen.every(([, address]) => address === MARKET_B));
});

test("market writes and USDC approvals target the selected room market", async () => {
  const writes = [];
  const publicClient = {
    readContract: async ({ functionName }) => functionName === "allowance" ? 0n : 0n,
    waitForTransactionReceipt: async ({ hash }) => successfulReceipt(hash),
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({
      writeContract: async (request) => {
        writes.push(request);
        return writes.length === 1 ? HASH : REPLACEMENT_HASH;
      },
    }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });
  const snapshot = {
    reserveA: 1_000_000_000n,
    reserveB: 1_000_000_000n,
    winnerRewardBps: 100,
  };

  const result = await gateway.submitPrediction(
    ACCOUNT,
    snapshot,
    "YES",
    25,
    { marketAddress: MARKET_B }
  );

  assert.equal(writes[0].address, USDC);
  assert.deepEqual(writes[0].args, [MARKET_B, 25_000_000n]);
  assert.equal(writes[1].address, MARKET_B);
  assert.equal(writes[1].functionName, "submitBuy");
  assert.equal(result.hash, REPLACEMENT_HASH);
});

test("room bonds read, approve, post and claim against LiveRoom", async () => {
  const writes = [];
  const publicClient = {
    multicall: async ({ contracts }) => {
      assert.ok(contracts.every((call) => call.address === ROOM));
      assert.deepEqual(contracts.map((call) => call.functionName), ["ROOM_INTEGRITY_BOND", "integrityBondOf"]);
      return [100_000_000n, 0n];
    },
    readContract: async ({ address, functionName, args }) => {
      if (functionName === "ROOM_INTEGRITY_BOND") {
        assert.equal(address, ROOM);
        return 100_000_000n;
      }
      assert.equal(functionName, "allowance");
      assert.equal(address, USDC);
      assert.deepEqual(args, [ACCOUNT, ROOM]);
      return 0n;
    },
    waitForTransactionReceipt: async ({ hash }) => successfulReceipt(hash),
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({
      writeContract: async (request) => {
        writes.push(request);
        return `0x${String(writes.length).padStart(64, "0")}`;
      },
    }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });

  const bond = await gateway.loadParticipantBondSnapshot(ACCOUNT, { roomAddress: ROOM });
  assert.deepEqual(bond, {
    mode: "room",
    targetAddress: ROOM,
    requiredBond: 100_000_000n,
    postedBond: 0n,
  });

  await gateway.postParticipantBond(ACCOUNT, { roomAddress: ROOM });
  assert.equal(writes[0].address, USDC);
  assert.deepEqual(writes[0].args, [ROOM, 100_000_000n]);
  assert.equal(writes[1].address, ROOM);
  assert.equal(writes[1].functionName, "postIntegrityBond");

  await gateway.claimParticipantBond(ACCOUNT, { roomAddress: ROOM });
  assert.equal(writes[2].address, ROOM);
  assert.equal(writes[2].functionName, "claimIntegrityBond");
});

test("standalone bond behavior remains on the configured market", async () => {
  const writes = [];
  const publicClient = {
    readContract: async ({ address, functionName, args }) => {
      if (functionName === "INTEGRITY_BOND") {
        assert.equal(address, MARKET_A);
        return 100_000_000n;
      }
      assert.equal(functionName, "allowance");
      assert.deepEqual(args, [ACCOUNT, MARKET_A]);
      return 0n;
    },
    waitForTransactionReceipt: async ({ hash }) => successfulReceipt(hash),
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({
      writeContract: async (request) => {
        writes.push(request);
        return HASH;
      },
    }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });

  const result = await gateway.postParticipantBond(ACCOUNT);
  assert.equal(result.mode, "standalone");
  assert.deepEqual(writes[0].args, [MARKET_A, 100_000_000n]);
  assert.equal(writes[1].address, MARKET_A);
});

test("resolver writes bind the selected market to the exact evidence hash", async () => {
  const writes = [];
  const publicClient = {
    waitForTransactionReceipt: async ({ hash }) => successfulReceipt(hash),
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({
      writeContract: async (request) => {
        writes.push(request);
        return HASH;
      },
    }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });
  const evidenceHash = `0x${"c".repeat(64)}`;

  await gateway.submitResolutionAction(
    ACCOUNT,
    "attestResult",
    { outcome: 1, evidenceHash },
    { marketAddress: MARKET_B }
  );
  await gateway.submitResolutionAction(
    ACCOUNT,
    "attestChallengeVerdict",
    { acceptChallenge: true },
    { marketAddress: MARKET_B }
  );
  await gateway.submitResolutionAction(ACCOUNT, "finalizeUnchallenged", {}, { marketAddress: MARKET_B });
  await gateway.submitResolutionAction(ACCOUNT, "closeForDecisiveEvent", { sourceSequence: 42 }, { marketAddress: MARKET_B });

  assert.deepEqual(
    writes.map(({ address, functionName, args }) => ({ address, functionName, args })),
    [
      { address: MARKET_B, functionName: "attestResult", args: [1, evidenceHash] },
      { address: MARKET_B, functionName: "attestChallengeVerdict", args: [true] },
      { address: MARKET_B, functionName: "finalizeUnchallenged", args: [] },
      { address: MARKET_B, functionName: "closeForDecisiveEvent", args: [42n] },
    ]
  );
});

test("a result challenge returns the exact evidence hash needed for public review registration", async () => {
  const writes = [];
  const publicClient = {
    readContract: async ({ functionName }) => functionName === "CHALLENGE_BOND" ? 10_000_000n : 10_000_000n,
    waitForTransactionReceipt: async ({ hash }) => successfulReceipt(hash),
  };
  const gateway = createMarketGateway({
    publicClient,
    walletClientFor: async () => ({ writeContract: async (request) => { writes.push(request); return HASH; } }),
    defaultMarketAddress: MARKET_A,
    usdcAddress: USDC,
  });
  const reference = "https://evidence.example/earlier-appearance.json";
  const result = await gateway.submitResultChallenge(ACCOUNT, reference, { marketAddress: MARKET_B });
  assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
  assert.equal(writes.at(-1).functionName, "challengeResult");
  assert.equal(writes.at(-1).args[0], result.evidenceHash);
});

test("the React hook exposes market selection and room-bond targets to the app", () => {
  const marketHook = readFileSync(new URL("../src/web3/useTestnetMarket.js", import.meta.url), "utf8");
  const roomHook = readFileSync(new URL("../src/web3/useLiveRoom.js", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.match(marketHook, /selectMarket/);
  assert.match(marketHook, /loadParticipantBondSnapshot/);
  assert.match(marketHook, /roomAddress/);
  assert.match(roomHook, /live_room_address/);
  assert.match(roomHook, /roomAddress/);
  assert.match(app, /testnet\.selectMarket\(/, "the selected room child must be loaded into the wallet gateway");
  assert.match(app, /testnet\.snapshot\?\.marketAddress/, "the UI must bind actions to the snapshot it actually read");
  assert.match(app, /testnet\.readBond\(\{ roomAddress:/, "room bond state must come from LiveRoom");
  assert.match(app, /testnet\.postBond\(\{ roomAddress:/, "room bond posting must target LiveRoom");
});
