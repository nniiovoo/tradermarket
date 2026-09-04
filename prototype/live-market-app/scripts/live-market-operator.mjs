import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const rpcUrl = process.env.AMOY_RPC_URL || "https://polygon-amoy.drpc.org";
const market = process.env.MARKET_ADDRESS || process.env.VITE_MARKET_ADDRESS;
const roomAddress = process.env.ROOM_ADDRESS;
const explorer = "https://amoy.polygonscan.com";
const chain = {
  id: 80002,
  name: "Polygon Amoy",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "PolygonScan", url: explorer } },
  testnet: true,
};

const roomAbi = parseAbi([
  "function slots() view returns (address[])",
  "function lastObservedSequence() view returns (uint256)",
  "function roomClosedSequence() view returns (uint256)",
  "function openSlotCount() view returns (uint256)",
  "function markRoomEpochsSafe(uint256 sourceSequence,address[] markets,uint64[] epochs)",
  "function suspendRoom(uint256 sourceSequence)",
  "function reopenRoom(uint256 sourceSequence)",
  "function closeSlots(uint256 decisiveSequence,address[] markets)",
  "function closeRoom(uint256 decisiveSequence)",
  "function closeRemainingSlots(address[] markets)",
  "function processRoom(address[] markets,uint64[] epochs,uint256 maxActions)",
]);

const abi = parseAbi([
  "function question() view returns (string)",
  "function gateState() view returns (uint8)",
  "function finalOutcome() view returns (uint8)",
  "function currentEpoch() view returns (uint64)",
  "function lastSafeSequence() view returns (uint256)",
  "function reserveA() view returns (uint256)",
  "function reserveB() view returns (uint256)",
  "function pendingCollateral() view returns (uint256)",
  "function markEpochSafe(uint64 epoch,uint256 sourceSequence)",
  "function processEpoch(uint64 epoch,uint256 maximumActions) returns (uint256)",
  "function suspendGate(uint256 sourceSequence)",
  "function reopenGate(uint256 sourceSequence)",
  "function closeForDecisiveEvent(uint256 sourceSequence)",
  "function attestResult(uint8 outcome,bytes32 evidenceHash)",
  "function attestChallengeVerdict(bool acceptChallenge)",
  "function finalizeUnchallenged()",
  "function expireChallenge()",
  "function invalidateUnresolved()",
]);

function usage() {
  console.log(`Live Market testnet operator

BREAK GLASS ONLY for a Live Room. A room is driven by the Source Gate
Authority service (services/live-room), which evaluates frozen conditions over
the Session Event Log. Room-bound markets grant GATE_ROLE to their LiveRoom, so
the per-market commands below only work on a STANDALONE market. Use the room-*
commands with ROOM_ADDRESS set, and see docs/runbooks/LIVE_ROOM_OPERATIONS.md.

Live Room (ROOM_ADDRESS, GATE_SIGNER_ROLE signer):
  npm run operator -- room-status
  npm run operator -- room-safe <source-sequence> <market:epoch> [market:epoch ...]
  npm run operator -- room-suspend <source-sequence>
  npm run operator -- room-reopen <source-sequence>
  npm run operator -- room-close-slots <decisive-source-sequence> <market> [market ...]
  npm run operator -- room-close <decisive-source-sequence>

Permissionless recovery (any signer):
  npm run operator -- room-process <market:epoch> [market:epoch ...] [--max N]
  npm run operator -- room-close-remaining <market> [market ...]

Standalone market

Read-only:
  npm run operator -- status

Source gate (GATE_ROLE signer):
  npm run operator -- safe <epoch> <source-sequence>
  npm run operator -- suspend <source-sequence>
  npm run operator -- reopen <source-sequence>
  npm run operator -- close <decisive-source-sequence>

Permissionless processing:
  npm run operator -- process <epoch> [max-actions]

Resolver (one command from each RESOLVER_ROLE signer):
  npm run operator -- attest <a|b|tie|invalid> <evidence-uri-or-hash>
  npm run operator -- verdict <accept|reject>
  npm run operator -- finalize
  npm run operator -- expire
  npm run operator -- invalidate

Environment: ROOM_ADDRESS or MARKET_ADDRESS, AMOY_RPC_URL, and
OPERATOR_PRIVATE_KEY for writes.`);
}

