// P0: the website can only connect to a real Live Room if there is something to
// connect to. This is the composition root — the one place that assembles the
// indexer, coordinator, discovery services and HTTP surface from configuration.
//
// The rule under test is refusal: a process with no chain configured must fail
// to start with a plain reason. It must never boot into a mode that serves
// invented rooms, because a website reading that would report fiction as fact.

import test from "node:test";
import assert from "node:assert/strict";

import { buildService, configFromEnv } from "../src/app.mjs";

const COMPLETE_ENV = {
  TM_ROOM_ID: "room-1",
  TM_RPC_URL: "http://127.0.0.1:8545",
  TM_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  TM_ROOM_ADDRESS: "0x2222222222222222222222222222222222222222",
  TM_CHAIN_ID: "31337",
  TM_ROOM_API_URL: "http://127.0.0.1:8787",
};

test("a process with no chain configured refuses to start and says what is missing", () => {
  assert.throws(
    () => buildService(configFromEnv({})),
    (error) => {
      assert.match(error.message, /TM_RPC_URL/);
      assert.match(error.message, /TM_ROOM_ADDRESS/);
      assert.match(error.message, /TM_FACTORY_ADDRESS/);
      return true;
    },
    "an unconfigured process must not boot"
  );
});

test("a partial configuration names only what is actually missing", () => {
  const partial = { ...COMPLETE_ENV };
  delete partial.TM_ROOM_ADDRESS;
  assert.throws(
    () => buildService(configFromEnv(partial)),
    (error) => {
      assert.match(error.message, /TM_ROOM_ADDRESS/);
      assert.ok(!/TM_RPC_URL/.test(error.message), "a configured value must not be reported as missing");
      return true;
    }
  );
});

test("a configured process exposes every surface the website reads", () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));
  for (const part of [
    "server",
    "coordinator",
    "indexer",
    "store",
    "capabilities",
    "activity",
    "schedule",
    "leaderboard",
    "portfolio",
    "entry",
    "help",
    "chat",
    "paymaster",
  ]) {
    assert.ok(service[part], `the service must provide ${part}`);
  }
});

test("the boot report states what is on and what is off, without inventing either", () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));
  const report = service.report();

  assert.equal(report.room_id, "room-1");
  assert.equal(report.chain_id, 31337);
  assert.equal(report.capabilities.chat.available, false, "chat is off until it is configured");
  assert.equal(report.capabilities.gas_sponsorship.available, false, "gas sponsorship is off until it is configured");
  assert.equal(report.capabilities.legal_availability.available, false);
  assert.equal(report.capabilities.livestream.available, false, "no stream is configured, so none is claimed");
  assert.equal(report.software_notice, "unaudited testnet software with no real-world value");
  assert.equal(report.capabilities.deployment.available, true, "a configured chain is a real deployment fact");
});

test("the boot report carries no credentials", () => {
  const service = buildService(
    configFromEnv({ ...COMPLETE_ENV, TM_PAYMASTER_URL: "https://example.invalid/rpc?apikey=SECRET" })
  );
  assert.ok(!JSON.stringify(service.report()).includes("SECRET"), "a boot report must never carry a credential");
});

test("a slow sync does not overlap itself", async () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));

  // A poll that takes longer than the interval must not start a second pass on
  // top of the first: two passes sharing one cursor can advance it past blocks
  // the other has not applied, which loses history silently.
  let concurrent = 0;
  let maxConcurrent = 0;
  service.indexer.syncTo = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 25));
    concurrent -= 1;
    return 0;
  };
  let head = 10;
  service.indexer.cursorBlock = 0;
  Object.defineProperty(service.indexer, "cursorBlock", {
    get: () => 0,
    set: () => {},
    configurable: true,
  });
  service.client.getBlockNumber = async () => BigInt(head++);

  await Promise.all([service.syncOnce(), service.syncOnce(), service.syncOnce()]);
  assert.equal(maxConcurrent, 1, "overlapping syncs must be serialized or skipped");
});

test("chat claims are bound to the room this process serves", () => {
  const service = buildService(configFromEnv({ ...COMPLETE_ENV, TM_CHAT_ENABLED: "true" }));
  const claim = service.chat.claimFor({ address: "0x000000000000000000000000000000000000000a", text: "hello", issuedAt: 1 });
  assert.match(claim, /room-1/, "a claim signed here must not be valid on another room");
});

test("a room id that does not match the configured room contract is reported", async () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));

  // An operator who points TM_ROOM_ID at one room and TM_ROOM_ADDRESS at
  // another gets a permanently empty room in state "draft" and no hint why.
  // The chain knows the answer — RoomCreated carries the id — so the mismatch
  // is detectable and must be said out loud rather than served as an empty room.
  service.store.upsertRoom({
    room_id: "a-different-room",
    live_room_address: "0x2222222222222222222222222222222222222222",
    state: "live",
    block_number: 5,
  });

  const health = service.health();
  assert.equal(health.room_matches_contract, false);
  assert.match(health.warning, /room-1/);
  assert.match(health.warning, /a-different-room/);
});

