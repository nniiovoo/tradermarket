// Real RoomChain port: the Gate Authority's only write path, over viem.
//
// Every write is idempotent by construction — the key is (market, epoch, call)
// and the contract itself rejects a decreasing room sequence, a re-marked
// epoch, and anything after closeRoom — so a retry after a crash reconciles
// against chain state rather than double-acting.

import { createWalletClient, http } from "viem";
import { toBytes32 } from "../domain/slotrequest.mjs";
import { foundry } from "viem/chains";

/// The two structs `publishSlot` takes, mirroring LiveRoom exactly. Field
/// ORDER is part of the encoding, so a reordering here is a silent revert.
const SLOT_REQUEST_COMPONENTS = [
  { name: "templateId", type: "bytes32" },
  { name: "templateParamsHash", type: "bytes32" },
  { name: "conditionHash", type: "bytes32" },
  { name: "announceDelay", type: "uint64" },
  { name: "winnerRewardBps", type: "uint16" },
  { name: "question", type: "string" },
  { name: "streamUrl", type: "string" },
  { name: "imageUrl", type: "string" },
];

const PUBLICATION_PERMIT_COMPONENTS = [
  { name: "slotIndex", type: "uint32" },
  { name: "requestHash", type: "bytes32" },
  { name: "conditionHash", type: "bytes32" },
  { name: "undecidedThroughSequence", type: "uint256" },
  { name: "announceDelay", type: "uint64" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
  { name: "nonce", type: "uint256" },
];

export const LIVE_ROOM_ABI = [
  {
    type: "function",
    name: "markRoomEpochsSafe",
    inputs: [
      { name: "sourceSequence", type: "uint256" },
      { name: "markets", type: "address[]" },
      { name: "epochs", type: "uint64[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "suspendRoom", inputs: [{ name: "sourceSequence", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "reopenRoom", inputs: [{ name: "sourceSequence", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "closeSlots",
    inputs: [{ name: "decisiveSequence", type: "uint256" }, { name: "markets", type: "address[]" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "closeRoom", inputs: [{ name: "decisiveSequence", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "closeRemainingSlots", inputs: [{ name: "markets", type: "address[]" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "processRoom",
    inputs: [
      { name: "markets", type: "address[]" },
      { name: "epochs", type: "uint64[]" },
      { name: "maxActions", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "slots", inputs: [], outputs: [{ type: "address[]" }], stateMutability: "view" },
  { type: "function", name: "lastObservedSequence", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "roomClosedSequence", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "openSlotCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "slotCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "slotAt", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "usedNonce", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "publisher", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "gateSigner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "minAnnounceDelay", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "participantsReady", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "publishSlot",
    inputs: [
      { name: "request", type: "tuple", components: SLOT_REQUEST_COMPONENTS },
      { name: "permit", type: "tuple", components: PUBLICATION_PERMIT_COMPONENTS },
      { name: "gateSignature", type: "bytes" },
      { name: "restricted", type: "address[]" },
    ],
    outputs: [{ name: "market", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "slotRequestHash",
    inputs: [
      { name: "request", type: "tuple", components: SLOT_REQUEST_COMPONENTS },
      { name: "restricted", type: "address[]" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "pure",
  },
];

export const MARKET_ABI = [
  { type: "function", name: "gateState", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "epochSafe", inputs: [{ type: "uint64" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "hasLiquidity", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "epochActionIds",
    inputs: [{ type: "uint64" }],
    outputs: [{ type: "uint256[]" }],
    stateMutability: "view",
  },
  { type: "function", name: "finalOutcome", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "slotBinding",
    inputs: [],
    outputs: [{ type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint16" }],
    stateMutability: "view",
  },
  { type: "function", name: "provisionalOutcome", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "resolutionDueAt", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  {
    type: "function",
    name: "attestResult",
    inputs: [{ name: "outcome", type: "uint8" }, { name: "evidenceHash", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  // The bonded-challenge half of resolution. Absent from this ABI until
  // 2026-08-23, which is why no service could adjudicate a challenge even
  // though the contract has always been able to: the audience bonded, the
  // market paused, and only the timeout resolved it.
  { type: "function", name: "challenged", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "challengeEvidenceHash",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  { type: "function", name: "finalOutcome", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  {
    type: "function",
    name: "attestChallengeVerdict",
    inputs: [{ name: "acceptChallenge", type: "bool" }],
    outputs: [],
    stateMutability: "nonpayable",
  },

  // Settlement timing, and the three permissionless calls that move a market to
  // final. Absent from this ABI until 2026-08-24, which is why no service could
  // finalize anything: every payout path is `onlyFinal`, and the only callers of
  // these in the whole repository were game-day scripts and a manual button.
  // Nothing was trapped — they are callable by anyone — but nothing was
  // responsible for calling them either.
  // Refund-on-close bookkeeping. `epochCursor` is the one that matters and the
  // one that is easy to get wrong: `_epochActionIds` never shrinks, so
  // "does this epoch still hold work" is `epochCursor < epochActionIds.length`.
  // A `length > 0` predicate is permanently true once anyone has traded, and a
  // drain built on it re-sends the same transaction every tick forever.
  { type: "function", name: "closedEpoch", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "currentEpoch", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  {
    type: "function",
    name: "epochCursor",
    inputs: [{ type: "uint64" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  { type: "function", name: "provisionalAt", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "challengedAt", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "challengeWindow", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "challengeTimeout", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" },
  { type: "function", name: "finalizeUnchallenged", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "expireChallenge", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "invalidateUnresolved", inputs: [], outputs: [], stateMutability: "nonpayable" },
];

export class OnChainRoom {
  /**
   * @param options.gateAccount  the account THIS process signs with. Named for
   *   the gate because the gate was the first caller, but the publisher and the
   *   resolver hold this port too, each with their own key — which is the whole
   *   design: one port, four processes, four different signers, and no process
   *   ever holding two of the keys.
   * @param options.chain  the viem chain. Defaults to foundry for the local
   *   game day; a deployment on any other network MUST pass its own, because a
   *   wallet client signs the chain id it was given, not the one the RPC is on,
   *   and a mismatch is a transaction the node rejects rather than a warning.
   */
  constructor({ publicClient, rpc, room, gateAccount, account = gateAccount, chain = foundry }) {
    this.publicClient = publicClient;
    this.room = room;
    this.chain = chain;
    this.account = account;
    this.wallet = createWalletClient({ account, chain, transport: http(rpc) });
  }

  /// Per-call gas floors. `processRoom` executes real market work, and its
  /// cost is unbounded by design, so it must never run on an estimate: the
  /// room's isolated-failure design makes a starved batch look successful, and
  /// a gas estimator will happily converge on exactly that. The other calls are
  /// cheap and bounded, so an estimate is fine for them.
  static GAS_FLOOR = { processRoom: 3_000_000n, markRoomEpochsSafe: 1_500_000n };

  async _write(functionName, args) {
    const { request } = await this.publicClient.simulateContract({
      address: this.room,
      abi: LIVE_ROOM_ABI,
      functionName,
      args,
      account: this.wallet.account,
    });
    const floor = OnChainRoom.GAS_FLOOR[functionName];
    if (floor && (!request.gas || request.gas < floor)) request.gas = floor;
    const hash = await this.wallet.writeContract(request);
    return this._settled(functionName, hash);
  }

  /**
   * Waits for a receipt AND checks it.
   *
   * A reverted transaction still produces a receipt, and returning it unread
   * reported every on-chain revert as a success. Simulation catches most of
   * them, but simulation runs against the state at simulation time: anything
   * that changes between simulate and mine — another operator's transaction,
   * a clock bound crossed, an out-of-gas — reverts with the caller told
   * nothing. An operator then sees a permit consumed, or an attestation
   * recorded, for work the chain did not do.
   */
  async _settled(functionName, hash) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${functionName} reverted on chain (tx ${hash})`);
    }
    return receipt;
  }

  async _read(functionName, args = []) {
    return this.publicClient.readContract({ address: this.room, abi: LIVE_ROOM_ABI, functionName, args });
  }

  async lastObservedSequence() {
    return Number(await this._read("lastObservedSequence"));
  }

  /// Normalized to Number at the port boundary. The contract returns a BigInt
  /// and the in-memory fake returns a Number; leaving both shapes to leak made
  /// `!== 0` read a live room as closed, which only a real chain exposed.
  async roomClosedSequence() {
    return Number(await this._read("roomClosedSequence"));
  }

  async openSlots() {
    const all = await this._read("slots");
    const open = [];
    for (const market of all) {
      const gateState = await this.publicClient.readContract({ address: market, abi: MARKET_ABI, functionName: "gateState" });
      if (Number(gateState) !== 2) open.push({ market, slotIndex: open.length });
    }
    return open;
  }

  async isEpochSafe(market, epoch) {
    return this.publicClient.readContract({
      address: market,
      abi: MARKET_ABI,
      functionName: "epochSafe",
      args: [BigInt(epoch)],
    });
  }

  /// An epoch with no submitted action is not worth a transaction: marking it
  /// safe changes nothing and, worse, consumes the one clearance this market
  /// gets at this source sequence.
  async hasPendingActions(market, epoch) {
    const ids = await this.publicClient.readContract({
      address: market,
      abi: MARKET_ABI,
      functionName: "epochActionIds",
      args: [BigInt(epoch)],
    });
    return ids.length > 0;
  }

  /**
   * One slot's gate state, as the in-memory port names it.
   *
   * The gate asks this to answer "is EVERY open slot already frozen", which is
   * the right question for suspending — "is ANY slot frozen" is the right one
   * only for reopening. Without this method the gate falls back to the second
   * question, and its own comment says what that costs: once the first slot is
   * frozen it stops calling suspendRoom, so a slot published while the outage
   * is still running never gets frozen at all and opens against a dead feed.
   *
   * That fallback was the real port's actual behaviour — the fake had this
   * method, the deployed one did not, and every test runs against the fake.
   */
  async gateStateOf(market) {
    const state = Number(await this._readMarket(market, "gateState"));
    return state === 2 ? "closed" : state === 1 ? "suspended" : "open";
  }

  async isSuspended() {
    for (const { market } of await this.openSlots()) {
      const gateState = await this.publicClient.readContract({ address: market, abi: MARKET_ABI, functionName: "gateState" });
      if (Number(gateState) === 1) return true;
    }
    return false;
  }

  async markRoomEpochsSafe(sourceSequence, markets, epochs) {
    return this._write("markRoomEpochsSafe", [
      BigInt(sourceSequence),
      markets,
      epochs.map((epoch) => BigInt(epoch)),
    ]);
  }

  async suspendRoom(sourceSequence) {
    return this._write("suspendRoom", [BigInt(sourceSequence)]);
  }

  async reopenRoom(sourceSequence) {
    return this._write("reopenRoom", [BigInt(sourceSequence)]);
  }

  async closeSlots(decisiveSequence, markets) {
    return this._write("closeSlots", [BigInt(decisiveSequence), markets]);
  }

  async closeRoom(decisiveSequence) {
    return this._write("closeRoom", [BigInt(decisiveSequence)]);
  }

  async closeRemainingSlots(markets) {
    return this._write("closeRemainingSlots", [markets]);
  }

  async processRoom(markets, epochs, maxActions) {
    return this._write("processRoom", [markets, epochs.map((epoch) => BigInt(epoch)), BigInt(maxActions)]);
  }

  // ------------------------------------------------------------ publication

  /**
   * Submits one gate-signed permit with the PUBLISHER key.
   *
   * The room recomputes the request hash itself and checks it against the one
   * the permit binds, so every field here has to be exactly what the gate was
   * shown — the encoding, not just the values. `templateId` is the one that
   * differs in shape: the catalogue names it as a string and the contract holds
   * bytes32, and the gate hashed the padded form.
   *
   * The returned address is read back from the room after the receipt rather
   * than taken from the simulation: a simulation is a prediction, and the
   * address of a market that actually exists is a fact.
   */
  async publishSlot(request, permit, gateSignature, restricted = []) {
    const before = Number(await this._read("slotCount"));
    await this._write("publishSlot", [
      {
        templateId: toBytes32(request.templateId),
        templateParamsHash: request.templateParamsHash,
        conditionHash: request.conditionHash,
        announceDelay: BigInt(request.announceDelay),
        winnerRewardBps: Number(request.winnerRewardBps),
        question: request.question ?? "",
        streamUrl: request.streamUrl ?? "",
        imageUrl: request.imageUrl ?? "",
      },
      {
        slotIndex: Number(permit.slotIndex),
        requestHash: permit.requestHash,
        conditionHash: permit.conditionHash,
        undecidedThroughSequence: BigInt(permit.undecidedThroughSequence),
        announceDelay: BigInt(permit.announceDelay),
        issuedAt: BigInt(permit.issuedAt),
        expiresAt: BigInt(permit.expiresAt),
        nonce: BigInt(permit.nonce),
      },
      gateSignature,
      restricted,
    ]);
    return this._read("slotAt", [BigInt(before)]);
  }

  /**
   * Whether a permit nonce has been spent.
   *
   * The room marks it used inside the same call that deploys the market, so
   * this is the exact answer to "did my publication land" — which a publisher
   * that lost a receipt has to be able to ask before it retries.
   */
  async usedNonce(nonce) {
    return this._read("usedNonce", [BigInt(nonce)]);
  }

  /// How many slots the room has published. The permit binds a slot index and
  /// the room requires it to equal this exactly, so the gate reads it here
  /// rather than trusting a number in a queued request.
  async slotCount() {
    return Number(await this._read("slotCount"));
  }

  /// The addresses the ROOM recognises. An operator holding the wrong key can
  /// do every step up to the transaction and be refused by the contract every
  /// time, which is indistinguishable from a quiet market.
  async publisherAddress() {
    return this._read("publisher");
  }

  async gateSigner() {
    return this._read("gateSigner");
  }

  /** The contract's own request hash, for cross-checking the JS mirror. */
  async slotRequestHashOf(request, restricted = []) {
    return this._read("slotRequestHash", [
      {
        templateId: toBytes32(request.templateId),
        templateParamsHash: request.templateParamsHash,
        conditionHash: request.conditionHash,
        announceDelay: BigInt(request.announceDelay),
        winnerRewardBps: Number(request.winnerRewardBps),
        question: request.question ?? "",
        streamUrl: request.streamUrl ?? "",
        imageUrl: request.imageUrl ?? "",
      },
      restricted,
    ]);
  }

  // ------------------------------------------------------------- resolution

  async _writeMarket(market, functionName, args) {
    const { request } = await this.publicClient.simulateContract({
      address: market,
      abi: MARKET_ABI,
      functionName,
      args,
      account: this.wallet.account,
    });
    const hash = await this.wallet.writeContract(request);
    return this._settled(functionName, hash);
  }

  async _readMarket(market, functionName, args = []) {
    return this.publicClient.readContract({ address: market, abi: MARKET_ABI, functionName, args });
  }

  /// Slot 0 is the headline by construction: the room refuses any other
  /// template there, and every other slot is evaluated against its boundary.
  async headlineMarket() {
    if (Number(await this._read("slotCount")) === 0) return null;
    return this._read("slotAt", [0n]);
  }

  /// The condition binding the CHAIN holds. A resolver reads its condition
  /// document from a local database and may only use it if it hashes to this.
  async conditionHashOf(market) {
    const binding = await this._readMarket(market, "slotBinding");
    return binding[3];
  }

  async marketForConditionHash(hash) {
    for (const market of await this._read("slots")) {
      if ((await this.conditionHashOf(market)) === hash) return market;
    }
    return null;
  }

  async finalOutcomeOf(market) {
    return Number(await this._readMarket(market, "finalOutcome"));
  }

  async resolutionDueAtOf(market) {
    return Number(await this._readMarket(market, "resolutionDueAt"));
  }

  /// Markets whose forecasting has closed and which nobody has finalized —
  /// the resolver's work list, read from the chain rather than from any
  /// projection, because a resolver that is told what to resolve by the
  /// Coordinator is resolving the Coordinator's opinion.
  async closedSlots() {
    const closed = [];
    for (const [index, market] of (await this._read("slots")).entries()) {
      if (Number(await this._readMarket(market, "gateState")) !== 2) continue;
      if (Number(await this._readMarket(market, "finalOutcome")) !== 0) continue;
      closed.push({ market, slotIndex: index, conditionHash: await this.conditionHashOf(market) });
    }
    return closed;
  }

  /// Signed with the RESOLVER key. The market counts attestations per signer
  /// and rejects a second from the same one, which is what makes quorum mean
  /// two operators rather than one operator twice.
  async attestResult(market, outcomeEnum, evidenceHash) {
    return this._writeMarket(market, "attestResult", [Number(outcomeEnum), evidenceHash]);
  }

  /**
   * The epoch range that can still owe refunds on a closed market.
   *
   * Everything from the epoch it closed in up to the current one: those are
   * exactly the epochs `processEpoch` refunds rather than executes
   * (`canRefund = gateState == Closed && epoch >= closedEpoch`).
   */
  async refundWindowOf(market) {
    const [closedEpoch, currentEpoch] = await Promise.all([
      this._readMarket(market, "closedEpoch"),
      this._readMarket(market, "currentEpoch"),
    ]);
    return { closedEpoch: Number(closedEpoch), currentEpoch: Number(currentEpoch) };
  }

  /**
   * Whether this epoch still holds actions nobody has processed.
   *
   * NOT `epochActionIds.length > 0` — that array never shrinks, so it stays
   * true forever once anyone has traded. The contract tracks progress in
   * `epochCursor`, and the honest question is whether the cursor has reached
   * the end.
   */
  async unprocessedActions(market, epoch) {
    const [cursor, ids] = await Promise.all([
      this._readMarket(market, "epochCursor", [BigInt(epoch)]),
      this._readMarket(market, "epochActionIds", [BigInt(epoch)]),
    ]);
    return Number(cursor) < ids.length;
  }

  /**
   * Everything the keeper needs to decide which finalization call, if any, the
   * contract would accept right now.
   *
   * Read together in one pass because the decision is over the whole set: a
   * `challenged` read from before a challenge landed, paired with a
   * `provisionalAt` from after, would finalize a market that is under dispute.
   */
  async settlementStateOf(market) {
    const [
      gateState,
      provisionalOutcome,
      finalOutcome,
      challenged,
      provisionalAt,
      challengedAt,
      challengeWindow,
      challengeTimeout,
      resolutionDueAt,
    ] = await Promise.all([
      this._readMarket(market, "gateState"),
      this._readMarket(market, "provisionalOutcome"),
      this._readMarket(market, "finalOutcome"),
      this._readMarket(market, "challenged"),
      this._readMarket(market, "provisionalAt"),
      this._readMarket(market, "challengedAt"),
      this._readMarket(market, "challengeWindow"),
      this._readMarket(market, "challengeTimeout"),
      this._readMarket(market, "resolutionDueAt"),
    ]);
    return {
      // Named as the in-memory port names it, so `dueAction` reads the same
      // against either.
      gateState: Number(gateState) === 2 ? "closed" : Number(gateState) === 1 ? "suspended" : "open",
      provisionalOutcome: Number(provisionalOutcome),
      finalOutcome: Number(finalOutcome),
      challenged: Boolean(challenged),
      provisionalAt: Number(provisionalAt),
      challengedAt: Number(challengedAt),
      challengeWindow: Number(challengeWindow),
      challengeTimeout: Number(challengeTimeout),
      resolutionDueAt: Number(resolutionDueAt),
    };
  }

  /// The three permissionless finalization calls, signed with the KEEPER key.
  /// Each takes `nowS` in the port signature purely so the in-memory fake can
  /// enforce the same timing the contract does; the chain ignores it and uses
  /// `block.timestamp`, which is the authority either way.
  async finalizeUnchallenged(market) {
    return this._writeMarket(market, "finalizeUnchallenged", []);
  }

  async expireChallenge(market) {
    return this._writeMarket(market, "expireChallenge", []);
  }

  async invalidateUnresolved(market) {
    return this._writeMarket(market, "invalidateUnresolved", []);
  }

  /** Whether a market is paused on a bonded audience challenge, and its state. */
  async challengeStateOf(market) {
    const [challenged, evidenceHash, provisional, final] = await Promise.all([
      this._readMarket(market, "challenged"),
      this._readMarket(market, "challengeEvidenceHash"),
      this._readMarket(market, "provisionalOutcome"),
      this._readMarket(market, "finalOutcome"),
    ]);
    return {
      challenged: Boolean(challenged),
      evidenceHash,
      provisionalOutcome: Number(provisional),
      finalOutcome: Number(final),
    };
  }

  /// Signed with the RESOLVER key. Two distinct resolvers agreeing decide the
  /// challenge; accepting it invalidates the market and returns the bond.
  async attestChallengeVerdict(market, acceptChallenge) {
    return this._writeMarket(market, "attestChallengeVerdict", [Boolean(acceptChallenge)]);
  }

  /** Test-chain helper: advance to a wall-clock second and mine. */
  async advanceTimeTo(targetSeconds) {
    const block = await this.publicClient.getBlock();
    if (Number(block.timestamp) >= targetSeconds) return;
    await fetch(this.publicClient.transport.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "evm_setNextBlockTimestamp",
        params: [targetSeconds],
      }),
    });
    await fetch(this.publicClient.transport.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "evm_mine", params: [] }),
    });
  }
}
