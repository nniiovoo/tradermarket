#!/usr/bin/env node
// Live-source game day: a real provider over real HTTP driving real contracts.
//
// The existing game day replays a recorded session. This one puts an actual
// HTTP server in front of the actual poller and then behaves the way providers
// behave: it repeats fills across overlapping windows, drops a connection,
// goes down for a stretch, and restates a figure it already reported.
//
// Each of those has a different right answer and only one of them is "ignore
// it". The check the whole run exists for is the last one: a market whose
// settled outcome follows the CORRECTED figure, and a recorded counterfactual
// showing the stale figure would have paid the other side.
//
//   anvil --port 8545 --silent &
//   npm run live-gameday

import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

import { deployGamedayRoom, setChainTime, account, ANVIL_KEYS, toBytes32 } from "./deploy-gameday.mjs";
import { SourceConnector, makeSignatureVerifier } from "../src/connector/connector.mjs";
import { HyperliquidPoller } from "../src/connector/hyperliquid.mjs";
import { GateAuthority } from "../src/gate/authority.mjs";
import { ProgramPublisher, firstTemplateCatalog } from "../src/publisher/publisher.mjs";
import { ResolverNode } from "../src/resolver/resolver.mjs";
import { OnChainRoom } from "../src/ports/chain-viem.mjs";
import { conditionHash, evaluateCondition, foldMetrics, outcomeToMarketEnum } from "../src/domain/conditions.mjs";
import { verifyChain } from "../src/domain/eventlog.mjs";
import { openDatabase, SqliteEventStore, SqliteKeyValue, SqliteRawArchive } from "../src/ports/sqlite-stores.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.GAMEDAY_RPC_URL ?? "http://127.0.0.1:8545";
const U = 10n ** 6n;
const PORT = Number(process.env.LIVE_GAMEDAY_PORT ?? 9921);

let cleanupHook = null;
const steps = [];
function step(name, ok, detail = "") {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A provider that misbehaves the way real ones do. */
function makeProvider(participants) {
  const fills = new Map(participants.map((p) => [p.address.toLowerCase(), []]));
  const accountValue = new Map([
    [participants[0].address.toLowerCase(), "50000"],
    [participants[1].address.toLowerCase(), "40000"],
  ]);
  const state = { down: false, requests: 0, windows: [] };

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      state.requests += 1;
      if (state.down) {
        // Not a 500: a real outage is a socket that dies mid-request.
        request.socket.destroy();
        return;
      }
      const query = JSON.parse(body);
      const user = String(query.user).toLowerCase();
      if (query.type === "clearinghouseState") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ marginSummary: { accountValue: accountValue.get(user) } }));
        return;
      }
      state.windows.push({ user, startTime: query.startTime, endTime: query.endTime });
      const inWindow = (fills.get(user) ?? []).filter(
        (entry) => entry.time >= query.startTime && entry.time <= query.endTime
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(inWindow));
    });
  });

  return {
    state,
    listen: () => new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve)),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
    add(address, entry) {
      fills.get(address.toLowerCase()).push(entry);
    },
    restate(address, tid, closedPnl) {
      const list = fills.get(address.toLowerCase());
      const index = list.findIndex((entry) => entry.tid === tid);
      list[index] = { ...list[index], closedPnl };
    },
  };
}

const fill = (tid, timeMs, closedPnl) => ({
  tid,
  time: timeMs,
  closedPnl,
  fee: "0",
  coin: "ETH",
  side: "B",
  px: "1",
  sz: "1",
});

