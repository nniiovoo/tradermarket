// Browser preflight.
//
// The website identifies the reader with an `x-tm-address` header so the API
// can apply the allowlist. That is a non-simple header, so every such request
// is preceded by a CORS preflight — and a preflight that does not name the
// header is a refusal. The symptom is nasty precisely because it is selective:
// anonymous reads succeed, and every surface that knows who you are ("your
// portfolio", "your entry status") fails with a bare "Failed to fetch".

import test from "node:test";
import assert from "node:assert/strict";

import { RoomApiServer } from "../src/api/server.mjs";
import { LiveRoomCoordinator } from "../src/coordinator/coordinator.mjs";
import { ProjectionStore } from "../src/indexer/projection.mjs";
import { MemoryEventStore } from "../src/ports/stores.mjs";
import { RealtimeEdge, ChatService, PlaybackService } from "../src/edge/edge.mjs";
import { Portfolio } from "../src/discovery/portfolio.mjs";
import { EntryGate } from "../src/entry/entry.mjs";
import { Allowlist } from "../src/api/allowlist.mjs";
import { Capabilities } from "../src/config/capabilities.mjs";

async function harness() {
  const store = new ProjectionStore();
  const eventLog = new MemoryEventStore();
  const edgeRef = {};
  const coordinator = new LiveRoomCoordinator({
    roomId: "room-1",
    store,
    eventLog,
    publishTo: (frame) => edgeRef.edge?.broadcast(frame),
    config: { freshnessThresholdMs: 20_000, retention: 20, heartbeatMs: 10_000 },
  });
  const edge = new RealtimeEdge({ coordinator, config: { heartbeatMs: 10_000, maxQueue: 16 } });
  edgeRef.edge = edge;
  const server = new RoomApiServer({
    coordinator,
    edge,
    store,
    eventLog,
    chat: new ChatService({ verifySignature: async () => true, config: { moderators: new Set() } }),
    playback: new PlaybackService({ config: {} }),
    portfolio: new Portfolio({ store }),
    entry: new EntryGate({
      allowlist: new Allowlist({ enabled: false }),
      capabilities: new Capabilities({ room: { apiUrl: "http://x" } }),
    }),
  });
  const address = await server.listen(0);
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("the preflight allows the headers the website actually sends", async () => {
  const { server, base } = await harness();
  try {
    const response = await fetch(`${base}/v1/portfolio/0xabc`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-tm-address, content-type",
      },
    });
    assert.equal(response.status, 204);

    const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    assert.match(allowed, /x-tm-address/, "the address header must be allowed or every personalised read fails");
    assert.match(allowed, /content-type/, "JSON writes need content-type allowed");

    const methods = (response.headers.get("access-control-allow-methods") ?? "").toUpperCase();
    assert.match(methods, /GET/);
    assert.match(methods, /POST/, "chat and entry acceptance are POSTs");
  } finally {
    await server.close();
  }
});

test("a real cross-origin read still answers with the allow-origin header", async () => {
  const { server, base } = await harness();
  try {
    const response = await fetch(`${base}/v1/portfolio/0xabc`, {
      headers: { origin: "http://localhost:5173", "x-tm-address": "0xabc" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  } finally {
    await server.close();
  }
});

test("a malformed body is refused, not fatal", async () => {
  const { server, base } = await harness();
  try {
    // /v1/entry/accept is handled above the try/catch, so a JSON parse failure
    // escapes into an unhandled rejection — and Node terminates the process on
    // one of those. CORS is open, so any web page can send this.
    const response = await fetch(`${base}/v1/entry/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error ?? body.reason ?? "", /json|body/i);

    // The process must still be serving.
    const after = await fetch(`${base}/v1/health`);
    assert.equal(after.status, 200);
  } finally {
    await server.close();
  }
});

test("an oversized body is refused rather than buffered", async () => {
  const { server, base } = await harness();
  try {
    const response = await fetch(`${base}/v1/entry/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "0xa", pad: "x".repeat(2_000_000) }),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 413, "a body with no cap is an unbounded heap vector");

    const after = await fetch(`${base}/v1/health`);
    assert.equal(after.status, 200);
  } finally {
    await server.close();
  }
});

test("a bad body on a gated route still answers 400, and never leaks internals", async () => {
  const { server, base } = await harness();
  try {
    // The chat routes sit inside the broad try/catch, which discarded the
    // status `_body` sets and returned the raw message on a 500 — the exact
    // thing the escape handler deliberately suppresses.
    const malformed = await fetch(`${base}/v1/rooms/room-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(malformed.status, 400);

    const oversized = await fetch(`${base}/v1/rooms/room-1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(200_000) }),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.close();
  }
});

test("an unexpected internal failure does not describe itself to the caller", async () => {
  const { server, base } = await harness();
  try {
    // Anything unexpected must read as "internal error", not as a stack-shaped
    // message that describes the server's internals to an anonymous caller.
    server.coordinator.snapshot = () => {
      throw new TypeError("cannot read properties of undefined (reading 'secretInternalField')");
    };
    const response = await fetch(`${base}/v1/rooms/room-1`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, "internal error");
    assert.ok(!JSON.stringify(body).includes("secretInternalField"));
  } finally {
    await server.close();
  }
});

test("a JSON body that is not an object is refused with a 400", async () => {
  const { server, base } = await harness();
  try {
    // `JSON.parse("null")` succeeds and yields null, which then explodes on the
    // first destructure — the one client input that still became a 500.
    for (const body of ["null", "[]", '"a string"', "42"]) {
      const response = await fetch(`${base}/v1/entry/accept`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(4000),
      });
      assert.equal(response.status, 400, `body ${body} must be a 400`);
    }
    assert.equal((await fetch(`${base}/v1/health`)).status, 200, "and the process is still serving");
  } finally {
    await server.close();
  }
});
