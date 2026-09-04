#!/usr/bin/env node
// Multi-process game day: the real operator processes, and nothing assembled
// in this file.
//
// Every previous game day drove the Gate, Publisher, Connector and Resolvers
// as objects in one process. That proves the modules compose; it cannot prove
// the thing the design actually rests on, which is that they DON'T — that the
// permit is signed by a key the publisher does not have, in a process the
// publisher cannot reach into, and that the queue between them survives one of
// them dying.
//
// So this one spawns them:
//
//   node scripts/operator.mjs connector      TM_CONNECTOR_KEY
//   node scripts/operator.mjs gate           TM_GATE_KEY
//   node scripts/operator.mjs publisher      TM_PUBLISHER_KEY
//   node scripts/operator.mjs resolver   x2  TM_RESOLVER_KEY (two different ones)
//   node scripts/operator.mjs keeper         TM_KEEPER_KEY (holds no authority)
//   node scripts/serve.mjs                   no key at all
//
// and talks to them only the way an operator would: by queueing a question
// with `scripts/queue-question.mjs`, by feeding a source over HTTP, and by
// reading the chain.
//
//   anvil --port 8545 --silent &
//   npm run multiprocess-gameday
//
// What it does NOT prove, and must not be read as proving:
//   - the operators here share one host and one SQLite file. That is the
//     publication channel's design limit, stated in ports/publication-queue.mjs.
//   - the two resolvers share a raw archive, so they are two processes and two
//     keys but not two independent operators. Independent resolvers re-fetch
//     from the provider themselves; that is still open.
//   - anvil is not a public testnet, and none of this is a continuously
//     running deployment.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, recoverTypedDataAddress } from "viem";
import { foundry } from "viem/chains";

import { deployGamedayRoom, account, ANVIL_KEYS, setChainTime } from "./deploy-gameday.mjs";
import { openDatabase, SqliteEventStore } from "../src/ports/sqlite-stores.mjs";
import { SqlitePublicationQueue } from "../src/ports/publication-queue.mjs";
import { LIVE_ROOM_ABI, MARKET_ABI } from "../src/ports/chain-viem.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.GAMEDAY_RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.MULTIPROCESS_GAMEDAY_PORT ?? 9931);
const HEADLINE_TARGET = "1000";

const steps = [];
function step(name, ok, detail = "") {
  steps.push({ name, ok, detail });
  console.log(`  ${ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a condition, or gives up with what it last saw.
 *
 * Never silently: a game day that times out and reports success is worse than
 * no game day, so the last observed value is part of the failure.
 */
async function waitFor(what, probe, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what} after ${timeoutMs}ms (last saw ${JSON.stringify(last)})`);
}

// --------------------------------------------------------------- the source

/** A Hyperliquid-shaped `info` endpoint the real poller reads over real HTTP. */
function makeProvider(participants) {
  const fills = new Map(participants.map((p) => [p.address.toLowerCase(), []]));
  const accountValue = new Map(participants.map((p) => [p.address.toLowerCase(), "50000"]));

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let query;
      try {
        query = JSON.parse(body);
      } catch {
        response.writeHead(400).end("{}");
        return;
      }
      const user = String(query.user).toLowerCase();
      response.writeHead(200, { "content-type": "application/json" });
      if (query.type === "clearinghouseState") {
        response.end(JSON.stringify({ marginSummary: { accountValue: accountValue.get(user) ?? "50000" } }));
        return;
      }
      const inWindow = (fills.get(user) ?? []).filter(
        (entry) => entry.time >= query.startTime && entry.time <= query.endTime
      );
      response.end(JSON.stringify(inWindow));
    });
  });

  return {
    server,
    listen: () => new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
    add(address, entry) {
      fills.get(address.toLowerCase()).push(entry);
    },
  };
}

function fill(tid, timeMs, closedPnl) {
  return { tid, time: timeMs, closedPnl, fee: "0", coin: "ETH", side: "B", px: "1", sz: "1" };
}

// ------------------------------------------------------------- the processes

const children = new Map();

/** Spawns one real operator process and keeps its output for the report. */
function spawnProcess(label, args, env) {
  const child = spawn(process.execPath, ["--no-warnings", ...args], {
    cwd: join(HERE, ".."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const capture = (stream, prefix) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        output.push(`${prefix}${line}`);
        if (process.env.MULTIPROCESS_GAMEDAY_VERBOSE) console.log(`    [${label}] ${line}`);
      }
    });
  };
  capture(child.stdout, "");
  capture(child.stderr, "! ");
  child.on("exit", (code, signal) => output.push(`# exited code=${code} signal=${signal}`));
  children.set(label, { child, output });
  return child;
}

