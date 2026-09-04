// End-to-end: the composition root, against a real chain.
//
// The report's P0 is "connect the website to the real Live Room and settlement
// API". Everything else in this suite tests a part; this tests the join. It
// deploys a room to a local chain, boots the real service with buildService,
// and then reads exactly the HTTP routes the website reads — asserting that the
// bytes coming back describe the chain that was just deployed.
//
// Requires anvil on 127.0.0.1:8545 and compiled artifacts. Skips otherwise,
// loudly: a silently skipped integration test is how an integration rots.

import test from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildService, configFromEnv } from "../src/app.mjs";
import { deployGamedayRoom } from "../scripts/deploy-gameday.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const RPC = process.env.GAMEDAY_RPC_URL ?? "http://127.0.0.1:8545";
const ROOM_ID = "e2e-room";

async function chainUp() {
  try {
    const response = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await chainUp();
if (!available) {
  console.warn(`[live-e2e] SKIPPED: no chain at ${RPC}. Start anvil to run this suite.`);
}

test("the service serves the deployed room over the website's own routes", { skip: !available }, async () => {
  const fixture = {
    ...JSON.parse(readFileSync(join(HERE, "..", "fixtures", "gameday-session.json"), "utf8")),
    room_id: ROOM_ID,
  };
  const deployment = await deployGamedayRoom({ rpc: RPC, fixture });

  const service = buildService(
    configFromEnv({
      TM_ROOM_ID: ROOM_ID,
      TM_RPC_URL: RPC,
      TM_FACTORY_ADDRESS: deployment.factory,
      TM_ROOM_ADDRESS: deployment.room,
      TM_CHAIN_ID: "31337",
      TM_ROOM_API_URL: "http://127.0.0.1:0",
      TM_PORT: "0",
    })
  );

  try {
    // Bind an ephemeral port and index the chain as it stands.
    const address = await service.server.listen(0);
    const base = `http://127.0.0.1:${address.port}`;
    await service.syncOnce();

    const get = async (path) => {
      const response = await fetch(`${base}${path}`);
      return { status: response.status, body: await response.json() };
    };

    // The room the indexer found is the room that was deployed.
    const room = await get(`/v1/rooms/${ROOM_ID}`);
    assert.equal(room.status, 200);
    assert.equal(room.body.room, ROOM_ID);

    // Capabilities describe this deployment, and claim nothing it lacks.
    const capabilities = await get("/v1/capabilities");
    assert.equal(capabilities.body.chain_id, 31337);
    assert.equal(capabilities.body.capabilities.deployment.available, true);
    assert.equal(capabilities.body.capabilities.gas_sponsorship.available, false);
    assert.equal(capabilities.body.capabilities.legal_availability.available, false);
    assert.equal(capabilities.body.capabilities.chat.available, false);

    // Every discovery surface the website reads answers from indexed facts.
    for (const path of ["/v1/schedule", "/v1/activity", "/v1/leaderboard", "/v1/help", "/v1/entry/terms"]) {
      const result = await get(path);
      assert.equal(result.status, 200, `${path} must answer`);
    }

    // A portfolio for an address with no history is empty and says so, rather
    // than erroring or inventing a balance.
    const portfolio = await get("/v1/portfolio/0x0000000000000000000000000000000000000001");
    assert.equal(portfolio.status, 200);
    assert.deepEqual(portfolio.body.transactions, []);
    assert.match(portfolio.body.empty_reason, /no positions/i);

    // Chat is not configured, so the chat surface refuses rather than pretending.
    const chat = await get(`/v1/rooms/${ROOM_ID}/chat`);
    assert.equal(chat.status, 503);
    assert.deepEqual(chat.body.messages, []);

    // And the boot report is credential-free.
    const report = service.report();
    assert.equal(report.room, deployment.room);
    assert.match(report.software_notice, /no real-world value/i);
  } finally {
    await service.stop();
  }
});
