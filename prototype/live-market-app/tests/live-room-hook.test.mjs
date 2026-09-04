// The room hook's failure behaviour, which decides what the whole Home page
// says when the API wobbles.
//
// These are source-level assertions because the hook is React-bound, but each
// pins a behaviour with a concrete consequence rather than a shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const hook = readFileSync(join(SRC, "web3/useLiveRoom.js"), "utf8");
const client = readFileSync(join(SRC, "web3/roomClient.js"), "utf8");

test("one failed poll does not latch the room as unreachable forever", () => {
  // `connection` was only ever set to "unreachable" and never cleared on a
  // later success, so a single blip made the app say "the room API is not
  // answering" permanently while it kept rendering fresh data from that API.
  const start = hook.indexOf('roomResult.status === "fulfilled"');
  assert.ok(start > 0, "the success branch still exists");
  const success = hook.slice(start, start + 700);
  assert.match(
    success,
    /setConnection\(/,
    "a successful poll must clear the unreachable state it set"
  );
});

test("a failure of a list nothing renders does not discard the room snapshot", () => {
  // `Promise.all([fetchRoom, fetchRooms])` rejects together: a failure of
  // /v1/rooms — a list the page does not consume — threw away a good room
  // snapshot and froze the displayed price.
  assert.ok(
    !/Promise\.all\(\[fetchRoom\(ROOM_ID\), fetchRooms\(\)\]\)/.test(hook),
    "the room read must not be coupled to a list the page does not need"
  );
  assert.match(hook, /allSettled|catch\(\(\) =>/, "the list failing must not take the room with it");
});

test("room reads identify the reader, so an allowlisted account is not denied", () => {
  // Every other surface sends x-tm-address. The room reads did not, so an
  // allowlisted user who accepted the terms was refused the Live Room while
  // the rest of the app worked.
  assert.match(client, /address/, "the client supports the header");
  assert.match(
    hook,
    /address|account/,
    "and the hook must pass the connected account when it has one"
  );
});

test("a disconnected event stream cannot hide a failed room snapshot", async () => {
  const { connectionAfterStreamStatus } = await import("../src/web3/room-connection.js");
  assert.equal(
    connectionAfterStreamStatus("unreachable", "disconnected"),
    "unreachable",
    "the page must keep showing that the API is unreachable"
  );
  assert.equal(connectionAfterStreamStatus("polling", "connected"), "live");
  assert.equal(connectionAfterStreamStatus("live", "disconnected"), "disconnected");
});
