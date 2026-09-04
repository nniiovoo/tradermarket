import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  isAddress,
  keccak256,
  toBytes,
} from "viem";
import {
  AMOY_CHAIN_ID,
  AMOY_RPC_URL,
  EXPLORER_URL,
  MARKET_ADDRESS,
  USDC_ADDRESS,
  polygonAmoy,
} from "./config.js";
import { erc20Abi, liveRoomAbi, marketAbi } from "./abi.js";
import { fromUsdc, quoteBuy, quoteSell } from "./marketMath.js";

const defaultPublicClient = createPublicClient({ chain: polygonAmoy, transport: http(AMOY_RPC_URL) });

export { toUsdc, fromUsdc } from "./marketMath.js";

async function ensureAmoy(provider) {
  const chainHex = `0x${AMOY_CHAIN_ID.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: chainHex,
        chainName: "Polygon Amoy",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: [AMOY_RPC_URL],
        blockExplorerUrls: [EXPLORER_URL],
      }],
    });
  }
}

export async function connectInjectedWallet() {
  if (!window.ethereum) throw new Error("Install a browser wallet such as MetaMask to continue.");
  await ensureAmoy(window.ethereum);
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!accounts?.[0]) throw new Error("No wallet account was returned.");
  return accounts[0];
}

async function defaultWalletClientFor(account) {
  if (!window.ethereum) throw new Error("Wallet provider unavailable.");
  await ensureAmoy(window.ethereum);
  return createWalletClient({ account, chain: polygonAmoy, transport: custom(window.ethereum) });
}

function requiredAddress(value, label) {
  if (!value || !isAddress(value)) throw new Error(`${label} is not configured with a valid contract address.`);
  return value;
}

/**
 * Wait for the transaction the reader actually authorized.
 *
 * Viem resolves for reverted receipts and for same-nonce replacements. A wallet
 * cancellation is commonly a successful zero-value transfer, so a receipt alone
 * is not proof that the original market call landed. Only a same-call repricing
 * is accepted, and its landed hash replaces the submitted hash in every link.
 */
export async function confirmTransaction(publicClient, submittedHash) {
  let replacement = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: submittedHash,
    onReplaced: (details) => {
      replacement = details;
    },
  });

  if (replacement?.reason === "cancelled") {
    throw new Error("The transaction was cancelled in the wallet, so no market action was submitted.");
  }
  if (replacement?.reason === "replaced") {
    throw new Error("The market action was replaced by a different wallet transaction and was not submitted.");
  }
  if (!receipt || receipt.status !== "success") {
    throw new Error("The transaction reverted on chain, so no market action was confirmed.");
  }
  return { hash: receipt.transactionHash || submittedHash, receipt, replacement };
}

/**
 * Address-aware browser gateway. The default address preserves standalone
 * builds; an explicit market address selects the actual child of a Live Room.
 */
export function createMarketGateway({
  publicClient = defaultPublicClient,
  walletClientFor = defaultWalletClientFor,
  defaultMarketAddress = MARKET_ADDRESS,
  usdcAddress = USDC_ADDRESS,
} = {}) {
  const marketTarget = (options = {}) =>
    requiredAddress(options.marketAddress || defaultMarketAddress, "Market");

  const bondTarget = (options = {}) => {
    if (options.roomAddress) {
      return {
        mode: "room",
        address: requiredAddress(options.roomAddress, "Live Room"),
        abi: liveRoomAbi,
        bondFunction: "ROOM_INTEGRITY_BOND",
      };
    }
    return {
      mode: "standalone",
      address: marketTarget(options),
      abi: marketAbi,
      bondFunction: "INTEGRITY_BOND",
    };
  };

  async function approveIfNeeded(account, spender, amount) {
    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, spender],
    });
    if (allowance >= amount) return null;
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amount],
    });
    return confirmTransaction(publicClient, submittedHash);
  }

  async function loadMarketSnapshot(account, options = {}) {
    const marketAddress = marketTarget(options);
    const bytecode = await publicClient.getBytecode({ address: marketAddress });
    if (!bytecode) throw new Error("The selected market contract is not deployed on Polygon Amoy.");

    const calls = [
      "question",
      "participantAName",
      "participantBName",
      "streamUrl",
      "imageUrl",
      "participantA",
      "participantB",
      "rewardAddressA",
      "rewardAddressB",
      "gateState",
      "provisionalOutcome",
      "provisionalAt",
      "challengeWindow",
      "challenged",
      "finalOutcome",
      "reserveA",
      "reserveB",
      "collateralBacking",
      "winnerRewardPool",
      "winnerRewardBps",
      "totalLpShares",
      "currentEpoch",
      "lastSafeSequence",
    ].map((functionName) => ({ address: marketAddress, abi: marketAbi, functionName }));

    const results = await publicClient.multicall({ contracts: calls, allowFailure: false });
    const [
      question,
      participantAName,
      participantBName,
      streamUrl,
      imageUrl,
      participantA,
      participantB,
      rewardAddressA,
      rewardAddressB,
      gateState,
      provisionalOutcome,
      provisionalAt,
      challengeWindow,
      challenged,
      finalOutcome,
      reserveA,
      reserveB,
      collateralBacking,
      winnerRewardPool,
      winnerRewardBps,
      totalLpShares,
      currentEpoch,
      lastSafeSequence,
    ] = results;

    let wallet = null;
    if (account) {
      const walletCalls = [
        { address: usdcAddress, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "positionAOf", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "positionBOf", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "lpSharesOf", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "lpFeeCredit", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "integrityBondOf", args: [account] },
        { address: marketAddress, abi: marketAbi, functionName: "winnerFeePaid", args: [account] },
      ];
      const [usdcBalance, positionA, positionB, lpShares, lpFeeCredit, integrityBond, winnerFeePaid] =
        await publicClient.multicall({ contracts: walletCalls, allowFailure: false });
      wallet = { usdcBalance, positionA, positionB, lpShares, lpFeeCredit, integrityBond, winnerFeePaid };
    }

    return {
      marketAddress,
      question,
      participantAName,
      participantBName,
      streamUrl,
      imageUrl,
      participantA,
      participantB,
      rewardAddressA,
      rewardAddressB,
      gateState: Number(gateState),
      provisionalOutcome: Number(provisionalOutcome),
      provisionalAt,
      challengeWindow,
      challenged,
      finalOutcome: Number(finalOutcome),
      reserveA,
      reserveB,
      collateralBacking,
      winnerRewardPool,
      winnerRewardBps: Number(winnerRewardBps),
      totalLpShares,
      currentEpoch: Number(currentEpoch),
      lastSafeSequence: Number(lastSafeSequence),
      wallet,
    };
  }

  async function submitPrediction(account, snapshot, outcome, amount, options = {}) {
    if (!snapshot) throw new Error("The selected market has not been read yet.");
    const marketAddress = marketTarget(options);
    const budget = fromUsdc(amount);
    const isA = outcome === "YES";
    const quote = quoteBuy(snapshot.reserveA, snapshot.reserveB, isA, budget, snapshot.winnerRewardBps);
    const minimumPositions = quote.positionsOut * 99n / 100n;
    await approveIfNeeded(account, marketAddress, budget);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "submitBuy",
      args: [isA, budget, minimumPositions, BigInt(Math.floor(Date.now() / 1000) + 600)],
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, quote };
  }

  async function submitSale(account, snapshot, outcome, positions, options = {}) {
    if (!snapshot) throw new Error("The selected market has not been read yet.");
    const marketAddress = marketTarget(options);
    const positionsIn = fromUsdc(positions);
    const isA = outcome === "YES";
    const quote = quoteSell(snapshot.reserveA, snapshot.reserveB, isA, positionsIn);
    if (quote.collateralOut === 0n) throw new Error("This sale is too small for the current pool.");
    const minimumCollateral = quote.collateralOut * 99n / 100n;
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "submitSell",
      args: [isA, positionsIn, minimumCollateral, BigInt(Math.floor(Date.now() / 1000) + 600)],
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, quote };
  }

  async function submitLiquidity(account, snapshot, amount, options = {}) {
    if (!snapshot) throw new Error("The selected market has not been read yet.");
    const marketAddress = marketTarget(options);
    const deposit = fromUsdc(amount);
    const largestReserve = snapshot.reserveA > snapshot.reserveB ? snapshot.reserveA : snapshot.reserveB;
    const expectedShares = snapshot.totalLpShares === 0n
      ? deposit
      : deposit * snapshot.totalLpShares / largestReserve;
    const minimumShares = expectedShares * 99n / 100n;
    await approveIfNeeded(account, marketAddress, deposit);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "submitAddLiquidity",
      args: [deposit, minimumShares, BigInt(Math.floor(Date.now() / 1000) + 600)],
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, expectedShares };
  }

  async function loadParticipantBondSnapshot(account, options = {}) {
    const target = bondTarget(options);
    const [requiredBond, postedBond] = await publicClient.multicall({
      contracts: [
        { address: target.address, abi: target.abi, functionName: target.bondFunction },
        { address: target.address, abi: target.abi, functionName: "integrityBondOf", args: [account] },
      ],
      allowFailure: false,
    });
    return { mode: target.mode, targetAddress: target.address, requiredBond, postedBond };
  }

  async function postParticipantBond(account, options = {}) {
    const target = bondTarget(options);
    const bond = await publicClient.readContract({
      address: target.address,
      abi: target.abi,
      functionName: target.bondFunction,
    });
    await approveIfNeeded(account, target.address, bond);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: target.address,
      abi: target.abi,
      functionName: "postIntegrityBond",
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, bond, mode: target.mode, targetAddress: target.address };
  }

  async function claimParticipantBond(account, options = {}) {
    const target = bondTarget(options);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: target.address,
      abi: target.abi,
      functionName: "claimIntegrityBond",
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, mode: target.mode, targetAddress: target.address };
  }

  async function submitResultChallenge(account, evidence, options = {}) {
    if (!evidence?.trim()) throw new Error("Provide an evidence URL or canonical evidence identifier.");
    const marketAddress = marketTarget(options);
    const bond = await publicClient.readContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "CHALLENGE_BOND",
    });
    const evidenceHash = /^0x[0-9a-fA-F]{64}$/.test(evidence.trim())
      ? evidence.trim()
      : keccak256(toBytes(evidence.trim()));
    await approveIfNeeded(account, marketAddress, bond);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: "challengeResult",
      args: [evidenceHash, bond],
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash, bond, evidenceHash };
  }

  async function loadResolutionSnapshot(account, options = {}) {
    const marketAddress = marketTarget(options);
    const bytecode = await publicClient.getBytecode({ address: marketAddress });
    if (!bytecode) throw new Error("The selected market contract is not deployed on Polygon Amoy.");
    const names = [
      "question",
      "participantAName",
      "participantBName",
      "streamUrl",
      "gateState",
      "provisionalOutcome",
      "provisionalEvidenceHash",
      "provisionalAt",
      "challengeWindow",
      "challenged",
      "challenger",
      "challengeEvidenceHash",
      "challengedAt",
      "challengeTimeout",
      "finalOutcome",
      "resolutionDueAt",
      "RESOLVER_ROLE",
      "GATE_ROLE",
      "lastSafeSequence",
    ];
    const values = await publicClient.multicall({
      contracts: names.map((functionName) => ({ address: marketAddress, abi: marketAbi, functionName })),
      allowFailure: false,
    });
    const snapshot = Object.fromEntries(names.map((name, index) => [name, values[index]]));
    const [isResolver, isGate] = account
      ? await Promise.all([
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "hasRole", args: [snapshot.RESOLVER_ROLE, account] }),
          publicClient.readContract({ address: marketAddress, abi: marketAbi, functionName: "hasRole", args: [snapshot.GATE_ROLE, account] }),
        ])
      : [false, false];
    return {
      ...snapshot,
      marketAddress,
      gateState: Number(snapshot.gateState),
      provisionalOutcome: Number(snapshot.provisionalOutcome),
      finalOutcome: Number(snapshot.finalOutcome),
      isResolver,
      isGate,
    };
  }

  async function submitResolutionAction(account, action, payload = {}, options = {}) {
    const marketAddress = marketTarget(options);
    const allowed = new Set([
      "attestResult",
      "attestChallengeVerdict",
      "finalizeUnchallenged",
      "expireChallenge",
      "invalidateUnresolved",
      "closeForDecisiveEvent",
    ]);
    if (!allowed.has(action)) throw new Error(`Unsupported resolution action: ${action}`);

    let args = [];
    if (action === "attestResult") {
      const outcome = Number(payload.outcome);
      if (![1, 2, 3, 4].includes(outcome)) throw new Error("Select a valid proposed outcome.");
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(payload.evidenceHash ?? ""))) {
        throw new Error("A canonical evidence hash is required.");
      }
      args = [outcome, payload.evidenceHash];
    } else if (action === "attestChallengeVerdict") {
      if (typeof payload.acceptChallenge !== "boolean") throw new Error("Choose whether the challenge is accepted.");
      args = [payload.acceptChallenge];
    } else if (action === "closeForDecisiveEvent") {
      const sourceSequence = BigInt(payload.sourceSequence ?? 0);
      if (sourceSequence <= 0n) throw new Error("A positive event sequence is required to close forecasting.");
      args = [sourceSequence];
    }

    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({
      address: marketAddress,
      abi: marketAbi,
      functionName: action,
      args,
    });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return { hash: confirmed.hash };
  }

  async function writeSimpleMarketAction(account, functionName, options = {}) {
    if (functionName === "claimIntegrityBond" && options.roomAddress) {
      const result = await claimParticipantBond(account, options);
      return result.hash;
    }
    const marketAddress = marketTarget(options);
    const wallet = await walletClientFor(account);
    const submittedHash = await wallet.writeContract({ address: marketAddress, abi: marketAbi, functionName });
    const confirmed = await confirmTransaction(publicClient, submittedHash);
    return confirmed.hash;
  }

  return {
    loadMarketSnapshot,
    submitPrediction,
    submitSale,
    submitLiquidity,
    loadParticipantBondSnapshot,
    postParticipantBond,
    claimParticipantBond,
    submitResultChallenge,
    loadResolutionSnapshot,
    submitResolutionAction,
    writeSimpleMarketAction,
  };
}

const defaultGateway = createMarketGateway();

// Backwards-compatible standalone exports. Passing `{ marketAddress }` selects
// a Live Room child; omitting it continues to use VITE_MARKET_ADDRESS.
export const loadMarketSnapshot = (...args) => defaultGateway.loadMarketSnapshot(...args);
export const submitPrediction = (...args) => defaultGateway.submitPrediction(...args);
export const submitSale = (...args) => defaultGateway.submitSale(...args);
export const submitLiquidity = (...args) => defaultGateway.submitLiquidity(...args);
export const loadParticipantBondSnapshot = (...args) => defaultGateway.loadParticipantBondSnapshot(...args);
export const postParticipantBond = (...args) => defaultGateway.postParticipantBond(...args);
export const claimParticipantBond = (...args) => defaultGateway.claimParticipantBond(...args);
export const submitResultChallenge = (...args) => defaultGateway.submitResultChallenge(...args);
export const loadResolutionSnapshot = (...args) => defaultGateway.loadResolutionSnapshot(...args);
export const submitResolutionAction = (...args) => defaultGateway.submitResolutionAction(...args);
export const writeSimpleMarketAction = (...args) => defaultGateway.writeSimpleMarketAction(...args);

export function transactionUrl(hash) {
  return `${EXPLORER_URL}/tx/${hash}`;
}
