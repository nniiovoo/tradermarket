// Issue 09: realtime edge, chat, playback. Connection loss is never market
// suspension; a degraded stream leaves markets fully tradable; chat is
// authenticated, rate limited, moderated, and never evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RealtimeEdge, ChatService, PlaybackService } from "../src/edge/edge.mjs";
import { LiveRoomCoordinator } from "../src/coordinator/coordinator.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";

function fakeConnection() {
  const received = [];
  return { received, send: (frame) => received.push(frame), close: () => {} };
}

function harness() {
  const store = new ProjectionStore();
  store.upsertRoom({ room_id: "room-1", state: "live", block_number: 1, max_open_slots: 2 });
  const eventLog = new MemoryEventStore();
  const edgeRef = {};
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog,
    publishTo: (frame) => edgeRef.edge?.broadcast(frame),
    config: { freshnessThresholdMs: 20_000, retention: 10, heartbeatMs: 10_000 },
  });
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 4 } });
  edgeRef.edge = edge;
  return { coordinator, edge, store, eventLog };
}

test("attach sends hello and replays from a cursor", () => {
  const { coordinator, edge } = harness();
  coordinator.setViewers(1);
  coordinator.setViewers(2);

  const connection = fakeConnection();
  edge.attach(connection, { since: coordinator.frames[0].seq });
  assert.equal(connection.received[0].type, "hello");
  assert.equal(connection.received[1].type, "viewers.updated");
  assert.equal(connection.received[1].payload.count, 2);
});

test("a cursor below the retention floor gets a resync with a full snapshot", () => {
  const { coordinator, edge } = harness();
  for (let i = 0; i < 15; i++) coordinator.setViewers(i); // retention is 10

  const connection = fakeConnection();
  edge.attach(connection, { since: 1 });
  const resync = connection.received.find((frame) => frame.type === "resync");
  assert.ok(resync, "stale cursor triggers resync");
  assert.equal(resync.snapshot.room, "room-1");
});

test("live frames broadcast to every attached connection", () => {
  const { coordinator, edge } = harness();
  const a = fakeConnection();
  const b = fakeConnection();
  edge.attach(a);
  edge.attach(b);
  coordinator.setViewers(7);
  for (const connection of [a, b]) {
    assert.ok(connection.received.some((frame) => frame.type === "viewers.updated" && frame.payload.count === 7));
  }
});

test("a private channel is scoped to one address", () => {
  const { edge } = harness();
  const mine = fakeConnection();
  const other = fakeConnection();
  edge.attach(mine, { address: "0xME" });
  edge.attach(other, { address: "0xYOU" });

  const delivered = edge.sendPrivate("0xME", { type: "user.claimable", payload: { amount: "1" } });
  assert.equal(delivered, 1);
  assert.ok(mine.received.some((frame) => frame.type === "user.claimable"));
  assert.ok(!other.received.some((frame) => frame.type === "user.claimable"));
});

test("a slow consumer is told to resync instead of growing without bound", () => {
  const { edge } = harness();
  const connection = fakeConnection();
  edge.attach(connection);

  // Drive the real signal rather than an internal field: `response.write`
  // returns false when the socket is full, and that is what a saturated reader
  // actually looks like. The previous version saturated `connection.queue` by
  // hand — a field production never populated, so the test passed while the cap
  // it described could not fire.
  const original = connection.send;
  connection.send = (frame) => {
    original(frame);
    return false;
  };
  for (let i = 0; i < 5; i += 1) edge._send(connection, { type: "slot.price_changed", seq: i });

  const sent = edge._send(connection, { type: "slot.price_changed", seq: 99 });
  assert.equal(sent, false);
  assert.ok(connection.dropped > 0);
  assert.ok(connection.received.some((frame) => frame.type === "resync_required"));
});