function requiredInteger(value, name) {
  if (!/^\d+$/.test(value || "")) throw new Error(`${name} must be a non-negative integer.`);
  return BigInt(value);
}

function evidenceHash(value) {
  if (/^0x[0-9a-fA-F]{64}$/.test(value || "")) return value;
  if (!value) throw new Error("Evidence URI or bytes32 hash is required.");
  return keccak256(toBytes(value));
}

function outcomeNumber(value) {
  const values = { a: 1, b: 2, tie: 3, invalid: 4 };
  if (!values[value]) throw new Error("Outcome must be a, b, tie, or invalid.");
  return values[value];
}

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const [command, ...args] = process.argv.slice(2);

if (!command || command === "help" || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}

const isRoomCommand = command.startsWith("room-");
if (isRoomCommand) {
  if (!isAddress(roomAddress || "")) {
    console.error("Set ROOM_ADDRESS to the deployed LiveRoom for room-* commands.");
    process.exit(1);
  }
} else if (!isAddress(market || "")) {
  console.error("Set MARKET_ADDRESS to the deployed Polygon Amoy market.");
  process.exit(1);
}

/** Parses "0xmarket:epoch" pairs into parallel arrays. */
function marketEpochPairs(values) {
  const markets = [];
  const epochs = [];
  for (const value of values) {
    if (value.startsWith("--")) continue;
    const [address, epoch] = value.split(":");
    if (!isAddress(address || "")) throw new Error(`Not an address: ${address}`);
    markets.push(address);
    epochs.push(requiredInteger(epoch, "epoch"));
  }
  if (markets.length === 0) throw new Error("Pass at least one market:epoch pair.");
  return [markets, epochs];
}

function addressList(values) {
  const markets = values.filter((value) => !value.startsWith("--"));
  for (const address of markets) {
    if (!isAddress(address)) throw new Error(`Not an address: ${address}`);
  }
  if (markets.length === 0) throw new Error("Pass at least one market address.");
  return markets;
}

async function roomStatus() {
  const [slots, lastObserved, closedSequence, openCount] = await publicClient.multicall({
    allowFailure: false,
    contracts: ["slots", "lastObservedSequence", "roomClosedSequence", "openSlotCount"].map((functionName) => ({
      address: roomAddress,
      abi: roomAbi,
      functionName,
    })),
  });
  console.table({
    room: roomAddress,
    slots: slots.length,
    openSlots: openCount.toString(),
    lastObservedSequence: lastObserved.toString(),
    roomClosedSequence: closedSequence.toString(),
    state: closedSequence > 0n ? "closed" : "running",
  });
  for (const [index, slot] of slots.entries()) {
    const [question, gateState, finalOutcome] = await publicClient.multicall({
      allowFailure: false,
      contracts: ["question", "gateState", "finalOutcome"].map((functionName) => ({
        address: slot,
        abi,
        functionName,
      })),
    });
    console.log(
      `  slot ${index}  ${slot}  ${["open", "suspended", "closed"][Number(gateState)]}  ` +
        `${["unset", "A", "B", "tie", "invalid"][Number(finalOutcome)]}  ${question}`
    );
  }
}

async function writeRoom(functionName, functionArgs = []) {
  return write(functionName, functionArgs, { address: roomAddress, contractAbi: roomAbi });
}

