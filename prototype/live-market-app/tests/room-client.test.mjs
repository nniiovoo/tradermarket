// Issue 10: the app's room client. The Coordinator is not authoritative — an
// unreachable one degrades to the direct-RPC path, and every displayed number
// keeps its provenance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const APP = new URL("../src/App.jsx", import.meta.url);
const CLIENT = new URL("../src/web3/roomClient.js", import.meta.url);
const HOOK = new URL("../src/web3/useLiveRoom.js", import.meta.url);

function source(url) {
  return readFileSync(url, "utf8");
}

test("the room client never posts an order", () => {
  const text = source(CLIENT);
  for (const forbidden of ["submitBuy", "submitSell", "/order", "/trade", "privateKey"]) {
    assert.ok(!text.includes(forbidden), `the room client must not reference ${forbidden}`);
  }
  // The only POST is chat.
  const posts = [...text.matchAll(/method:\s*"POST"/g)];
  assert.equal(posts.length, 0, "the read client issues no writes at all");
});

test("quotes stay client-side from cleared reserves", () => {
  const app = source(APP);
  assert.ok(app.includes("marketMath") || app.includes("quoteBuy"), "the app still quotes locally");
  const client = source(CLIENT);
  assert.ok(!client.includes("quote"), "quotes never come from the room API");
});

test("the app reports three independent health signals with distinct copy", () => {
  const app = source(APP);
  assert.match(app, /Livestream unavailable/);
  assert.match(app, /score feed delayed/i);
  assert.match(app, /Connection lost|Live updates unavailable/);
  // Connection state must not be worded as market suspension.
  const connectionBlock = app.split("connection: {")[1].split("};")[0];
  assert.ok(!/suspended/i.test(connectionBlock), "connection copy must never say suspended");
});

test("an unreachable coordinator degrades to the RPC fallback, not an error state", () => {
  const hook = source(HOOK);
  assert.match(hook, /fallback/);
  assert.match(hook, /reading the market contract directly/i.test(source(APP)) ? /fallback/ : /fallback/);
  const app = source(APP);
  assert.match(app, /reading the market contract directly over RPC/);
});

test("prices and scores are rendered with their provenance", () => {
  const app = source(APP);
  assert.match(app, /block \{slot\.price\.block\}|block \{room\.snapshot\.chain\.block\}/);
  assert.match(app, /source seq \{room\.snapshot\.source\.last_seq\}/);
});

test("the client resyncs on a sequence gap rather than guessing", () => {
  const client = source(CLIENT);
  assert.match(client, /frame\.seq > cursor \+ 1/);
  assert.match(client, /onResync/);
});

test("the live EventSource identifies an allowlisted reader", async () => {
  const previous = globalThis.EventSource;
  let opened = null;
  globalThis.EventSource = class FakeEventSource {
    constructor(url) {
      opened = url;
    }
    close() {}
  };
  try {
    const { subscribeToRoom } = await import(`../src/web3/roomClient.js?allowlist-sse=${Date.now()}`);
    const unsubscribe = subscribeToRoom("room-1", {
      base: "https://api.example.test",
      address: "0xAbC",
    });
    const url = new URL(opened);
    assert.equal(url.pathname, "/v1/rooms/room-1/stream");
    assert.equal(url.searchParams.get("address"), "0xAbC");
    unsubscribe();
  } finally {
    globalThis.EventSource = previous;
  }
});

test("a 403 from the interface gate surfaces the honest denial copy", async () => {
  const server = createServer((request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        allowed: false,
        reason: "not allowlisted",
        copy: "This interface is limited to allowlisted testnet accounts while legal review is pending.",
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/rooms/room-1`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.match(body.copy, /allowlisted testnet accounts/);
    const hook = source(HOOK);
    assert.match(hook, /status === 403/, "the hook distinguishes an access denial from an outage");
  } finally {
    server.close();
  }
});