test("heartbeats carry room_seq, source_seq, and the three health signals", () => {
  const { coordinator, edge } = harness();
  const connection = fakeConnection();
  edge.attach(connection);
  coordinator.heartbeat();
  const heartbeat = connection.received.find((frame) => frame.type === "heartbeat");
  assert.ok(heartbeat);
  assert.equal(typeof heartbeat.payload.room_seq, "number");
  assert.equal(typeof heartbeat.payload.source_seq, "number");
  assert.deepEqual(Object.keys(heartbeat.payload.health).sort(), ["indexer", "source", "stream"]);
  assert.equal(heartbeat.presentation_only, true, "connection state is presentation-only, never market state");
});

test("a degraded or dead stream never changes market or source state", () => {
  const { coordinator } = harness();
  const before = coordinator.snapshot(0);
  coordinator.setStreamHealth("unavailable");
  const after = coordinator.snapshot(0);
  assert.equal(after.stream.health, "unavailable");
  assert.deepEqual(after.program, before.program, "program untouched by stream health");
  assert.deepEqual(after.source, before.source, "source status untouched by stream health");
});

test("chat requires a signature, rate limits, and enforces slow mode", async () => {
  const chat = new ChatService({
    verifySignature: async (_address, _text, signature) => signature === "0xGOOD",
    config: { roomId: "room-1", rateLimitPerMinute: 2, slowModeMs: 1000, moderators: new Set(["0xmod"]) },
  });

  // Every post signs a bound claim: purpose, room, author, moment, text.
  const send = (text, nowMs) =>
    chat.post({
      address: "0xA",
      text,
      claim: chat.claimFor({ roomId: "room-1", address: "0xA", text, issuedAt: nowMs }),
      signature: "0xGOOD",
      nowMs,
    });

  assert.equal((await chat.post({ address: "0xA", text: "hi", signature: null })).reason, "unauthenticated");
  assert.equal(
    (await chat.post({
      address: "0xA",
      text: "hi",
      claim: chat.claimFor({ roomId: "room-1", address: "0xA", text: "hi", issuedAt: 0 }),
      signature: "0xBAD",
      nowMs: 0,
    })).reason,
    "bad signature"
  );

  const first = await send("hello", 0);
  assert.equal(first.ok, true);
  assert.equal(first.message.presentation_only, true);

  const tooFast = await send("again", 500);
  assert.equal(tooFast.reason, "slow mode");

  await send("ok", 2000);
  const limited = await send("more", 4000);
  assert.equal(limited.reason, "rate limited");
});

test("moderation deletes for everyone and times an author out, with an audit trail", async () => {
  const chat = new ChatService({
    verifySignature: async () => true,
    // Lowercased, as the composition root configures it: Ethereum address case
    // is a checksum, not an identity.
    config: { roomId: "room-1", rateLimitPerMinute: 10, moderators: new Set(["0xmod"]) },
  });
  const posted = await chat.post({
    address: "0xA",
    text: "spam",
    claim: chat.claimFor({ roomId: "room-1", address: "0xA", text: "spam", issuedAt: 0 }),
    signature: "0xGOOD",
    nowMs: 0,
  });

  // Moderation is signed like any other action, over a bound claim: naming a
  // public moderator address is not proof of being one.
  const moderation = (moderator, action, untilMs = 0) => ({
    moderator,
    messageId: posted.message.id,
    action,
    untilMs,
    claim: chat.moderationClaimFor({
      roomId: "room-1",
      moderator,
      messageId: posted.message.id,
      action,
      untilMs,
      issuedAt: Date.now(),
    }),
    signature: "0xGOOD",
  });

  assert.equal((await chat.moderate(moderation("0xNOBODY", "delete"))).ok, false);
  assert.equal(
    (await chat.moderate({ moderator: "0xMOD", messageId: posted.message.id, action: "delete" })).ok,
    false,
    "an unsigned moderation is refused"
  );

  await chat.moderate(moderation("0xMOD", "delete"));
  assert.equal((await chat.history()).length, 0, "deleted message disappears for every client");

  await chat.moderate(moderation("0xMOD", "timeout", 10_000));
  const blocked = await chat.post({ address: "0xA", text: "again", signature: "0xGOOD", nowMs: 5_000 });
  assert.equal(blocked.reason, "timed out");
  assert.equal((await chat.auditLog()).length, 2);
});

