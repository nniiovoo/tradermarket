// Game day: the real services driving REAL deployed contracts on a clean chain.
//
// No FakeRoomChain. The Source Gate Authority signs actual Publication Permits
// that an actual LiveRoom verifies, marks real epochs safe, and closes real
// markets. If this passes, the service-to-contract seam is proven; if it fails,
// something between them is wrong.
//
//   anvil --port 8545 &
//   npm run gameday
//
// Set GAMEDAY_RPC_URL to point elsewhere.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, toHex, encodePacked, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { deployGamedayRoom, setChainTime, account, ANVIL_KEYS, toBytes32 } from "./deploy-gameday.mjs";
import { MemoryEventStore, MemoryRawArchive, MemoryKeyValue } from "../src/ports/stores.mjs";
import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { ReplaySource } from "../src/connector/hyperliquid.mjs";
import { verifyChain, canonicalize } from "../src/domain/eventlog.mjs";
import { GateAuthority } from "../src/gate/authority.mjs";
import { ProgramPublisher, firstTemplateCatalog } from "../src/publisher/publisher.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";
import { OnChainRoom, LIVE_ROOM_ABI, MARKET_ABI } from "../src/ports/chain-viem.mjs";
import { KeeperService } from "../src/keeper/keeper.mjs";
import { createSigner, selectorsFor } from "../src/ports/signer.mjs";
import { conditionHash } from "../src/domain/conditions.mjs";
import { Metrics } from "../src/observability/metrics.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { ChainIndexer } from "../src/indexer/indexer.mjs";
import { ViemLogSource, ViemMarketReader } from "../src/indexer/chain-source.mjs";
import { verifyEventCoverage } from "../src/indexer/abi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.GAMEDAY_RPC_URL ?? "http://127.0.0.1:8545";
const U = 10n ** 6n;