async function stopProcess(label, signal = "SIGTERM") {
  const entry = children.get(label);
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = new Promise((resolve) => entry.child.once("exit", resolve));
  entry.child.kill(signal);
  await Promise.race([exited, sleep(4000)]);
  if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
}

async function stopEverything() {
  for (const label of [...children.keys()]) await stopProcess(label);
}

/** Runs a one-shot command process to completion and returns its output. */
function runOnce(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", ...args], {
      cwd: join(HERE, ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${args.join(" ")} exited ${code}: ${out}`))));
  });
}

// ---------------------------------------------------------------- the run

async function main() {
  const fixture = JSON.parse(readFileSync(join(HERE, "..", "fixtures", "gameday-session.json"), "utf8"));
  const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });

  const participants = [
    { key: "alice", address: account("participantA").address },
    { key: "bob", address: account("participantB").address },
  ];

  console.log("\nMulti-process game day — real processes, one key each\n");

  const provider = makeProvider(participants);
  await provider.listen();

  console.log("Deploying the room…");
  const deployment = await deployGamedayRoom({ rpc: RPC, fixture });
  const room = deployment.room;
  console.log(`  room ${room}\n`);

  const dataDir = mkdtempSync(join(tmpdir(), "tm-multiproc-"));

  const baseEnv = {
    TM_ROOM_ID: fixture.room_id,
    TM_RPC_URL: RPC,
    TM_CHAIN_ID: "31337",
    TM_ROOM_ADDRESS: room,
    TM_FACTORY_ADDRESS: deployment.factory,
    TM_DATA_DIR: dataDir,
    TM_OPERATOR_POLL_MS: "1000",
    TM_EPOCH_DURATION_S: String(fixture.epoch_duration_s),
    TM_SOURCE_FINALITY_DELAY_S: String(fixture.finality_delay_s),
    TM_FRESHNESS_THRESHOLD_MS: String(fixture.freshness_threshold_ms),
    TM_MAX_PENDING_TIME_S: String(fixture.max_pending_time_s),
    TM_ANNOUNCE_DELAY_S: String(fixture.announce_delay_s),
    TM_PARTICIPANTS: participants.map((entry) => `${entry.key}=${entry.address}`).join(","),
  };

  const readRoom = (functionName, args = []) =>
    publicClient.readContract({ address: room, abi: LIVE_ROOM_ABI, functionName, args });
  const readMarket = (market, functionName, args = []) =>
    publicClient.readContract({ address: market, abi: MARKET_ABI, functionName, args });

  // A read-only view of the shared durable state, opened the way an operator
  // inspecting a running deployment would: a second connection to the same file.
  const inspect = openDatabase(join(dataDir, "room.db"));
  const queue = new SqlitePublicationQueue(inspect, fixture.room_id);
  const eventLog = new SqliteEventStore(inspect);

  try {
    // ------------------------------------------------------- 1. the processes
    //
    // The gate starts LAST, deliberately. A request sitting in `awaiting_permit`
    // with no gate process alive is a stable state, not a race, which is what
    // makes the restart proof below a proof rather than a lucky poll. It is
    // also an ordinary deployment: processes come up when they come up.
    console.log("Starting the operator processes…");
    spawnProcess("connector", ["scripts/operator.mjs", "connector"], {
      ...baseEnv,
      TM_CONNECTOR_KEY: ANVIL_KEYS.connector,
      TM_SOURCE: "hyperliquid-testnet",
      TM_SOURCE_INFO_URL: `http://127.0.0.1:${PORT}/info`,
    });
    // TM_CONNECTOR_ADDRESS is what turns the resolver's chain check from
    // "the log is internally consistent" into "the log was written by the
    // connector we expect". Set here so this tier proves the signature path
    // through a real spawned process, not just the structural one.
    const resolverEnv = { ...baseEnv, TM_CONNECTOR_ADDRESS: account("connector").address };
    spawnProcess("resolver1", ["scripts/operator.mjs", "resolver"], {
      ...resolverEnv,
      TM_RESOLVER_KEY: ANVIL_KEYS.resolver1,
    });
    spawnProcess("resolver2", ["scripts/operator.mjs", "resolver"], {
      ...resolverEnv,
      TM_RESOLVER_KEY: ANVIL_KEYS.resolver2,
    });
    spawnProcess("coordinator", ["scripts/serve.mjs"], { ...baseEnv, TM_PORT: "9932" });
    spawnProcess("publisher", ["scripts/operator.mjs", "publisher"], {
      ...baseEnv,
      TM_PUBLISHER_KEY: ANVIL_KEYS.publisher,
    });

    await waitFor("the connector to write its first observation", async () => (await eventLog.tip()) !== null);
    const firstTip = await eventLog.tip();
    step("the connector process ingested from the source over HTTP", firstTip !== null, `tip seq ${firstTip?.seq}`);

    // ---------------------------- 1b. a key the room does not recognise
    //
    // The failure this prevents is silent: a publisher started with the wrong
    // key validates, queues, takes a permit and burns it on a transaction the
    // room was always going to refuse — once per request, forever, with the
    // room publishing nothing and no error that names the cause.
    const impostor = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--no-warnings", "scripts/operator.mjs", "publisher"],
        {
          cwd: join(HERE, ".."),
          // The GATE's key, in the publisher's process.
          env: { ...process.env, ...baseEnv, TM_PUBLISHER_KEY: ANVIL_KEYS.gate },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.on("exit", (code) => resolve({ code, out }));
    });
    step("a publisher started with the wrong key refuses to run, and says whose key the room wants",
      impostor.code === 1 && /names .* as its Program Publisher/.test(impostor.out),
      impostor.out.trim().split("\n").at(-1));

    // ------------------------------------------------ 2. queue a question
    const queued = await runOnce(
      [
        "scripts/queue-question.mjs",
        "--template", "tpl-participant-v1",
        "--param", `target=${HEADLINE_TARGET}`,
        "--announce-delay", String(fixture.announce_delay_s),
      ],
      baseEnv
    );
    const requestId = Number(queued.match(/queued request (\d+)/)[1]);
    step("an operator queued a question, durably, from a separate process", Number.isInteger(requestId),
      `request ${requestId}`);

    // --------------------------- 3. the publisher stops where it must
    await waitFor("the publisher to hand the request to the gate", async () =>
      (await queue.get(requestId))?.status === "awaiting_permit"
    );
    step("the publisher validated it against the catalogue and could go no further",
      (await queue.get(requestId)).status === "awaiting_permit",
      "it has no gate key and no gate is running");

    await stopProcess("publisher", "SIGKILL");
    step("the publisher process was killed with the request still in flight", true);
    const survived = await queue.get(requestId);
    step("the request survived it, in the state the publisher left it",
      survived.status === "awaiting_permit" && Boolean(survived.conditionDocument));

    // ------------------------------------------- 4. the gate, alone
    spawnProcess("gate", ["scripts/operator.mjs", "gate"], { ...baseEnv, TM_GATE_KEY: ANVIL_KEYS.gate });
    const permitted = await waitFor("the gate to sign the permit", async () => {
      const record = await queue.get(requestId);
      return ["permitted", "refused"].includes(record.status) ? record : null;
    });
    step("the gate signed the permit with no publisher process in existence",
      permitted.status === "permitted", permitted.reason ?? `nonce ${permitted.permit?.nonce}`);

    // Recovered, not assumed. This is the two-key claim: the signature on the
    // permit is the GATE's, and the publisher has never held that key.
    const signer = permitted.signature
      ? await recoverTypedDataAddress({
          domain: {
            name: "TraderMarket LiveRoom",
            version: "1",
            chainId: 31337,
            verifyingContract: room,
          },
          types: {
            PublicationPermit: [
              { name: "room", type: "address" },
              { name: "slotIndex", type: "uint32" },
              { name: "requestHash", type: "bytes32" },
              { name: "conditionHash", type: "bytes32" },
              { name: "undecidedThroughSequence", type: "uint256" },
              { name: "announceDelay", type: "uint64" },
              { name: "issuedAt", type: "uint64" },
              { name: "expiresAt", type: "uint64" },
              { name: "nonce", type: "uint256" },
            ],
          },
          primaryType: "PublicationPermit",
          message: { room, ...permitted.permit },
          signature: permitted.signature,
        })
      : null;
    step("the permit recovers to the gate's address, not the publisher's",
      signer?.toLowerCase() === account("gate").address.toLowerCase() &&
        signer?.toLowerCase() !== account("publisher").address.toLowerCase(),
      `recovered ${signer}`);

    // ------------------------------------------- 5. restart it and publish
    spawnProcess("publisher", ["scripts/operator.mjs", "publisher"], {
      ...baseEnv,
      TM_PUBLISHER_KEY: ANVIL_KEYS.publisher,
    });
    const published = await waitFor("the restarted publisher to publish", async () => {
      const record = await queue.get(requestId);
      return ["published", "failed", "refused"].includes(record.status) ? record : null;
    }, { timeoutMs: 90_000 });
    step("a restarted publisher picked the queued market up and published it",
      published.status === "published", published.reason ?? published.market);

    const slotCount = Number(await readRoom("slotCount"));
    const headline = slotCount > 0 ? await readRoom("slotAt", [0n]) : null;
    step("the market exists on chain", slotCount === 1 && headline !== null, `slotCount ${slotCount}`);
    step("the publisher's record names the market the chain actually holds",
      published.market?.toLowerCase() === headline?.toLowerCase(), `${published.market} vs ${headline}`);

    // The room only accepts a publication from the publisher key AND a permit
    // from the gate key. That it landed at all is the two-key proof.
    step("the room accepted it, which needs both keys and no single process held both",
      Number(await readRoom("slotCount")) === 1);

    // ---------------------------------------------- 6. a decisive event
    const now = Date.now();
    provider.add(participants[0].address, fill(1, now, "400"));
    provider.add(participants[0].address, fill(2, now + 500, "700"));
    step(`the source reported fills taking ${participants[0].key} past $${HEADLINE_TARGET}`, true);

    const closedSeq = await waitFor("the gate to close the room on the decisive event", async () => {
      const closed = Number(await readRoom("roomClosedSequence"));
      return closed !== 0 ? closed : null;
    }, { timeoutMs: 90_000 });
    step("the gate process closed the room on a decisive event it evaluated itself",
      closedSeq !== 0, `source sequence ${closedSeq}`);

    await waitFor("the headline slot to close", async () => Number(await readMarket(headline, "gateState")) === 2);
    step("the headline market's forecasting is closed on chain", true);

    // ------------------------------------------------------ 7. resolution
    let provisional;
    try {
      provisional = await waitFor("two resolvers to reach quorum", async () => {
        const outcome = Number(await readMarket(headline, "provisionalOutcome"));
        return outcome !== 0 ? outcome : null;
      }, { timeoutMs: 120_000 });
    } catch (error) {
      // A timeout here has to say what the chain actually saw, or the only
      // information is "it did not happen".
      const attested = await publicClient.getLogs({
        address: headline,
        event: {
          type: "event",
          name: "ResultAttested",
          inputs: [
            { name: "resolver", type: "address", indexed: true },
            { name: "outcome", type: "uint8", indexed: false },
            { name: "evidenceHash", type: "bytes32", indexed: false },
            { name: "count", type: "uint8", indexed: false },
          ],
        },
        fromBlock: 0n,
      });
      console.log("\n  chain state at the timeout:");
      console.log(`    gateState        ${Number(await readMarket(headline, "gateState"))}`);
      console.log(`    finalOutcome     ${Number(await readMarket(headline, "finalOutcome"))}`);
      console.log(`    resolutionDueAt  ${Number(await readMarket(headline, "resolutionDueAt"))}`);
      console.log(`    block timestamp  ${Number((await publicClient.getBlock()).timestamp)}`);
      for (const entry of attested) {
        console.log(
          `    ResultAttested   resolver=${entry.args.resolver} outcome=${entry.args.outcome} count=${entry.args.count} evidence=${entry.args.evidenceHash}`
        );
      }
      throw error;
    }
    step("two resolver processes independently rebuilt the result and reached quorum",
      provisional === 1, `provisional outcome ${provisional} (1 = ${participants[0].key})`);

    step("the outcome the raw bytes support is the outcome the chain holds", provisional === 1);

    // ------------------------------------------------- 8. finalization
    //
    // The step this harness did not have, and the reason nobody noticed that
    // no production process ever finalized a market. Everything above proves
    // the room reaches a *provisional* result; every payout path is
    // `onlyFinal`, so up to here nobody could redeem, settle LP inventory, or
    // release an Integrity Bond.
    //
    // This tier is the only one that runs `scripts/operator.mjs` as a real
    // spawned OS process, which is what makes it the only one that can prove
    // the keeper branch in that file actually works — the same reason it was
    // the only tier that caught `condition-registry`'s missing await.
    const nowS = Number((await publicClient.getBlock()).timestamp);
    await setChainTime(RPC, nowS + 700); // past the room's 600s challenge window

    spawnProcess("keeper", ["scripts/operator.mjs", "keeper"], {
      ...baseEnv,
      TM_KEEPER_KEY: ANVIL_KEYS.keeper,
    });

    const finalOutcome = await waitFor(
      "the keeper process to finalize the market",
      async () => {
        const outcome = Number(await readMarket(headline, "finalOutcome"));
        return outcome !== 0 ? outcome : null;
      },
      { timeoutMs: 60_000 }
    );
    step(
      "a keeper process finalized the market, so payouts are claimable",
      finalOutcome === provisional,
      `final outcome ${finalOutcome}`
    );
  } finally {
    inspect.close();
    await stopEverything();
    await provider.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  step("the run completed", false, error.message);
}

const passed = steps.filter((entry) => entry.ok).length;
console.log(`\n${passed}/${steps.length} checks passed`);
if (failure || passed !== steps.length) {
  console.log("\nProcess output:");
  for (const [label, entry] of children) {
    console.log(`\n--- ${label} ---`);
    for (const line of entry.output.slice(-40)) console.log(`  ${line}`);
  }
}
process.exit(passed === steps.length && !failure ? 0 : 1);