test("the pinned rule states chat cannot change a result", () => {
  const chat = new ChatService({ verifySignature: async () => true, config: {} });
  assert.match(chat.pinned.text, /cannot change a result/);
  assert.equal(chat.pinned.presentation_only, true);
});

test("playback health has three values and maps timecodes to source sequences", () => {
  const playback = new PlaybackService({ config: { degradedAfterMs: 5_000, disclosedDelayS: 2 } });
  assert.equal(playback.observe({ ok: false, lastSegmentAgeMs: 0 }).health, "unavailable");
  assert.equal(playback.observe({ ok: true, lastSegmentAgeMs: 100, nowMs: 0 }).health, "live");
  assert.equal(playback.observe({ ok: true, lastSegmentAgeMs: 9_000 }).health, "degraded");

  playback.observe({ ok: true, lastSegmentAgeMs: 100, nowMs: 0 });
  playback.mark(10, 12_000);
  playback.mark(20, 42_000);
  assert.equal(playback.offsetFor(10), 10, "12s in, minus the 2s disclosed delay");
  assert.equal(playback.offsetFor(25), 40);
  assert.equal(playback.offsetFor(5), null, "no timecode before the first mark");
});

test("a reader that never drains is told it fell behind, and is not buffered forever", () => {
  const coordinator = {
    roomId: "room-1",
    roomSeq: 0,
    frames: [],
    framesSince: () => ({ frames: [] }),
  };
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 4 } });

  // A real SSE sink reports whether the socket accepted the write. A sink that
  // never drains must trip the cap: the queue was pushed and popped
  // synchronously, so its length was always zero and the cap never fired —
  // every frame went into Node's socket buffer for the process lifetime and the
  // reader was never told to resync.
  const received = [];
  const connection = {
    drained: false,
    send: (frame) => {
      received.push(frame);
      return false; // the socket is full
    },
    close: () => {},
  };
  edge.attach(connection);

  for (let i = 0; i < 100; i += 1) edge.broadcast({ type: "tick", seq: i, presentation_only: true });

  assert.ok(connection.dropped > 0, "a reader that cannot keep up must be recorded as dropping frames");
  assert.ok(
    received.some((frame) => frame.type === "resync_required"),
    "and must be told to resync rather than silently falling behind"
  );
  assert.ok(
    received.length < 100,
    `a dead socket must not be written to once per frame (writes: ${received.length})`
  );
});

test("a stream recovers once the socket drains", () => {
  const { edge } = harness();
  const connection = fakeConnection();
  edge.attach(connection);

  // Once the cap was reached, the early return skipped the very send() whose
  // result was the only thing that could clear the backlog — so a viewer whose
  // socket filled for one moment was blanked for the life of the connection,
  // while the connection still looked healthy.
  let socketFull = true;
  const original = connection.send;
  connection.send = (frame) => {
    original(frame);
    return !socketFull;
  };

  for (let i = 0; i < 20; i += 1) edge._send(connection, { type: "tick", seq: i });
  assert.ok(connection.dropped > 0, "the cap trips while the socket is full");

  socketFull = false;
  connection.received.length = 0;
  const droppedAtDrain = connection.dropped;
  // The next probe clears the backlog; from then on frames flow again.
  for (let i = 0; i < 12; i += 1) edge._send(connection, { type: "tick", seq: 100 + i });

  const delivered = connection.received.filter((frame) => frame.type === "tick");
  assert.ok(delivered.length >= 10, `the stream resumes once the socket drains (delivered ${delivered.length})`);
  assert.ok(
    connection.dropped - droppedAtDrain <= 2,
    "and stops counting drops rather than staying tripped forever"
  );
});

test("a nonsensical cursor forces a resync rather than a silent empty stream", () => {
  const { coordinator } = harness();
  coordinator.publish("slot.price_changed", { slot_index: 0 }, { chain: { block: 1 } });

  // `Number("abc")` is NaN, and every comparison against NaN is false — so the
  // client was told "you are fully caught up" and an SSE reader attached with
  // it received `hello` and then nothing, forever, with no resync.
  const result = coordinator.framesSince(Number("abc"));
  assert.equal(result.resync, true, "an uninterpretable cursor cannot mean 'caught up'");
  assert.ok(result.snapshot, "and must carry the snapshot to resync from");
});

