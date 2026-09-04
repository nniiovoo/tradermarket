import test from "node:test";
import assert from "node:assert/strict";

import { resolveStreamSource } from "../src/stream-source.js";

test("ordinary YouTube live links become privacy-enhanced embeds", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
  ]) {
    const source = resolveStreamSource(url, { parentHost: "markets.example" });
    assert.equal(source.provider, "youtube");
    assert.equal(source.label, "YouTube Live");
    assert.equal(source.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&playsinline=1");
    assert.equal(source.watchUrl, url);
  }
});

test("Twitch channel links become parent-bound player embeds", () => {
  const source = resolveStreamSource("https://www.twitch.tv/tradermarket", { parentHost: "markets.example" });
  assert.equal(source.provider, "twitch");
  assert.equal(source.label, "Twitch");
  assert.equal(
    source.embedUrl,
    "https://player.twitch.tv/?channel=tradermarket&parent=markets.example&autoplay=true&muted=true"
  );
});

test("Kick channel links become player embeds", () => {
  const source = resolveStreamSource("https://kick.com/tradermarket", { parentHost: "markets.example" });
  assert.equal(source.provider, "kick");
  assert.equal(source.label, "Kick");
  assert.equal(source.embedUrl, "https://player.kick.com/tradermarket?autoplay=true&muted=true");
  assert.equal(source.watchUrl, "https://kick.com/tradermarket");
});

test("a Kick site page is not mistaken for a channel", () => {
  for (const url of ["https://kick.com/categories", "https://kick.com/search", "https://kick.com/following"]) {
    const source = resolveStreamSource(url, { parentHost: "markets.example" });
    assert.equal(source.provider, "kick", url);
    assert.equal(source.embeddable, false, url);
  }
});

test("unsupported, malformed, and insecure links are never embedded", () => {
  for (const url of [
    "javascript:alert(1)",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://example.com/live",
    "https://www.twitch.tv/videos/12345",
    "https://kick.com/categories",
    "not a URL",
  ]) {
    const source = resolveStreamSource(url, { parentHost: "markets.example" });
    assert.equal(source.embedUrl, null, url);
    assert.equal(source.embeddable, false, url);
  }
});

test("an empty stream URL is an absent source, not an error", () => {
  assert.equal(resolveStreamSource(""), null);
  assert.equal(resolveStreamSource(null), null);
});

// A rejected link is still rendered: StreamPlayer shows an "Open stream"
// anchor whenever `watchUrl` is truthy, and `href` is one of the few places a
// `javascript:` URL is still executable. Refusing to embed a scheme while
// handing the same string to an anchor moves the problem, it does not fix it.
test("a link that fails the scheme check is not offered as an external link either", () => {
  for (const url of [
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "not a URL",
  ]) {
    const source = resolveStreamSource(url, { parentHost: "markets.example" });
    assert.equal(source.watchUrl, null, url);
  }
});

test("a well-formed https link the player cannot embed is still safe to open", () => {
  for (const url of ["https://example.com/live", "https://www.twitch.tv/videos/12345"]) {
    const source = resolveStreamSource(url, { parentHost: "markets.example" });
    assert.equal(source.embeddable, false, url);
    assert.equal(source.watchUrl, url, url);
  }
});