test("a matching room reports no mismatch", () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));
  service.store.upsertRoom({
    room_id: "room-1",
    live_room_address: "0x2222222222222222222222222222222222222222",
    state: "live",
    block_number: 5,
  });

  const health = service.health();
  assert.equal(health.room_matches_contract, true);
  assert.equal(health.warning, null);
});

test("before the room is indexed, the answer is 'not yet known', not a mismatch", () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));
  const health = service.health();
  assert.equal(health.room_matches_contract, null, "an unindexed room is unknown, not wrong");
  assert.equal(health.warning, null);
});

test("a rebuild cannot run underneath an in-flight sync", async () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));

  // `syncTo` and `rebuild` share `appliedLogs` and the cursor. A rebuild that
  // starts while a poll is in flight clears the identity set under it, and
  // every holding, trade and claim in the in-flight range is applied twice.
  let concurrent = 0;
  let maxConcurrent = 0;
  const slow = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent -= 1;
    return 0;
  };
  service.indexer.syncTo = slow;
  service.indexer.rebuild = slow;
  service.client.getBlockNumber = async () => 10n;
  Object.defineProperty(service.indexer, "cursorBlock", { get: () => 0, set: () => {}, configurable: true });

  await Promise.all([service.syncOnce(), service.rebuild(10), service.syncOnce()]);
  assert.equal(maxConcurrent, 1, "a rebuild and a sync must not overlap");
});

test("a capability the service switched off is never reported as available", () => {
  // The report and the behaviour are derived from one condition, so they
  // cannot drift apart: whatever buildService disables, capabilities denies.
  const withoutMapping = buildService(configFromEnv(COMPLETE_ENV));
  assert.equal(withoutMapping.settlement, null, "the service omits settlement records");
  assert.equal(
    withoutMapping.report().capabilities.settlement_api.available,
    false,
    "so the capability must not claim them"
  );

  const withMapping = buildService(
    configFromEnv({ ...COMPLETE_ENV, TM_PARTICIPANT_A: "alice", TM_PARTICIPANT_B: "bob" })
  );
  assert.ok(withMapping.settlement, "the service builds settlement records");
  assert.equal(withMapping.report().capabilities.settlement_api.available, true);
});

