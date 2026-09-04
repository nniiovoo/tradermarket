// Livestream health, actually measured.
//
// A playback URL could be configured, and the service reported a stream health
// signal — but nothing ever looked at the stream, so the signal was a constant.
// This polls the HLS manifest the way a player does: the newest segment's age
// is what "live", "degraded" and "unavailable" actually mean, and the answer
// stays "unknown" until a poll has come back.
//
// The livestream is context and never decides a result, so a degraded stream
// must never suspend a market — only say that the picture is behind.

import test from "node:test";
import assert from "node:assert/strict";

import { StreamMonitor } from "../src/stream/monitor.mjs";

const MANIFEST = (segments) =>
  ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", ...segments].join("\n");

test("health is unknown until a poll has answered", () => {
  const monitor = new StreamMonitor({ playbackUrl: "https://example.invalid/live.m3u8" });
  assert.equal(monitor.health, "unknown");
  assert.equal(monitor.lastPolledAt, null);
});

test("a manifest that keeps producing segments is live", async () => {
  let segments = 3;
  const monitor = new StreamMonitor({
    playbackUrl: "https://example.invalid/live.m3u8",
    degradedAfterMs: 12_000,
    fetchImpl: async () => ({
      ok: true,
      text: async () =>
        MANIFEST(Array.from({ length: segments }, (_, i) => `#EXTINF:4.0,\nseg${segments - 3 + i}.ts`)),
    }),
  });

  await monitor.poll(0);
  segments += 1;
  await monitor.poll(4_000);
  assert.equal(monitor.health, "live");
  assert.equal(monitor.lastPolledAt, 4_000);
});

test("a manifest that stops advancing is degraded, then still not a market suspension", async () => {
  const monitor = new StreamMonitor({
    playbackUrl: "https://example.invalid/live.m3u8",
    degradedAfterMs: 10_000,
    fetchImpl: async () => ({ ok: true, text: async () => MANIFEST(["#EXTINF:4.0,", "seg1.ts"]) }),
  });

  await monitor.poll(0);
  await monitor.poll(30_000);
  assert.equal(monitor.health, "degraded", "the newest segment is 30s old");
  assert.equal(monitor.affectsSettlement, false, "the stream is context and never gates a market");
});

test("a manifest that cannot be fetched is unavailable, with the reason", async () => {
  const monitor = new StreamMonitor({
    playbackUrl: "https://example.invalid/live.m3u8",
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  });

  await monitor.poll(0);
  assert.equal(monitor.health, "unavailable");
  assert.match(monitor.reason, /ENOTFOUND/);
});

test("an HTTP error is unavailable rather than an exception", async () => {
  const monitor = new StreamMonitor({
    playbackUrl: "https://example.invalid/live.m3u8",
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
  });
  await monitor.poll(0);
  assert.equal(monitor.health, "unavailable");
  assert.match(monitor.reason, /404/);
});

test("an HTML error page with status 200 is not reported as a live HLS stream", async () => {
  const monitor = new StreamMonitor({
    playbackUrl: "https://example.invalid/live.m3u8",
    fetchImpl: async () => ({ ok: true, text: async () => "<html><body>login required</body></html>" }),
  });
  await monitor.poll(0);
  assert.equal(monitor.health, "unavailable");
  assert.match(monitor.reason, /HLS|playlist|manifest/i);
});

test("a master playlist is followed to a real media playlist", async () => {
  const fetched = [];
  const master = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=800000", "video/index.m3u8"].join("\n");
  const media = MANIFEST(["#EXTINF:4.0,", "seg1.ts"]);
  const monitor = new StreamMonitor({
    playbackUrl: "https://cdn.example/live/master.m3u8",
    fetchImpl: async (url) => {
      fetched.push(String(url));
      return { ok: true, url: String(url), text: async () => (String(url).includes("master") ? master : media) };
    },
  });
  await monitor.poll(0);
  assert.deepEqual(fetched, [
    "https://cdn.example/live/master.m3u8",
    "https://cdn.example/live/video/index.m3u8",
  ]);
  assert.equal(monitor.health, "live");
  assert.equal(monitor.segmentCount, 1);
});

test("no playback URL means no monitor and no claim", async () => {
  const monitor = new StreamMonitor({ playbackUrl: null });
  await monitor.poll(0);
  assert.equal(monitor.health, "unknown");
  assert.match(monitor.reason, /is configured|not configured/i);
});
