import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MARKET_ADDRESS, hasMarketDeployment } from "./config.js";
import {
  connectInjectedWallet,
  loadMarketSnapshot,
  loadParticipantBondSnapshot,
  loadResolutionSnapshot,
  postParticipantBond,
  submitLiquidity,
  submitPrediction,
  submitSale,
  submitResultChallenge,
  submitResolutionAction,
  transactionUrl,
  writeSimpleMarketAction,
} from "./marketGateway.js";

const sameAddress = (left, right) =>
  Boolean(left && right && String(left).toLowerCase() === String(right).toLowerCase());

/**
 * Wallet plus the currently selected market.
 *
 * A standalone build starts on VITE_MARKET_ADDRESS exactly as before. A Live
 * Room calls `selectMarket(slot.market)` as focus changes; every subsequent
 * read and write then targets that child address without rebuilding the app.
 */
export function useTestnetMarket() {
  const [marketAddress, setMarketAddress] = useState(MARKET_ADDRESS);
  const activeMarketAddress = useRef(MARKET_ADDRESS);
  const deployed = useMemo(() => hasMarketDeployment(marketAddress), [marketAddress]);
  const [account, setAccount] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [bondSnapshot, setBondSnapshot] = useState(null);
  const [resolutionSnapshot, setResolutionSnapshot] = useState(null);
  const [loading, setLoading] = useState(deployed);
  const [error, setError] = useState("");

  const refresh = useCallback(async (nextAccount = account, options = {}) => {
    const target = options.marketAddress || activeMarketAddress.current;
    if (!hasMarketDeployment(target)) {
      if (!activeMarketAddress.current) setLoading(false);
      return null;
    }
    try {
      const next = await loadMarketSnapshot(nextAccount || undefined, { marketAddress: target });
      // A slower read of the previously-selected question must not replace the
      // snapshot of the question the reader has since selected.
      if (sameAddress(activeMarketAddress.current, target)) {
        setSnapshot(next);
        setError("");
      }
      return next;
    } catch (cause) {
      if (sameAddress(activeMarketAddress.current, target)) {
        setError(cause?.shortMessage || cause?.message || "Unable to read the selected testnet market.");
      }
      return null;
    } finally {
      if (sameAddress(activeMarketAddress.current, target)) setLoading(false);
    }
  }, [account]);

  /** Select a standalone market or a child address projected by the Live Room. */
  const selectMarket = useCallback((nextMarketAddress) => {
    const next = nextMarketAddress || "";
    if (sameAddress(activeMarketAddress.current, next)) return next;
    activeMarketAddress.current = next;
    setMarketAddress(next);
    setSnapshot(null);
    setError("");
    setLoading(hasMarketDeployment(next));
    return next;
  }, []);

  useEffect(() => {
    if (!deployed) {
      setLoading(false);
      return undefined;
    }
    refresh(account, { marketAddress });
    const interval = window.setInterval(
      () => refresh(undefined, { marketAddress: activeMarketAddress.current }),
      12_000
    );
    return () => window.clearInterval(interval);
  }, [account, deployed, marketAddress, refresh]);

  useEffect(() => {
    if (!window.ethereum?.on) return undefined;
    const onAccountsChanged = (accounts) => {
      const next = accounts?.[0] || "";
      setAccount(next);
      setBondSnapshot(null);
      refresh(next, { marketAddress: activeMarketAddress.current });
    };
    window.ethereum.on("accountsChanged", onAccountsChanged);
    return () => window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
  }, [refresh]);

  const connect = useCallback(async () => {
    const next = await connectInjectedWallet();
    setAccount(next);
    await refresh(next, { marketAddress: activeMarketAddress.current });
    return next;
  }, [refresh]);

  const snapshotFor = useCallback(async (options = {}) => {
    const target = options.marketAddress || activeMarketAddress.current;
    if (snapshot && sameAddress(snapshot.marketAddress, target)) return snapshot;
    const fresh = await loadMarketSnapshot(account || undefined, { marketAddress: target });
    if (sameAddress(activeMarketAddress.current, target)) setSnapshot(fresh);
    return fresh;
  }, [account, snapshot]);

  const predict = useCallback(async (outcome, amount, options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const selectedSnapshot = await snapshotFor({ marketAddress: target });
    const result = await submitPrediction(account, selectedSnapshot, outcome, amount, { marketAddress: target });
    await refresh(account, { marketAddress: target });
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, refresh, snapshotFor]);

  const provideLiquidity = useCallback(async (amount, options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const selectedSnapshot = await snapshotFor({ marketAddress: target });
    const result = await submitLiquidity(account, selectedSnapshot, amount, { marketAddress: target });
    await refresh(account, { marketAddress: target });
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, refresh, snapshotFor]);

  const sell = useCallback(async (outcome, positions, options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const selectedSnapshot = await snapshotFor({ marketAddress: target });
    const result = await submitSale(account, selectedSnapshot, outcome, positions, { marketAddress: target });
    await refresh(account, { marketAddress: target });
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, refresh, snapshotFor]);

  const claim = useCallback(async (functionName, options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const hash = await writeSimpleMarketAction(account, functionName, {
      ...options,
      ...(target ? { marketAddress: target } : {}),
    });
    if (functionName === "claimIntegrityBond" && options.roomAddress) {
      const nextBond = await loadParticipantBondSnapshot(account, { roomAddress: options.roomAddress });
      setBondSnapshot(nextBond);
    } else {
      await refresh(account, { marketAddress: target });
    }
    return { hash, url: transactionUrl(hash) };
  }, [account, refresh]);

  const readBond = useCallback(async (options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const result = await loadParticipantBondSnapshot(account, {
      ...options,
      marketAddress: options.marketAddress || activeMarketAddress.current,
    });
    setBondSnapshot(result);
    return result;
  }, [account]);

  const postBond = useCallback(async (options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const result = await postParticipantBond(account, {
      ...options,
      marketAddress: options.marketAddress || activeMarketAddress.current,
    });
    const nextBond = await loadParticipantBondSnapshot(account, {
      ...options,
      marketAddress: options.marketAddress || activeMarketAddress.current,
    });
    setBondSnapshot(nextBond);
    if (!options.roomAddress) await refresh(account, { marketAddress: result.targetAddress });
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, refresh]);

  const challenge = useCallback(async (evidence, options = {}) => {
    if (!account) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const result = await submitResultChallenge(account, evidence, { marketAddress: target });
    await refresh(account, { marketAddress: target });
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, refresh]);

  const readResolution = useCallback(async (options = {}) => {
    const target = options.marketAddress || activeMarketAddress.current;
    const result = await loadResolutionSnapshot(account || undefined, { marketAddress: target });
    if (sameAddress(activeMarketAddress.current, target)) setResolutionSnapshot(result);
    return result;
  }, [account]);

  const resolve = useCallback(async (action, payload = {}, options = {}) => {
    const signer = options.account || account;
    if (!signer) throw new Error("Connect your wallet first.");
    const target = options.marketAddress || activeMarketAddress.current;
    const result = await submitResolutionAction(signer, action, payload, { marketAddress: target });
    await Promise.all([
      refresh(signer, { marketAddress: target }),
      readResolution({ marketAddress: target }),
    ]);
    return { ...result, url: transactionUrl(result.hash) };
  }, [account, readResolution, refresh]);

  return {
    deployed,
    marketAddress,
    account,
    snapshot,
    bondSnapshot,
    resolutionSnapshot,
    loading,
    error,
    connect,
    selectMarket,
    refresh,
    predict,
    sell,
    provideLiquidity,
    claim,
    readBond,
    postBond,
    challenge,
    readResolution,
    resolve,
  };
}