test("a configured data directory makes non-chain history durable", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "tm-boot-"));
  try {
    const service = buildService(configFromEnv({ ...COMPLETE_ENV, TM_DATA_DIR: dir }));

    assert.equal(service.report().durability.non_chain_history, "durable");
    assert.match(service.report().durability.detail, /survive a restart/i);
    assert.ok(service.oracle, "durable storage builds the evidence archive");
    assert.equal(
      service.report().capabilities.livestream_oracle.available,
      false,
      "storage without upload authentication must not announce a working operator flow"
    );

    const enabled = buildService(configFromEnv({
      ...COMPLETE_ENV,
      TM_DATA_DIR: dir,
      TM_ORACLE_OPERATOR_TOKEN: "a-long-random-operator-secret",
    }));
    assert.equal(enabled.report().capabilities.livestream_oracle.available, true);

    // The stores the service actually built, not a claim about them.
    await service.eventLog.append({ seq: 1, kind: "baseline", hash: "0x000000000000000000000000000000000000000a" });
    await service.chat.store.append({ author: "0x000000000000000000000000000000000000000a", text: "hi", at: "2026-01-01T00:00:00.000Z" });

    const restarted = buildService(configFromEnv({ ...COMPLETE_ENV, TM_DATA_DIR: dir }));
    assert.equal((await restarted.eventLog.tip()).seq, 1, "the session log continued");
    assert.equal((await restarted.chat.history()).length, 1, "and so did the conversation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a signed allowlist acceptance still opens the interface after a restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ELIGIBILITY_ATTESTATIONS, TERMS_VERSION } = await import("../src/entry/entry.mjs");

  const dir = mkdtempSync(join(tmpdir(), "tm-entry-restart-"));
  const env = {
    ...COMPLETE_ENV,
    TM_DATA_DIR: dir,
    TM_ALLOWLIST_ENABLED: "true",
    TM_ALLOWLIST: "0x000000000000000000000000000000000000000a",
  };
  const dependencies = { verifySignature: async () => true };
  try {
    let service = buildService(configFromEnv(env), dependencies);
    const attestations = Object.fromEntries(ELIGIBILITY_ATTESTATIONS.map((entry) => [entry.id, true]));
    const accepted = await service.entry.accept({
      address: "0x000000000000000000000000000000000000000a",
      version: TERMS_VERSION,
      attestations,
      claim: service.entry.claimFor({ address: "0x000000000000000000000000000000000000000a" }),
      signature: "0xGOOD",
    });
    assert.equal(accepted.proven, true);
    assert.equal((await service.entry.status("0x000000000000000000000000000000000000000a")).can_enter, true);
    service.database.close();

    service = buildService(configFromEnv(env), dependencies);
    const address = await service.server.listen(0);
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/rooms`, {
      headers: { "x-tm-address": "0x000000000000000000000000000000000000000a" },
    });
    assert.equal(response.status, 200, "the first gated request after a restart must restore the durable proof");
    assert.equal(
      (await service.entry.status("0x000000000000000000000000000000000000000a")).can_enter,
      true,
      "a process restart must not forget signature proof"
    );
    await service.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without one, the service says plainly that history will not survive", () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));

  // Silence here would be the worst outcome: an operator runs it, restarts it,
  // and discovers afterwards that the evidence log is gone.
  assert.equal(service.report().durability.non_chain_history, "in-memory");
  assert.match(service.report().durability.detail, /lost on restart|does not survive/i);
});

test("a configured playback URL is actually polled, and reported from the poll", async () => {
  let manifestCalls = 0;
  const service = buildService(
    configFromEnv({ ...COMPLETE_ENV, TM_STREAM_PLAYBACK_URL: "https://example.invalid/live.m3u8" }),
    {
      fetchImpl: async () => {
        manifestCalls += 1;
        return { ok: true, text: async () => "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:4.0,\nseg7.ts" };
      },
    }
  );

  assert.ok(service.streamMonitor, "a configured stream is monitored, not merely declared");
  assert.equal(service.streamMonitor.health, "unknown", "and claims nothing before the first poll");

  await service.pollStream(1_000);
  assert.equal(manifestCalls, 1);
  assert.equal(service.streamMonitor.health, "live");

  // The coordinator's stream signal is the measured one.
  assert.equal(service.coordinator.snapshot().stream.health, "live");
});

test("an unconfigured stream is monitored by nothing and claims nothing", async () => {
  const service = buildService(configFromEnv(COMPLETE_ENV));
  await service.pollStream(1_000);
  assert.equal(service.coordinator.snapshot().stream.health, "unknown");
  assert.equal(service.report().capabilities.livestream.available, false);
});

test("each room's stream health is measured from its own playback URL, not another room's", async () => {
  // The bug this guards: one process serving two rooms had exactly one
  // StreamMonitor, and every room's coordinator was handed that single
  // monitor's result — so room "beta" would show room "alpha"'s stream as
  // its own LIVE badge, or vice versa, regardless of which room actually had
  // a broadcast running. A creator's stream is their own room's fact, the
  // same way their chat and their event frames already are (see chatFor in
  // app.mjs) — this is that same isolation, extended to stream health.
  let betaPolled = false;
  const service = buildService(
    configFromEnv({
      ...COMPLETE_ENV,
      TM_ROOM_ID: undefined,
      TM_ROOM_ADDRESS: undefined,
      TM_ROOMS: `alpha=${COMPLETE_ENV.TM_ROOM_ADDRESS},beta=0x3333333333333333333333333333333333333333`,
      TM_STREAM_PLAYBACK_URLS: "alpha=https://alpha.example.invalid/live.m3u8",
    }),
    {
      fetchImpl: async (url) => {
        if (!String(url).includes("alpha")) betaPolled = true;
        return { ok: true, text: async () => "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:4.0,\nseg1.ts" };
      },
    }
  );

  await service.pollStream(1_000);

  assert.equal(service.roomFor("alpha").coordinator.snapshot().stream.health, "live", "alpha has its own configured stream");
  assert.equal(
    service.roomFor("beta").coordinator.snapshot().stream.health,
    "unknown",
    "beta has no playback URL of its own and must not inherit alpha's health"
  );
  assert.equal(betaPolled, false, "a room with no playback URL configured must not be polled over the network at all");
});

test("the livestream capability is honest when only the per-room URL list is set", () => {
  // capabilities.livestream speaks for the primary room, the same way
  // room.roomId already does. Before this, it only ever read the legacy
  // singular TM_STREAM_PLAYBACK_URL — so a deployment using only the new
  // per-room list would report "no livestream playback source is
  // configured" even though its primary room plainly has one.
  const service = buildService(
    configFromEnv({
      ...COMPLETE_ENV,
      TM_STREAM_PLAYBACK_URLS: `room-1=https://room-1.example.invalid/live.m3u8`,
    })
  );
  assert.equal(service.report().capabilities.livestream.available, true);
});