async function status() {
  const names = ["question", "gateState", "finalOutcome", "currentEpoch", "lastSafeSequence", "reserveA", "reserveB", "pendingCollateral"];
  const results = await publicClient.multicall({
    allowFailure: false,
    contracts: names.map((functionName) => ({ address: market, abi, functionName })),
  });
  const [question, gateState, finalOutcome, currentEpoch, lastSafeSequence, reserveA, reserveB, pendingCollateral] = results;
  console.table({
    market,
    question,
    gate: ["open", "suspended", "closed"][Number(gateState)] || `unknown (${gateState})`,
    outcome: ["unset", "participant A", "participant B", "tie", "invalid"][Number(finalOutcome)] || `unknown (${finalOutcome})`,
    currentEpoch: currentEpoch.toString(),
    lastSafeSequence: lastSafeSequence.toString(),
    reserveA: `${formatUnits(reserveA, 6)} USDC`,
    reserveB: `${formatUnits(reserveB, 6)} USDC`,
    pendingCollateral: `${formatUnits(pendingCollateral, 6)} USDC`,
  });
}

async function write(functionName, functionArgs = [], { address = market, contractAbi = abi } = {}) {
  const privateKey = process.env.OPERATOR_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey || "")) {
    throw new Error("Set OPERATOR_PRIVATE_KEY to the role signer used for this command.");
  }
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const { request } = await publicClient.simulateContract({
    account,
    address,
    abi: contractAbi,
    functionName,
    args: functionArgs,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`${functionName} confirmed in block ${receipt.blockNumber}`);
  console.log(`${explorer}/tx/${hash}`);
}

try {
  switch (command) {
    case "status": await status(); break;
    case "room-status": await roomStatus(); break;
    case "room-safe": {
      const [markets, epochs] = marketEpochPairs(args.slice(1));
      await writeRoom("markRoomEpochsSafe", [requiredInteger(args[0], "source-sequence"), markets, epochs]);
      break;
    }
    case "room-suspend": await writeRoom("suspendRoom", [requiredInteger(args[0], "source-sequence")]); break;
    case "room-reopen": await writeRoom("reopenRoom", [requiredInteger(args[0], "source-sequence")]); break;
    case "room-close-slots":
      await writeRoom("closeSlots", [requiredInteger(args[0], "decisive-source-sequence"), addressList(args.slice(1))]);
      break;
    case "room-close": await writeRoom("closeRoom", [requiredInteger(args[0], "decisive-source-sequence")]); break;
    case "room-close-remaining": await writeRoom("closeRemainingSlots", [addressList(args)]); break;
    case "room-process": {
      const maxIndex = args.indexOf("--max");
      const maxActions = maxIndex >= 0 ? requiredInteger(args[maxIndex + 1], "max-actions") : 100n;
      const [markets, epochs] = marketEpochPairs(maxIndex >= 0 ? args.slice(0, maxIndex) : args);
      await writeRoom("processRoom", [markets, epochs, maxActions]);
      break;
    }
    case "safe": await write("markEpochSafe", [requiredInteger(args[0], "epoch"), requiredInteger(args[1], "source-sequence")]); break;
    case "process": await write("processEpoch", [requiredInteger(args[0], "epoch"), requiredInteger(args[1] || "100", "max-actions")]); break;
    case "suspend": await write("suspendGate", [requiredInteger(args[0], "source-sequence")]); break;
    case "reopen": await write("reopenGate", [requiredInteger(args[0], "source-sequence")]); break;
    case "close": await write("closeForDecisiveEvent", [requiredInteger(args[0], "decisive-source-sequence")]); break;
    case "attest": await write("attestResult", [outcomeNumber(args[0]), evidenceHash(args[1])]); break;
    case "verdict": {
      if (!["accept", "reject"].includes(args[0])) throw new Error("Verdict must be accept or reject.");
      await write("attestChallengeVerdict", [args[0] === "accept"]);
      break;
    }
    case "finalize": await write("finalizeUnchallenged"); break;
    case "expire": await write("expireChallenge"); break;
    case "invalidate": await write("invalidateUnresolved"); break;
    default: usage(); process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.shortMessage || error?.message || error);
  process.exitCode = 1;
}