const steps = [];
function step(name, ok, detail = "") {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "[32mok  [0m" : "[31mFAIL[0m"} ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  console.log("\nTraderMarket game day — real services against deployed contracts\n");

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  try {
    await publicClient.getBlockNumber();
  } catch {
    console.error(`No chain at ${RPC}.\nStart one first:\n\n  anvil --port 8545\n`);
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "gameday-session.json"), "utf8"));
  const deployment = await deployGamedayRoom({ rpc: RPC, fixture });
  const { abis, room, usdc, commitments, factory } = deployment;
  step("deploy USDC, implementations, factory, commitments, and an armed room", true, `room ${room.slice(0, 10)}…`);

  // The session clock: chain time and source time advance together.
  const startBlock = await publicClient.getBlock();
  let sessionStartS = Number(startBlock.timestamp) + 5;
  await setChainTime(RPC, sessionStartS);
  let clockMs = sessionStartS * 1000;

  // ------------------------------------------------------------- services
  const eventLog = new MemoryEventStore();
  const rawArchive = new MemoryRawArchive();
  const connectorAccount = privateKeyToAccount(ANVIL_KEYS.connector);
  const connector = new SourceConnector({
    roomId: fixture.room_id,
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive,
    signer: connectorAccount,
    clock: () => new Date(clockMs).toISOString(),
  });

  // Re-time the fixture onto the live chain clock.
  const offsetMs = clockMs - fixture.session_start_ms;
  const batches = fixture.batches.map((batch) => ({
    ...batch,
    at_ms: batch.at_ms + offsetMs,
    window_start_ms: batch.window_start_ms ? batch.window_start_ms + offsetMs : undefined,
    payload: Array.isArray(batch.payload)
      ? batch.payload.map((fill) => ({ ...fill, time: fill.time + offsetMs }))
      : batch.payload,
  }));
  const replay = new ReplaySource({ connector, batches });

  const chain = new OnChainRoom({
    publicClient,
    rpc: RPC,
    room,
    gateAccount: account("gate"),
  });
  const conditions = new Map();
  const gateState = new MemoryKeyValue();
  // Declared before the gate because the gate reports into it.
  const metrics = new Metrics({
    config: { epochDurationS: fixture.epoch_duration_s, sourceFinalityDelayS: fixture.finality_delay_s },
  });
  const gate = new GateAuthority({
    roomAddress: room,
    chainId: foundry.id,
    chain,
    store: eventLog,
    signer: account("gate"),
    conditions,
    state: gateState,
    metrics,
    // The gate renders the question itself and refuses a permit whose words
    // disagree with the rule that settles it (issue 43).
    catalog: firstTemplateCatalog(),
    config: {
      epochDurationS: fixture.epoch_duration_s,
      sourceFinalityDelayS: fixture.finality_delay_s,
      freshnessThresholdMs: fixture.freshness_threshold_ms,
      maxPermitLifetimeS: 300,
      maxPendingTimeS: fixture.max_pending_time_s,
      unevaluableGraceMs: 60_000,
      chainNow: async () => Number((await publicClient.getBlock()).timestamp),
      headlineMarket: null,
    },
  });

  // The publisher's chain adapter: a real transaction, signed by the real
  // publisher key, carrying the gate's real signature.
  const publisherChain = {
    async publishSlot(request, permit, signature, restricted) {
      const before = await publicClient.readContract({
        address: room,
        abi: abis.room,
        functionName: "slotCount",
      });
      await deployment.send("publisher", room, abis.room, "publishSlot", [
        {
          templateId: toBytes32(request.templateId),
          templateParamsHash: request.templateParamsHash,
          conditionHash: request.conditionHash,
          announceDelay: BigInt(request.announceDelay),
          winnerRewardBps: request.winnerRewardBps,
          question: request.question,
          streamUrl: request.streamUrl ?? "",
          imageUrl: request.imageUrl ?? "",
        },
        permit,
        signature,
        restricted,
      ]);
      const index = Number(before);
      return publicClient.readContract({
        address: room,
        abi: abis.room,
        functionName: "slotAt",
        args: [BigInt(index)],
      });
    },
    async requestHashFor(request, restricted) {
      return publicClient.readContract({
        address: room,
        abi: abis.room,
        functionName: "slotRequestHash",
        args: [
          {
            templateId: toBytes32(request.templateId),
            templateParamsHash: request.templateParamsHash,
            conditionHash: request.conditionHash,
            announceDelay: BigInt(request.announceDelay),
            winnerRewardBps: request.winnerRewardBps,
            question: request.question,
            streamUrl: request.streamUrl ?? "",
            imageUrl: request.imageUrl ?? "",
          },
          restricted,
        ],
      });
    },
    async chainNow() {
      const block = await publicClient.getBlock();
      return Number(block.timestamp);
    },
  };

  const publisher = new ProgramPublisher({
    chain: publisherChain,
    gate,
    catalog: firstTemplateCatalog(),
    config: { minAnnounceDelay: fixture.announce_delay_s },
  });

  // ---------------------------------------------------------- the headline
  await connector.heartbeat(new Date(clockMs).toISOString());
  const headlineResult = await publisher.requestSlot({
    slotIndex: 0,
    templateId: "tpl-participant-v1",
    params: { target: fixture.headline_target },
    streamUrl: "https://example.com/live",
  });
  if (headlineResult.status !== "published") {
    step("publish the headline slot with a gate permit", false, headlineResult.reason ?? headlineResult.status);
    return finish();
  }
  const headline = headlineResult.market;
  conditions.set(headline, headlineResult.conditionDocument);
  gate.config.headlineMarket = headline;
  step("publish the headline slot with a gate permit", true, `${headline.slice(0, 10)}…`);

  // The publisher key alone must not be able to publish.
  let publisherAloneFailed = false;
  try {
    await deployment.send("publisher", room, abis.room, "publishSlot", [
      {
        templateId: toBytes32("tpl-threshold-v1"),
        templateParamsHash: keccak256(toHex("x")),
        conditionHash: keccak256(toHex("y")),
        announceDelay: BigInt(fixture.announce_delay_s),
        winnerRewardBps: 0,
        question: "Unsigned",
        streamUrl: "",
        imageUrl: "",
      },
      {
        slotIndex: 1,
        requestHash: keccak256(toHex("x")),
        conditionHash: keccak256(toHex("y")),
        undecidedThroughSequence: 1n,
        announceDelay: BigInt(fixture.announce_delay_s),
        issuedAt: BigInt(await publisherChain.chainNow()),
        expiresAt: BigInt((await publisherChain.chainNow()) + 60),
        nonce: 999999n,
      },
      "0x" + "11".repeat(65),
      [],
    ]);
  } catch {
    publisherAloneFailed = true;
  }
  step("the publisher key alone cannot publish a slot", publisherAloneFailed);

  // ------------------------------------------------------ back the headline
  const openAtS = Number(
    await publicClient.readContract({ address: headline, abi: abis.market, functionName: "opensAt" })
  );
  await setChainTime(RPC, openAtS + 1);
  clockMs = (openAtS + 1) * 1000;
  await deployment.send("lp", usdc, abis.usdc, "approve", [headline, 5_000n * U]);
  await deployment.send("lp", headline, abis.market, "submitAddLiquidity", [
    2_000n * U,
    1n,
    BigInt(openAtS + 3600),
  ]);

  // The real gate ticks continuously; drive it until the deposit clears or the
  // maximum pending time proves it never will.
  let backed = false;
  for (let attempt = 0; attempt < 12 && !backed; attempt++) {
    await advance(fixture.epoch_duration_s);
    await connector.heartbeat(new Date(clockMs).toISOString());
    await gate.tick(clockMs);
    backed = await publicClient.readContract({
      address: headline,
      abi: abis.market,
      functionName: "hasLiquidity",
    });
  }
  step("the gate cleared the first liquidity epoch on chain", backed);

  // A real audience purchase, so the trade path and its projection are
  // exercised rather than assumed.
  const buyEpoch = Number(
    await publicClient.readContract({ address: headline, abi: abis.market, functionName: "currentEpoch" })
  );
  await deployment.send("trader", usdc, abis.usdc, "approve", [headline, 100n * U]);
  await deployment.send("trader", headline, abis.market, "submitBuy", [
    true,
    100n * U,
    1n,
    BigInt(Math.floor(clockMs / 1000) + 3600),
  ]);
  let bought = false;
  for (let attempt = 0; attempt < 12 && !bought; attempt++) {
    await advance(fixture.epoch_duration_s);
    await connector.heartbeat(new Date(clockMs).toISOString());
    await gate.tick(clockMs);
    const position = await publicClient.readContract({
      address: headline,
      abi: abis.market,
      functionName: "positionAOf",
      args: [account("trader").address],
    });
    bought = position > 0n;
  }
  step("an audience purchase cleared through a real source-gated epoch", bought, `epoch ${buyEpoch}`);

  // --------------------------------------------------------- micro slots
  const micros = [];
  for (const micro of fixture.micro_slots) {
    const result = await publisher.requestSlot({
      slotIndex: micros.length + 1,
      templateId: micro.template_id,
      params: micro.params,
    });
    if (result.status === "published") {
      conditions.set(result.market, result.conditionDocument);
      micros.push({ market: result.market, ...micro });
    }
    step(`publish micro slot: ${micro.question}`, result.status === "published", result.reason ?? "");
  }
  step("three sequential micro markets published", micros.length === 3, `${micros.length}/3`);

  // ------------------------------------------------- run the live session
  let sawSuspension = false;
  let sawReopen = false;
  let closedSeq = 0;

  for (let elapsed = 0; elapsed <= fixture.session_length_s; elapsed += fixture.epoch_duration_s) {
    await replay.advanceTo(clockMs);
    const inGap = elapsed >= fixture.gap_start_s && elapsed < fixture.gap_start_s + fixture.heartbeat_gap_s;
    if (!inGap) await connector.heartbeat(new Date(clockMs).toISOString());

    // Gate lag is observed by the gate itself now, against the source fact's
    // own timestamp — the quantity metrics.mjs defines. This used to time how
    // long `tick()` took and file it under the same name, which made the
    // game day's headline latency a measurement of the harness rather than of
    // the product.
    await gate.tick(clockMs);

    const suspendedNow = await chain.isSuspended();
    if (suspendedNow) sawSuspension = true;
    else if (sawSuspension) sawReopen = true;

    closedSeq = Number(await chain.roomClosedSequence());
    if (closedSeq !== 0) break;
    await advance(fixture.epoch_duration_s);
  }

  step("deliberate source silence suspended the room on chain", sawSuspension);
  step("recovery reopened the room on chain", sawReopen);
  step("the terminal condition closed the room on chain", closedSeq !== 0, `sequence ${closedSeq}`);

  // A keeper with no role finishes the close.
  const allMarkets = [headline, ...micros.map((entry) => entry.market)];
  const stillOpen = [];
  for (const market of allMarkets) {
    const gateStateValue = await publicClient.readContract({
      address: market,
      abi: abis.market,
      functionName: "gateState",
    });
    if (Number(gateStateValue) !== 2) stillOpen.push(market);
  }
  if (stillOpen.length > 0) {
    await deployment.send("keeper", room, abis.room, "closeRemainingSlots", [stillOpen]);
  }
  let allClosed = true;
  for (const market of allMarkets) {
    const value = await publicClient.readContract({ address: market, abi: abis.market, functionName: "gateState" });
    if (Number(value) !== 2) allClosed = false;
  }
  step("an unprivileged keeper closed every remaining slot", allClosed);

  // ------------------------------------------------------------ resolution
  const logEvents = await eventLog.all();
  let resolvedSlots = 0;
  for (const market of allMarkets) {
    const condition = conditions.get(market);
    if (!condition) continue;
    const verdicts = [];
    for (const name of ["resolver1", "resolver2"]) {
      const node = new ResolverNode({
        name,
        rawArchive,
        participants: fixture.participants,
        signerChain: {
          async attestResult(target, outcomeEnum, evidenceHash) {
            const receipt = await deployment.send(name, target, abis.market, "attestResult", [
              outcomeEnum,
              evidenceHash,
            ]);
            if (process.env.GAMEDAY_DEBUG) {
              console.log(
                `    debug attest ${name} -> ${target.slice(0, 10)} block=${receipt.blockNumber} logs=${receipt.logs.length}`
              );
            }
          },
        },
      });
      verdicts.push(
        await node.resolveSlot({
          market,
          condition,
          conditionHash: conditionHash(condition),
          headlineCondition: conditions.get(headline),
          logEvents,
          participantAKey: fixture.participants[0].key,
          participantBKey: fixture.participants[1].key,
        })
      );
    }
    const agreed =
      verdicts.every((entry) => entry.attested) && verdicts[0].evidenceHash === verdicts[1].evidenceHash;
    if (agreed) resolvedSlots++;
    step(`two resolvers agree from raw data for slot ${market.slice(0, 10)}…`, agreed, verdicts[0].reason ?? "");
  }
  step("every slot reached quorum from independent reconstruction", resolvedSlots === allMarkets.length);

  // Finalize after the challenge window — through the REAL keeper service, the
  // REAL chain port, and the REAL signer allow-list.
  //
  // This step used to call `finalizeUnchallenged` itself. That proved the
  // contract worked and hid the thing that mattered: no production process
  // called it. Every other step in this harness drives a production module, so
  // finalization being the one hand-rolled call is exactly why "markets are
  // never finalized" survived every suite until it was audited for.
  //
  // The signer is wrapped the way `buildOperator` wraps it, so this also proves
  // the keeper's allow-list PERMITS these three calls on a real transaction —
  // a selector set that is right in a unit test and wrong in the ABI would
  // otherwise fail only in a deployment.
  await advance(700);
  const keeperChain = new OnChainRoom({
    publicClient,
    rpc: RPC,
    room,
    account: createSigner({
      role: "keeper",
      privateKey: ANVIL_KEYS.keeper,
      allowedSelectors: selectorsFor("keeper", [...LIVE_ROOM_ABI, ...MARKET_ABI], {
        toSelector: toFunctionSelector,
      }),
    }),
  });
  const keeperPass = await new KeeperService({
    chain: keeperChain,
    chainNow: async () => Number((await publicClient.getBlock()).timestamp),
  }).tick();
  for (const entry of keeperPass.actions.filter((action) => action.error)) {
    console.error(`  keeper ${entry.action ?? "read"} ${entry.market}: ${entry.error}`);
  }
  const finalized = keeperPass.actions.filter((action) => !action.error).length;
  let allFinal = true;
  for (const market of allMarkets) {
    const outcome = await publicClient.readContract({
      address: market,
      abi: abis.market,
      functionName: "finalOutcome",
    });
    if (Number(outcome) === 0) allFinal = false;
  }
  step("every market finalized after its challenge window", allFinal, `${finalized} finalize calls`);

  // ---------------------------------------------------------------- claims
  let claimed = false;
  try {
    await deployment.send("lp", headline, abis.market, "settleLpInventory", []);
    claimed = true;
  } catch (error) {
    step("LP settles inventory", false, error.shortMessage ?? error.message);
  }
  if (claimed) step("LP settled inventory on the headline market", true);

  // ------------------------------------------------------- bond release
  const closedAt = Number(
    await publicClient.readContract({ address: room, abi: abis.room, functionName: "roomClosedAt" })
  );
  const claimWindow = Number(
    await publicClient.readContract({ address: room, abi: abis.room, functionName: "integrityClaimWindow" })
  );
  await setChainTime(RPC, closedAt + claimWindow + 1);
  let bondsReleased = 0;
  for (const name of ["participantA", "participantB"]) {
    try {
      await deployment.send(name, room, abis.room, "claimIntegrityBond", []);
      bondsReleased++;
    } catch (error) {
      step(`${name} claims the room bond`, false, error.shortMessage ?? error.message);
    }
  }
  step("both room Integrity Bonds released after settlement", bondsReleased === 2);

  const roomBalance = await publicClient.readContract({
    address: usdc,
    abi: abis.usdc,
    functionName: "balanceOf",
    args: [room],
  });
  step("the room retains no collateral", roomBalance === 0n, `${roomBalance} wei`);

  const routerBalance = await publicClient.readContract({
    address: usdc,
    abi: abis.usdc,
    functionName: "balanceOf",
    args: [commitments],
  });
  step("the liquidity router retains no collateral", routerBalance === 0n);

  // ------------------------------------------------------- log integrity
  const verdict = await verifyChain(await eventLog.all(), {
    verifySignature: makeSignatureVerifier(connectorAccount.address),
  });
  step("the session event log verifies end to end", verdict.ok, JSON.stringify(verdict.failures.slice(0, 2)));

  // ------------------------------------------- indexer against REAL logs
  //
  // This is the seam the in-memory fake could never test. The indexer decodes
  // actual chain logs with the compiled ABIs and reads real getters; if it
  // projects nothing, or projects something the chain disagrees with, this
  // fails here rather than in production.
  const coverage = verifyEventCoverage();
  step("every indexed event exists in the compiled ABI", coverage.ok, coverage.missing.join(", "));

  const store = new ProjectionStore();
  const logSource = new ViemLogSource({
    publicClient,
    factory,
    rooms: () => [room],
    markets: () => allMarkets,
  });
  const indexer = new ChainIndexer({
    store,
    logs: logSource,
    reader: new ViemMarketReader({ publicClient }),
  });
  // Uncached: a cached head silently truncates the indexed range.
  const head = await logSource.head();
  const applied = await indexer.syncTo(head);
  if (process.env.GAMEDAY_DEBUG) {
    const raw = await new ViemLogSource({
      publicClient, factory, rooms: () => [room], markets: () => allMarkets,
    }).getLogs({ fromBlock: 1, toBlock: head });
    const counts = {};
    for (const entry of raw) counts[entry.event] = (counts[entry.event] ?? 0) + 1;
for (const market of allMarkets) {
      const logs = await publicClient.getLogs({ address: market, fromBlock: 0n, toBlock: BigInt(head) });
      const [prov, fin] = await Promise.all([
        publicClient.readContract({ address: market, abi: abis.market, functionName: "provisionalOutcome" }),
        publicClient.readContract({ address: market, abi: abis.market, functionName: "finalOutcome" }),
      ]);
      const { parseEventLogs } = await import("viem");
      const names = parseEventLogs({ abi: abis.market, logs }).map((l) => l.eventName);
      console.log(
        `    debug ${market.slice(0, 10)} logs=${logs.length} provisional=${prov} final=${fin} events=${names.join(",")}`
      );
    }
  }
  step("the indexer decoded real chain logs", applied > 0, `${applied} logs`);

  const indexedRoom = store.getRoom(fixture.room_id);
  step(
    "the room projection matches the deployed room",
    indexedRoom?.live_room_address?.toLowerCase() === room.toLowerCase(),
    `projected ${indexedRoom?.live_room_address}`
  );
  step(
    "every published slot is in the projection",
    store.listSlots(fixture.room_id).length === allMarkets.length,
    `${store.listSlots(fixture.room_id).length}/${allMarkets.length}`
  );

  // The projection must agree with what the chain actually says, field by field.
  let projectionMatches = true;
  let mismatch = "";
  for (const market of allMarkets) {
    const projected = store.getMarket(market);
    const [gateStateValue, finalOutcome, totalLpShares, spotPriceA, reserveA, reserveB] = await Promise.all(
      ["gateState", "finalOutcome", "totalLpShares", "spotPriceA", "reserveA", "reserveB"].map((functionName) =>
        publicClient.readContract({ address: market, abi: abis.market, functionName })
      )
    );
    if (
      !projected ||
      Number(projected.gate_state) !== Number(gateStateValue) ||
      Number(projected.final_outcome) !== Number(finalOutcome) ||
      projected.total_lp_shares !== totalLpShares ||
      projected.implied_prob_a !== spotPriceA ||
      projected.reserve_a !== reserveA ||
      projected.reserve_b !== reserveB
    ) {
      projectionMatches = false;
      mismatch = `${market.slice(0, 10)} projected=${JSON.stringify(
        projected,
        (_, v) => (typeof v === "bigint" ? v.toString() : v)
      ).slice(0, 160)}`;
      break;
    }
  }
  step("every market projection matches on-chain state exactly", projectionMatches, mismatch);

  step("real trades were projected", store.listTrades().length > 0, `${store.listTrades().length} trades`);
  const traderHolding = store.getHolding(headline, account("trader").address);
  const onChainPosition = await publicClient.readContract({
    address: headline,
    abi: abis.market,
    functionName: "positionAOf",
    args: [account("trader").address],
  });
  step(
    "the projected position matches the chain",
    traderHolding.position_a === onChainPosition,
    `projected ${traderHolding.position_a} vs chain ${onChainPosition}`
  );
  step("resolver attestations were projected", store.attestations.length >= allMarkets.length * 2,
    `${store.attestations.length} attestations`);
  step("bond lifecycle was projected", store.listBonds(fixture.room_id).length === 2,
    `${store.listBonds(fixture.room_id).length} bonds`);

  const before = store.fingerprint();
  await indexer.rebuild(head);
  step("read models rebuild identically from real chain logs", store.fingerprint() === before);

  // ------------------------------------------------ gate restart safety
  const restarted = new GateAuthority({
    roomAddress: room,
    chainId: foundry.id,
    chain,
    store: eventLog,
    signer: account("gate"),
    conditions,
    state: gateState,
    config: gate.config,
  });
  // A restarted gate has not resumed until it loads. The durable store is async
  // now, so a constructor cannot do it — and a gate that is asked for its nonce
  // before loading answers 1, which is exactly the "resumed from zero" failure
  // this step exists to catch. Loading here is the restart, not a workaround.
  await restarted.load();
  step(
    "a restarted gate resumes from persisted state, not from zero",
    restarted.nextNonce === gate.nextNonce && restarted.audit.length === gate.audit.length,
    `nonce ${restarted.nextNonce}, ${restarted.audit.length} audit entries`
  );

  if (process.env.GAMEDAY_DEBUG) {
    console.log("    debug FINAL head:", Number(await publicClient.getBlockNumber()));
  }
  step("no page-level alert fired", metrics.pages().length === 0, JSON.stringify(metrics.report()));
  finish({ roomId: fixture.room_id, factory: deployment.factory, room: deployment.room });

  async function advance(seconds) {
    clockMs += seconds * 1000;
    await setChainTime(RPC, Math.floor(clockMs / 1000));
  }
}

function finish(serveConfig = null) {
  const failed = steps.filter((entry) => !entry.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} game-day checks passed`);
  if (failed.length > 0) {
    console.log("\nfailed:");
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log("Real services drove real contracts through a complete session.\n");
    // Print what an operator needs to serve this exact room, so the website can
    // be pointed at the chain the game day just exercised rather than at a
    // description of it.
    if (serveConfig) {
      console.log("To serve this room:");
      console.log(
        `  TM_ROOM_ID=${serveConfig.roomId} TM_RPC_URL=${RPC} \\
` +
          `  TM_FACTORY_ADDRESS=${serveConfig.factory} TM_ROOM_ADDRESS=${serveConfig.room} \\
` +
          `  TM_CHAIN_ID=31337 TM_ROOM_API_URL=http://127.0.0.1:8787 TM_PORT=8787 npm run serve\n`
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