test("a maxQueue of zero is a misconfiguration, not a silent blackhole", () => {
  const { coordinator } = harness();

  // `?? 256` accepts 0, and `backlog >= 0` is always true — so no frame and no
  // probe was ever written, including the `hello` on attach. A stream that
  // delivers nothing while reporting itself healthy is the worst outcome here.
  for (const maxQueue of [0, -1]) {
    const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue } });
    const connection = fakeConnection();
    edge.attach(connection);
    edge.broadcast({ type: "tick", presentation_only: true });
    assert.ok(
      connection.received.length > 0,
      `maxQueue ${maxQueue} must fall back to a usable cap rather than delivering nothing`
    );
  }
});

test("one connection whose sink throws does not blank the others", () => {
  const { coordinator } = harness();
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 8 } });

  // A socket destroyed between the write and the 'close' event throws rather
  // than returning false. That escaped `broadcast` into `coordinator.tick()`,
  // so one bad socket blanked every connection after it in the set and turned
  // the indexing poll into a failed sync.
  const bad = { send: () => { throw new Error("ERR_STREAM_DESTROYED"); }, close: () => {} };
  edge.attach(bad);
  const good = fakeConnection();
  edge.attach(good);

  edge.broadcast({ type: "tick", presentation_only: true });

  assert.ok(good.received.some((frame) => frame.type === "tick"), "the healthy reader still gets the frame");
  assert.ok(!edge.connections.has(bad), "and the broken connection is detached rather than retried forever");
});

test("recovery does not wait for the drop counter to line up again", () => {
  const { coordinator } = harness();
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 8 } });
  const connection = fakeConnection();
  edge.attach(connection);

  // The probe fired on `dropped % cap === 1` against a counter that never
  // resets, so after the socket drained the connection stayed blind until the
  // count happened to line up again — up to cap-1 frames, 255 at the production
  // default.
  let socketFull = true;
  const original = connection.send;
  connection.send = (frame) => {
    original(frame);
    return !socketFull;
  };
  for (let i = 0; i < 40; i += 1) edge._send(connection, { type: "tick", seq: i });
  assert.ok(connection.dropped > 0);

  socketFull = false;
  connection.received.length = 0;
  // The very next frame after the socket drains must probe and recover, not
  // wait for the counter to line up.
  edge._send(connection, { type: "tick", seq: 100 });
  edge._send(connection, { type: "tick", seq: 101 });

  const delivered = connection.received.filter((frame) => frame.type === "tick").length;
  assert.ok(delivered >= 1, `the stream resumes on the next frame once the socket drains (delivered ${delivered} of 2)`);
});

test("a private channel survives one throwing sink", () => {
  const { coordinator } = harness();
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 8 } });

  // A connection that attaches cleanly and dies later — a socket destroyed
  // between a write and its close event, which throws rather than returning
  // false. attach() already screens a sink that is broken on arrival.
  const bad = fakeConnection();
  const good = fakeConnection();
  edge.attach(bad, { address: "0xA" });
  edge.attach(good, { address: "0xA" });
  bad.send = () => { throw new Error("ERR_STREAM_DESTROYED"); };

  edge.sendPrivate("0xA", { type: "wallet.updated", presentation_only: true });

  assert.ok(good.received.some((frame) => frame.type === "wallet.updated"), "the healthy reader still gets it");
  assert.ok(!edge.privateChannels.get("0xA")?.has(bad), "and the dead connection does not leak into the channel");
});

test("playback health is unknown until it has been observed", () => {
  const playback = new PlaybackService({ config: { degradedAfterMs: 5_000 } });

  // "unavailable" says the stream was checked and is down. Until something
  // observes it, that is a claim about a measurement nobody took — and
  // /v1/health published it as the stream signal.
  assert.equal(playback.health, "unknown");

  playback.observe({ ok: false, lastSegmentAgeMs: 0, nowMs: 0 });
  assert.equal(playback.health, "unavailable", "once observed, an outage is an outage");
});
