// Real log source and market reader for the indexer.
//
// Decodes actual chain logs with the compiled ABIs, so a contract event change
// surfaces as a decode failure rather than a silently empty projection. The
// market reader supplies the state no event carries — reserves, price, LP
// shares, outcome — read from public getters at a known block.

import { parseEventLogs } from "viem";
import { abis, INDEXED_EVENTS, MARKET_STATE_GETTERS } from "./abi.mjs";

function eventsFrom(abi, names) {
  const wanted = new Set(names);
  return abi.filter((entry) => entry.type === "event" && wanted.has(entry.name));
}

export class ViemLogSource {
  /**
   * @param options.publicClient viem public client
   * @param options.factory      factory address (room and market creation)
   * @param options.rooms        () => address[] of known room contracts
   * @param options.markets      () => address[] of known market contracts
   */
  constructor({ publicClient, factory, rooms = () => [], markets = () => [] }) {
    this.publicClient = publicClient;
    this.factory = factory;
    this.rooms = rooms;
    this.markets = markets;
    const all = abis();
    this.factoryEvents = eventsFrom(all.factory, INDEXED_EVENTS.factory);
    this.roomEvents = eventsFrom(all.room, INDEXED_EVENTS.room);
    this.marketEvents = eventsFrom(all.market, INDEXED_EVENTS.market);
    // Block times, cached. The indexer asks for the same blocks repeatedly while
    // pairing action submissions with executions, and a canonical block's time
    // never changes. Bounded for the same reason the reorg ring is.
    this._blockTimes = new Map();
  }

  /**
   * The hash of one block, or null when it cannot be read.
   *
   * This is the only observable that reveals a reorg: the head NUMBER can stay
   * where it is while the history beneath it is replaced, so nothing derived
   * from block numbers alone can see one. Null rather than throwing, because an
   * unreadable block must not be mistaken for a rewritten one.
   */
  async blockHash(blockNumber) {
    try {
      const block = await this.publicClient.getBlock({ blockNumber: BigInt(blockNumber), cacheTime: 0 });
      return block?.hash ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The unix time of one block, or null when it cannot be read.
   *
   * Null, never a fallback: epoch clear latency is derived from the difference
   * between two of these, and a guessed timestamp would produce a latency this
   * system never measured.
   */
  async blockTimestamp(blockNumber) {
    const key = Number(blockNumber);
    if (this._blockTimes.has(key)) return this._blockTimes.get(key);
    try {
      const block = await this.publicClient.getBlock({ blockNumber: BigInt(key) });
      const seconds = block?.timestamp === undefined ? null : Number(block.timestamp);
      this._blockTimes.set(key, seconds);
      if (this._blockTimes.size > 512) this._blockTimes.delete(this._blockTimes.keys().next().value);
      return seconds;
    } catch {
      return null;
    }
  }

  /**
   * Fetches raw logs for an address set and decodes them against the ABI.
   *
   * One request per address range, decoded locally — rather than one filtered
   * request per event. Topic-filtered requests are both slower (19 round trips
   * per range) and fragile: a signature the filter computes differently from
   * the one the contract emitted silently returns nothing, which reads exactly
   * like "this never happened".
   */
  async _fetch(address, events, abi, fromBlock, toBlock) {
    if (!address || (Array.isArray(address) && address.length === 0)) return [];
    const raw = await this.publicClient.getLogs({
      address,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
    if (raw.length === 0) return [];
    const wanted = new Set(events.map((entry) => entry.name));
    const decoded = parseEventLogs({ abi, logs: raw });
    return decoded
      .filter((log) => wanted.has(log.eventName))
      .map((log) => ({
        event: log.eventName,
        address: log.address,
        args: log.args,
        blockNumber: Number(log.blockNumber),
        logIndex: Number(log.logIndex),
        transactionHash: log.transactionHash,
      }));
  }

  /**
   * The current chain head, read UNCACHED.
   *
   * viem caches `getBlockNumber` for its polling interval (4s by default). An
   * indexer that trusts that cache silently indexes a stale range and reports
   * success: on a fast chain an entire phase of activity can land inside one
   * cache window and simply never be projected. Anything that decides "how far
   * have I indexed" must read the head for real.
   */
  async head() {
    return Number(await this.publicClient.getBlockNumber({ cacheTime: 0 }));
  }

  /**
   * The hash of one block, or null when it cannot be read.
   *
   * This is the only observable that reveals a reorg: the head NUMBER can stay
   * where it is while the history beneath it is replaced, so nothing derived
   * from block numbers alone can see one. Null rather than throwing, because an
   * unreadable block must not be mistaken for a rewritten one.
   */
  async blockHash(blockNumber) {
    try {
      const block = await this.publicClient.getBlock({ blockNumber: BigInt(blockNumber), cacheTime: 0 });
      return block?.hash ?? null;
    } catch {
      return null;
    }
  }

  /** Every indexed log in the range, in canonical chain order. */
  async getLogs({ fromBlock, toBlock }) {
    if (toBlock < fromBlock) return [];
    const all = abis();
    const [factory, rooms, markets] = await Promise.all([
      this._fetch(this.factory, this.factoryEvents, all.factory, fromBlock, toBlock),
      this._fetch(this.rooms(), this.roomEvents, all.room, fromBlock, toBlock),
      this._fetch(this.markets(), this.marketEvents, all.market, fromBlock, toBlock),
    ]);
    return [...factory, ...rooms, ...markets].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
    );
  }
}

/** Reads the market state that no event carries.
 *
 *  Plain reads pinned to one block, not multicall: multicall3 is not deployed
 *  on every chain a room might run on (a local Anvil among them), and a reader
 *  that only works where a helper contract happens to exist is a deployment
 *  trap. Pinning the block keeps the reads mutually consistent, which is what
 *  multicall was buying.
 */
export class ViemMarketReader {
  constructor({ publicClient }) {
    this.publicClient = publicClient;
    this.abi = abis().market;
  }

  async readMarketState(market, blockNumber = null) {
    const at = blockNumber === null ? {} : { blockNumber: BigInt(blockNumber) };
    const values = await Promise.all(
      MARKET_STATE_GETTERS.map((functionName) =>
        this.publicClient.readContract({ address: market, abi: this.abi, functionName, ...at })
      )
    );
    const state = {};
    MARKET_STATE_GETTERS.forEach((name, index) => {
      state[name] = values[index];
    });
    return state;
  }

  /**
   * The two per-account balances that decide what a settled account is owed.
   *
   * `lpFeeCredit` survives `settleLpInventory` — settlement accrues into it and
   * never pays it — and `winnerFeePaid` only accrues where the market charges a
   * fee. Neither appears in any log, so nothing downstream can infer them: an
   * LP who claimed fees once is not therefore owed nothing, and a buyer on a
   * zero-bps market is not therefore owed a refund.
   */
  async readAccountState(market, account) {
    const read = (functionName, args) =>
      this.publicClient.readContract({ address: market, abi: this.abi, functionName, args });
    // `claimLpFees` accrues before it pays, so the claimable figure is the
    // stored credit *plus* what accrual would add. That needs the share
    // balance, the fee debt and the market-wide fee index as well.
    const [lpFeeCredit, winnerFeePaid, lpShares, lpFeeDebt, feePerShare] = await Promise.all([
      read("lpFeeCredit", [account]),
      read("winnerFeePaid", [account]),
      read("lpSharesOf", [account]),
      read("lpFeeDebt", [account]),
      read("feePerShare", []),
    ]);
    return { lpFeeCredit, winnerFeePaid, lpShares, lpFeeDebt, feePerShare };
  }
}
