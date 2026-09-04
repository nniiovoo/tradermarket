// Serving more than one room.
//
// A live product runs several rooms at once, listed side by side. The
// service was configured for exactly one room address, so a second room meant a
// second deployment, a second port, and a website that could not link between
// them.
//
// The rooms share a chain, an indexer and a store; each keeps its own
// coordinator, edge and chat, because a room's frame sequence, its viewers and
// its conversation are its own.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildService, configFromEnv } from "../src/app.mjs";

const BASE = {
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_CHAIN_ID: "31337",
  TM_ROOM_API_URL: "http://127.0.0.1:8787",
};

const ROOM_A = "0x2222222222222222222222222222222222222222";
const ROOM_B = "0x3333333333333333333333333333333333333333";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "tm-rooms-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("one process can serve several rooms", () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );

  assert.deepEqual(service.roomIds, ["alpha", "beta"]);
  assert.ok(service.roomFor("alpha"), "each room has its own coordinator");
  assert.ok(service.roomFor("beta"));
  assert.notEqual(service.roomFor("alpha").coordinator, service.roomFor("beta").coordinator);
  assert.notEqual(
    service.roomFor("alpha").chat,
    service.roomFor("beta").chat,
    "a conversation belongs to its room, not to the process"
  );
  assert.equal(service.roomFor("gamma"), null, "a room this process does not serve is not invented");
});

test("the single-room form still works and is still one room", () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOM_ID: "alpha", TM_ROOM_ADDRESS: ROOM_A })
  );
  assert.deepEqual(service.roomIds, ["alpha"]);
  assert.ok(service.roomFor("alpha"));
});

test("a process with neither form of room configuration refuses to start", () => {
  assert.throws(() => buildService(configFromEnv(BASE)), /TM_ROOM/);
});

test("rooms share the indexer and the store, and each keeps its own chat", async () => {
  const { dir, clean } = scratch();
  try {
    const service = buildService(
      configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}`, TM_DATA_DIR: dir, TM_CHAT_ENABLED: "true" })
    );

    // One indexer: two rooms on one chain should not mean two sweeps of it.
    assert.ok(service.indexer, "a single indexer serves every room");
    assert.equal(service.store, service.roomFor("alpha").coordinator.store);
    assert.equal(service.store, service.roomFor("beta").coordinator.store);

    // But a message posted in one room must not appear in the other.
    await service.roomFor("alpha").chat.store.append({ author: "0xA", text: "in alpha", at: "2026-01-01T00:00:00.000Z" });
    assert.equal((await service.roomFor("alpha").chat.history()).length, 1);
    assert.equal((await service.roomFor("beta").chat.history()).length, 0, "rooms do not share a conversation");
  } finally {
    clean();
  }
});

test("the boot report names every room it serves", () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );
  const report = service.report();
  assert.deepEqual(
    report.rooms.map((room) => room.room_id),
    ["alpha", "beta"]
  );
  assert.equal(report.rooms[0].room, ROOM_A);
});

test("the HTTP surface serves each room it was given", async () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );
  try {
    const address = await service.server.listen(0);
    const base = `http://127.0.0.1:${address.port}`;
    // Driven by the real sync pass, not by hand. Ticking the coordinators here
    // was what hid the fact that the loop only ever drove the first room.
    service.client.getBlockNumber = async () => 0n;
    await service.syncOnce();

    const alpha = await fetch(`${base}/v1/rooms/alpha`);
    assert.equal(alpha.status, 200);
    assert.equal((await alpha.json()).room, "alpha");

    const beta = await fetch(`${base}/v1/rooms/beta`);
    assert.equal(beta.status, 200, "the second room is not a 404");
    assert.equal((await beta.json()).room, "beta");

    const missing = await fetch(`${base}/v1/rooms/gamma`);
    assert.equal(missing.status, 404, "a room this process does not serve is still a 404");

    // And the room list is every room, not just the first.
    const list = await (await fetch(`${base}/v1/rooms`)).json();
    assert.deepEqual(
      list.rooms.map((room) => room.room_id).sort(),
      ["alpha", "beta"]
    );
  } finally {
    await service.stop();
  }
});

test("one room's source facts never make another room fresh or appear in its score", async () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );
  try {
    service.roomFor("alpha").eventLog.append({
      seq: 1,
      room_id: "alpha",
      participant: "alice",
      kind: "baseline",
      observed_at: new Date().toISOString(),
      facts: { account_value_usd: "1000" },
    });

    const beta = service.roomFor("beta").coordinator.snapshot();
    assert.equal(beta.source.last_seq, 0, "alpha's heartbeat is not beta's source progress");
    assert.equal(beta.health.source, "unknown", "alpha's live feed cannot keep beta's market open");

    const address = await service.server.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/rooms/beta/scores`);
    assert.equal(response.status, 200);
    const scores = await response.json();
    assert.deepEqual(scores.events, [], "beta's evidence view must not disclose alpha's session log");
    assert.deepEqual(scores.standing, []);
  } finally {
    await service.stop();
  }
});

test("the multi-room schedule never links a factory room this process cannot serve", () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );
  service.store.upsertRoom({ room_id: "alpha", live_room_address: ROOM_A, state: "live", block_number: 1 });
  service.store.upsertRoom({ room_id: "beta", live_room_address: ROOM_B, state: "live", block_number: 2 });
  service.store.upsertRoom({
    room_id: "factory-only",
    live_room_address: "0x4444444444444444444444444444444444444444",
    state: "live",
    block_number: 3,
  });

  assert.deepEqual(
    service.schedule.list().live.map((room) => room.room_id).sort(),
    ["alpha", "beta"],
    "a schedule route must have a matching room runtime"
  );
});

test("multi-room health checks every configured id against its contract address", () => {
  const service = buildService(
    configFromEnv({ ...BASE, TM_ROOMS: `alpha=${ROOM_A},beta=${ROOM_B}` })
  );
  service.store.upsertRoom({ room_id: "alpha", live_room_address: ROOM_A, state: "live", block_number: 1 });
  service.store.upsertRoom({ room_id: "not-beta", live_room_address: ROOM_B, state: "live", block_number: 2 });

  const health = service.health();
  assert.equal(health.room_matches_contract, false);
  assert.match(health.warning, /beta/);
  assert.equal(health.rooms.find((room) => room.configured_room_id === "beta").indexed_room_id, "not-beta");
});