async function main() {
  console.log("\nTraderMarket live-source game day — a real provider against real contracts\n");

  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  try {
    await publicClient.getBlockNumber();
  } catch {
    console.error(`No chain at ${RPC}.\nStart one first:\n\n  anvil --port 8545\n`);
    process.exit(2);
  }

  const fixture = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "gameday-session.json"), "utf8"));
  const participants = fixture.participants;
  const [alice, bob] = participants.map((entry) => entry.address);
  const deployment = await deployGamedayRoom({ rpc: RPC, fixture });
  const { abis, room, usdc } = deployment;
  step("deploy a room and arm it", true, `room ${room.slice(0, 10)}…`);

  const provider = makeProvider(participants);
  await provider.listen();
  let closeDatabase = () => {};
  cleanupHook = async () => {
    closeDatabase();
    await provider.close();
  };

  const dataDir = mkdtempSync(join(tmpdir(), "tm-live-gameday-"));
  const dbPath = join(dataDir, "room.db");
  const database = openDatabase(dbPath);
  const eventLog = new SqliteEventStore(database);
  const rawArchive = new SqliteRawArchive(database);
  const durableState = new SqliteKeyValue(database);
  closeDatabase = () => database.close();

  const startBlock = await publicClient.getBlock();
  const sessionStartS = Number(startBlock.timestamp) + 5;
  await setChainTime(RPC, sessionStartS);
  let clockMs = sessionStartS * 1000;
  const advance = async (seconds) => {
    clockMs += seconds * 1000;
    await setChainTime(RPC, Math.floor(clockMs / 1000));
  };

  const connectorAccount = privateKeyToAccount(ANVIL_KEYS.connector);
  const connector = new SourceConnector({
    roomId: fixture.room_id,
    source: "hyperliquid-testnet",
    store: eventLog,
    rawArchive,
    signer: connectorAccount,
    clock: () => new Date(clockMs).toISOString(),
  });
  const poller = new HyperliquidPoller({
    connector,
    participants,
    infoUrl: `http://127.0.0.1:${PORT}/info`,
    now: () => clockMs,
    cursors: durableState,
    reconcileLookbackMs: 60 * 60_000,
  });
  const pnl = async (key) => foldMetrics(await eventLog.all()).get(key)?.cumRealizedPnlUsd ?? "0";
  const pollQuietly = async () => {
    try {
      return await poller.pollOnce();
    } catch {
      return null; // the provider is down; the gate is about to notice
    }
  };

  // ---------------------------------------------------------------- baseline
  await poller.captureBaselines();
  step(
    "the poller captured a session baseline over real HTTP",
    (await eventLog.all()).filter((event) => event.kind === "baseline").length === participants.length
  );

  // ------------------------------------------------- duplicates and windows
  provider.add(alice, fill(1, clockMs + 1_000, "4000"));
  for (let round = 0; round < 3; round++) {
    await advance(30);
    await poller.pollOnce();
  }
  const afterDuplicates = (await eventLog.all()).filter((event) => event.kind === "trade_closed").length;
  step(
    "one fill seen across three overlapping windows is recorded once",
    afterDuplicates === 1,
    `${afterDuplicates} trade event(s)`
  );

  // ----------------------------------------------------------- a dropped connection
  provider.state.down = true;
  let reconnectErrored = false;
  try {
    await poller.pollOnce();
  } catch {
    reconnectErrored = true;
  }
  step("a dropped connection raises rather than reporting an empty poll", reconnectErrored);

  // Trades happen while the provider is unreachable.
  provider.add(alice, fill(2, clockMs + 2_000, "3000"));
  provider.add(bob, fill(3, clockMs + 2_500, "1000"));
  await advance(60);
  provider.state.down = false;
  await poller.pollOnce();
  const alicePnlAfterOutage = await pnl("alice");
  const bobPnlAfterOutage = await pnl("bob");
  step(
    "the failed window is re-asked, so nothing from the outage is lost",
    alicePnlAfterOutage === "7000" && bobPnlAfterOutage === "1000",
    `alice ${alicePnlAfterOutage}, bob ${bobPnlAfterOutage}`
  );

  // ------------------------------------------------------------- restatement
  // The provider restates a fill the forward-only window passed long ago.
  provider.restate(alice, 1, "1500");
  await advance(30);
  await poller.pollOnce();
  const beforeSweep = await pnl("alice");
  const corrections = await poller.reconcile(clockMs);
  const afterSweep = await pnl("alice");
  step(
    "a restated older fill is invisible to the forward window and caught by the sweep",
    beforeSweep === "7000" && afterSweep === "4500" && corrections.some((event) => event.corrects),
    `before ${beforeSweep}, after ${afterSweep}`
  );
  step(
    "the superseded event is kept, not overwritten",
    (await eventLog.all()).filter((event) => event.source_event_id === `${alice.toLowerCase()}:1`).length === 2
  );

  // ----------------------------------------------------------------- services
  const chain = new OnChainRoom({ publicClient, rpc: RPC, room, gateAccount: account("gate") });
  const conditions = new Map();
  const gateState = durableState;
  const gate = new GateAuthority({
    roomAddress: room,
    chainId: foundry.id,
    chain,
    store: eventLog,
    signer: account("gate"),
    conditions,
    state: gateState,
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
      return publicClient.readContract({
        address: room,
        abi: abis.room,
        functionName: "slotAt",
        args: [BigInt(Number(before))],
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
      return Number((await publicClient.getBlock()).timestamp);
    },
  };
  const publisher = new ProgramPublisher({
    chain: publisherChain,
    gate,
    catalog: firstTemplateCatalog(),
    config: { minAnnounceDelay: fixture.announce_delay_s },
  });

  // ------------------------------------------------------------ publication
  //
  // A room will not publish a second slot while its headline is unbacked, so
  // the order here is the order an operator actually has to follow: publish the
  // headline, back it, then open the market the correction decides.
  const openAndBack = async (market, size) => {
    const opensAt = Number(
      await publicClient.readContract({ address: market, abi: abis.market, functionName: "opensAt" })
    );
    if (opensAt + 1 > Math.floor(clockMs / 1000)) {
      clockMs = (opensAt + 1) * 1000;
      await setChainTime(RPC, opensAt + 1);
    }
    await pollQuietly();
    await deployment.send("lp", usdc, abis.usdc, "approve", [market, size * 3n]);
    await deployment.send("lp", market, abis.market, "submitAddLiquidity", [
      size,
      1n,
      BigInt(Math.floor(clockMs / 1000) + 3600),
    ]);
    for (let attempt = 0; attempt < 12; attempt++) {
      await advance(fixture.epoch_duration_s);
      await pollQuietly();
      await gate.tick(clockMs);
      const backed = await publicClient.readContract({
        address: market,
        abi: abis.market,
        functionName: "hasLiquidity",
      });
      if (backed) return true;
    }
    return false;
  };

  const headlineResult = await publisher.requestSlot({
    slotIndex: 0,
    templateId: "tpl-participant-v1",
    params: { target: fixture.headline_target },
  });
  if (headlineResult.status !== "published") {
    step("publish the headline slot from the live log", false, headlineResult.reason ?? headlineResult.status);
    return;
  }
  const headline = headlineResult.market;
  conditions.set(headline, headlineResult.conditionDocument);
  gate.config.headlineMarket = headline;
  step("publish the headline slot from the live log", true, `${headline.slice(0, 10)}…`);

  const headlineBacked = await openAndBack(headline, 2_000n * U);
  step("the gate cleared the headline's liquidity epoch from the live log", headlineBacked);

  // The market the correction decides. Alice's realized PnL is 4500 after the
  // restatement and read 7000 before it: this question answers No on what the
  // provider now says, and Yes on what it withdrew.
  const thresholdResult = await publisher.requestSlot({
    slotIndex: 1,
    templateId: "tpl-threshold-v1",
    params: { participant: "alice", metric: "realized_pnl_usd", operator: ">=", value: "6000" },
  });
  if (thresholdResult.status !== "published") {
    step("publish the market the correction decides", false, thresholdResult.reason ?? thresholdResult.status);
    return;
  }
  const threshold = thresholdResult.market;
  conditions.set(threshold, thresholdResult.conditionDocument);
  step("publish the market the correction decides", true, `${threshold.slice(0, 10)}…`);

  // --------------------------------------------------------- money on the line
  const backed = await openAndBack(threshold, 2_000n * U);
  step("the gate cleared a liquidity epoch on the decisive market", backed);

  // The trader buys Yes — the answer the stale figure supported.
  await deployment.send("trader", usdc, abis.usdc, "approve", [threshold, 100n * U]);
  await deployment.send("trader", threshold, abis.market, "submitBuy", [
    true,
    100n * U,
    1n,
    BigInt(Math.floor(clockMs / 1000) + 3600),
  ]);
  let bought = false;
  for (let attempt = 0; attempt < 12 && !bought; attempt++) {
    await advance(fixture.epoch_duration_s);
    await pollQuietly();
    await gate.tick(clockMs);
    const position = await publicClient.readContract({
      address: threshold,
      abi: abis.market,
      functionName: "positionAOf",
      args: [account("trader").address],
    });
    bought = position > 0n;
  }
  step("an audience purchase cleared through a live source-gated epoch", bought);

  // ------------------------------------------------- an outage mid-session
  provider.state.down = true;
  let suspended = false;
  for (let attempt = 0; attempt < 10 && !suspended; attempt++) {
    await advance(fixture.epoch_duration_s);
    await pollQuietly();
    await gate.tick(clockMs);
    suspended = await chain.isSuspended();
  }
  step("a provider outage suspended the room on chain", suspended);

  provider.state.down = false;
  let reopened = false;
  for (let attempt = 0; attempt < 10 && !reopened; attempt++) {
    await advance(fixture.epoch_duration_s);
    await pollQuietly();
    await gate.tick(clockMs);
    reopened = !(await chain.isSuspended());
  }
  step("recovery reopened the room on chain", reopened);

  // ---------------------------------------------------------- the decision
  // Bob reaches the headline target, which ends the session. Alice's total is
  // untouched from here, so the corrected 4500 is the figure the market settles on.
  provider.add(bob, fill(9, clockMs + 1_000, "20000"));
  let closedSeq = 0;
  for (let attempt = 0; attempt < 12 && closedSeq === 0; attempt++) {
    await advance(fixture.epoch_duration_s);
    await pollQuietly();
    await gate.tick(clockMs);
    closedSeq = Number(await chain.roomClosedSequence());
  }
  step("the room closed on a decisive event from the live source", closedSeq !== 0, `source seq ${closedSeq}`);

  const allMarkets = [headline, threshold];
  const stillOpen = [];
  for (const market of allMarkets) {
    const value = await publicClient.readContract({ address: market, abi: abis.market, functionName: "gateState" });
    if (Number(value) !== 2) stillOpen.push(market);
  }
  if (stillOpen.length > 0) await deployment.send("keeper", room, abis.room, "closeRemainingSlots", [stillOpen]);

  // ------------------------------------------------------------- resolution
  const logEvents = await eventLog.all();
  const outcomes = new Map();
  for (const market of allMarkets) {
    const condition = conditions.get(market);
    const verdicts = [];
    for (const name of ["resolver1", "resolver2"]) {
      const node = new ResolverNode({
        name,
        rawArchive,
        participants,
        signerChain: {
          async attestResult(target, outcomeEnum, evidenceHash) {
            await deployment.send(name, target, abis.market, "attestResult", [outcomeEnum, evidenceHash]);
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
          participantAKey: participants[0].key,
          participantBKey: participants[1].key,
        })
      );
    }
    const agreed =
      verdicts.every((entry) => entry.attested) && verdicts[0].evidenceHash === verdicts[1].evidenceHash;
    if (agreed) outcomes.set(market, verdicts[0].outcomeEnum);
    step(
      `two resolvers rebuilt slot ${market.slice(0, 10)}… from raw bytes and agreed`,
      agreed,
      verdicts[0].reason ?? `outcome ${verdicts[0].outcomeEnum}`
    );
  }

  await advance(700);
  for (const market of allMarkets) {
    try {
      await deployment.send("keeper", market, abis.market, "finalizeUnchallenged", []);
    } catch {
      // Counted below by reading the chain rather than by trusting the call.
    }
  }
  const finalOutcome = new Map();
  for (const market of allMarkets) {
    finalOutcome.set(
      market,
      Number(await publicClient.readContract({ address: market, abi: abis.market, functionName: "finalOutcome" }))
    );
  }
  step(
    "every market finalized on chain",
    [...finalOutcome.values()].every((value) => value !== 0),
    [...finalOutcome.values()].join(", ")
  );

  // ----------------------------------------- what the correction was worth
  //
  // The whole run turns on this. The same evaluator, the same condition, the
  // same log — minus the restatement the sweep recovered — answers the other
  // way. Had the correction been dropped, this market would have paid Yes.
  const condition = conditions.get(threshold);
  const stale = logEvents.filter((event) => !event.corrects);
  const staleHeadline = evaluateCondition(conditions.get(headline), stale);
  const staleDecision = evaluateCondition(condition, stale, {
    terminalSeq: staleHeadline.status === "decided" ? staleHeadline.seq : null,
  });
  const staleEnum =
    staleDecision.status === "decided"
      ? outcomeToMarketEnum(staleDecision.outcome, participants[0].key, participants[1].key)
      : 0;
  step(
    "the settled outcome is the corrected one",
    finalOutcome.get(threshold) === 2,
    `on chain ${finalOutcome.get(threshold)} (No), alice realized ${await pnl("alice")}`
  );
  step(
    "and the stale figure would have paid the other side",
    staleEnum === 1 && staleEnum !== finalOutcome.get(threshold),
    `stale evaluation ${staleEnum} (Yes) vs settled ${finalOutcome.get(threshold)} (No)`
  );

  // The trader bought Yes. On the corrected result that position is worthless,
  // which is the correct answer and not a pleasant one — the point is that the
  // chain agrees with the raw bytes.
  const traderPosition = await publicClient.readContract({
    address: threshold,
    abi: abis.market,
    functionName: "positionAOf",
    args: [account("trader").address],
  });
  step(
    "the losing position is held against the corrected result, not the stale one",
    traderPosition > 0n && finalOutcome.get(threshold) === 2,
    `${traderPosition} Yes positions, market settled No`
  );

  let lpSettled = false;
  try {
    await deployment.send("lp", threshold, abis.market, "settleLpInventory", []);
    lpSettled = true;
  } catch (error) {
    step("the LP settles inventory on the decided market", false, error.shortMessage ?? error.message);
  }
  if (lpSettled) step("the LP settles inventory on the decided market", true);

  // ---------------------------------------------------------- the whole log
  const verification = await verifyChain(await eventLog.all(), {
    verifySignature: makeSignatureVerifier(connectorAccount.address),
  });
  step(
    "the live session's event log verifies end to end",
    verification.ok,
    JSON.stringify(verification.failures.slice(0, 2))
  );

  database.close();
  closeDatabase = () => {};
  const reopenedDb = openDatabase(dbPath);
  const restored = new SqliteEventStore(reopenedDb);
  const restoredEvents = await restored.all();
  step(
    "every fact the session produced survived a restart",
    restoredEvents.length === logEvents.length,
    `${restoredEvents.length} events`
  );
  const restoredCursor = await new SqliteKeyValue(reopenedDb).get(`poller:cursor:${alice.toLowerCase()}`, null);
  step(
    "and the poller would resume from its own cursor rather than the beginning",
    restoredCursor !== null,
    `cursor ${restoredCursor}`
  );
  reopenedDb.close();

  step(
    "the provider was really spoken to over HTTP",
    provider.state.requests > 0 && provider.state.windows.every((window) => window.endTime >= window.startTime),
    `${provider.state.requests} requests, ${provider.state.windows.length} closed windows`
  );

  rmSync(dataDir, { recursive: true, force: true });
}

function finish() {
  const failed = steps.filter((entry) => !entry.ok);
  console.log(`\n${steps.length - failed.length}/${steps.length} live-source checks passed`);
  if (failed.length > 0) {
    console.log("\nfailed:");
    for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? `: ${entry.detail}` : ""}`);
    process.exitCode = 1;
  } else {
    console.log(
      "A real provider — duplicates, a reconnect, an outage and a restatement — drove real contracts,\n" +
        "and the market settled on what the provider now says rather than what it withdrew.\n"
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanupHook?.();
    finish();
  });
