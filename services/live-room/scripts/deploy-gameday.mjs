// Deploys a complete Live Room to a local chain and exposes the operations the
// game day drives. Reads artifacts straight out of `contracts/out`, so the
// bytecode under test is the bytecode `forge build` just produced.

import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_OUT = join(HERE, "..", "..", "..", "contracts", "out");

/** Anvil's deterministic accounts, one per authority domain. */
export const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  gate: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  publisher: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  participantA: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  participantB: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  lp: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  trader: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  keeper: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  resolver1: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  resolver2: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  resolver3: "0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897",
  connector: "0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82",
};

export function account(name) {
  return privateKeyToAccount(ANVIL_KEYS[name]);
}

function artifact(name, contract = name) {
  const path = join(CONTRACTS_OUT, `${name}.sol`, `${contract}.json`);
  if (!existsSync(path)) {
    throw new Error(`Missing artifact ${path}. Run \`forge build\` in contracts/ first.`);
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

export const ARTIFACTS = {
  market: () => artifact("LivePredictionMarket"),
  room: () => artifact("LiveRoom"),
  factory: () => artifact("LiveMarketFactory"),
  commitments: () => artifact("RoomLiquidityCommitments"),
  usdc: () => artifact("MockUSDC"),
};

export function clients(rpc) {
  const publicClient = createPublicClient({ chain: foundry, transport: http(rpc) });
  const wallet = (name) => createWalletClient({ account: account(name), chain: foundry, transport: http(rpc) });
  return { publicClient, wallet };
}

async function deploy(publicClient, wallet, { abi, bytecode }, args = []) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("deployment reverted");
  return receipt.contractAddress;
}

async function send(publicClient, wallet, address, abi, functionName, args = []) {
  const { request } = await publicClient.simulateContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
  return receipt;
}

/** Advances the chain clock. Anvil only; the game day is a local exercise. */
export async function setChainTime(rpc, targetSeconds) {
  const call = async (method, params) => {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  try {
    await call("evm_setNextBlockTimestamp", [Math.floor(targetSeconds)]);
  } catch (error) {
    // The game day re-times a recorded session onto the chain clock, so it
    // needs a chain whose clock has not already been pushed past the session.
    // Running twice against the same anvil fails here with a raw RPC message
    // that reads like a protocol bug; say what it actually is.
    if (/lower than previous block/.test(error.message)) {
      throw new Error(
        `${error.message}\n\n` +
          "The chain clock is already ahead of this session. The game day replays a recorded " +
          "session onto chain time and needs a chain that has not run one before. Restart anvil " +
          "and run it again."
      );
    }
    throw error;
  }
  await call("evm_mine", []);
}

/**
 * Deploys USDC, the implementations, the factory, the commitments router, and
 * one armed LiveRoom with both Integrity Bonds posted.
 */
export async function deployGamedayRoom({ rpc, fixture }) {
  const { publicClient, wallet } = clients(rpc);
  const deployer = wallet("deployer");

  const usdcArtifact = ARTIFACTS.usdc();
  const marketArtifact = ARTIFACTS.market();
  const roomArtifact = ARTIFACTS.room();
  const factoryArtifact = ARTIFACTS.factory();
  const commitmentsArtifact = ARTIFACTS.commitments();

  const usdc = await deploy(publicClient, deployer, usdcArtifact);
  const marketImplementation = await deploy(publicClient, deployer, marketArtifact);
  const roomImplementation = await deploy(publicClient, deployer, roomArtifact);
  const factory = await deploy(publicClient, deployer, factoryArtifact, [
    usdc,
    deployer.account.address,
    marketImplementation,
    roomImplementation,
  ]);
  const commitments = await deploy(publicClient, deployer, commitmentsArtifact, [usdc]);

  // Fund every actor with test USDC and gas.
  const funded = ["participantA", "participantB", "lp", "trader", "keeper"];
  for (const name of funded) {
    await send(publicClient, deployer, usdc, usdcArtifact.abi, "mint", [
      account(name).address,
      1_000_000n * 10n ** 6n,
    ]);
  }

  const templates = [
    { templateId: toBytes32("tpl-participant-v1"), winnerRewardBps: 100 },
    { templateId: toBytes32("tpl-threshold-v1"), winnerRewardBps: 0 },
    { templateId: toBytes32("tpl-race-v1"), winnerRewardBps: 100 },
  ];
  const roomConfig = {
    roomId: toBytes32(fixture.room_id),
    headlineTemplateId: toBytes32("tpl-participant-v1"),
    gateSigner: account("gate").address,
    publisher: account("publisher").address,
    integrityAdjudicator: account("keeper").address,
    participantA: account("participantA").address,
    participantB: account("participantB").address,
    rewardAddressA: account("participantA").address,
    rewardAddressB: account("participantB").address,
    bondRecipient: account("deployer").address,
    liquidityRouter: commitments,
    resolvers: [account("resolver1").address, account("resolver2").address, account("resolver3").address],
    epochDuration: BigInt(fixture.epoch_duration_s),
    sourceFinalityDelay: BigInt(fixture.finality_delay_s),
    maxPendingTime: BigInt(fixture.max_pending_time_s),
    challengeWindow: 600n,
    challengeTimeout: 1800n,
    minAnnounceDelay: BigInt(fixture.announce_delay_s),
    maxPermitLifetime: 300n,
    integrityClaimWindow: 3600n,
    integrityClaimTimeout: 3600n,
    // Permissionless recovery if the gate key is ever lost: without it every
    // bond and position in the room would be unclaimable forever.
    gateStallTimeout: 21600n,
    maxOpenSlots: 4,
    participantAName: "Alice",
    participantBName: "Bob",
    templates,
    restrictedWallets: [],
  };
  const receipt = await send(publicClient, deployer, factory, factoryArtifact.abi, "createRoom", [roomConfig]);
  const room = await publicClient.readContract({
    address: factory,
    abi: factoryArtifact.abi,
    functionName: "roomById",
    args: [roomConfig.roomId],
  });

  // Both Participants post their room bond once, for the whole session.
  for (const name of ["participantA", "participantB"]) {
    const signer = wallet(name);
    await send(publicClient, signer, usdc, usdcArtifact.abi, "approve", [room, 100n * 10n ** 6n]);
    await send(publicClient, signer, room, roomArtifact.abi, "postIntegrityBond", []);
  }

  return {
    publicClient,
    wallet,
    rpc,
    usdc,
    factory,
    room,
    commitments,
    marketImplementation,
    roomImplementation,
    deployBlock: Number(receipt.blockNumber),
    abis: {
      usdc: usdcArtifact.abi,
      market: marketArtifact.abi,
      room: roomArtifact.abi,
      factory: factoryArtifact.abi,
      commitments: commitmentsArtifact.abi,
    },
    send: (signerName, address, abi, fn, args) => send(publicClient, wallet(signerName), address, abi, fn, args),
  };
}

export function toBytes32(text) {
  const hex = Buffer.from(text, "utf8").toString("hex");
  if (hex.length > 64) throw new Error(`too long for bytes32: ${text}`);
  return `0x${hex.padEnd(64, "0")}`;
}

export function fromBytes32(value) {
  return Buffer.from(value.slice(2), "hex").toString("utf8").replace(/\0+$/, "");
}
