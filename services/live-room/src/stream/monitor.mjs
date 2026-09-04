// Livestream health, actually measured.
//
// A playback URL could be configured and the service reported a stream health
// signal — but nothing ever looked at the stream, so the signal was a constant
// dressed as a measurement. This polls the HLS manifest the way a player does:
// the age of the newest segment is what "live", "degraded" and "unavailable"
// actually mean.
//
// Provider-agnostic on purpose. An HLS manifest is what every hosted streaming
// service exposes, so this needs no vendor SDK, no credential, and no account —
// which is what makes it something this repo can finish rather than describe.
//
// The livestream is context and never decides a result. A degraded stream must
// never suspend a market; it only says the picture is behind the data.

function playlistLines(manifest) {
  return String(manifest)
    .replace(/^\uFEFF/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isHlsPlaylist(manifest) {
  return playlistLines(manifest)[0] === "#EXTM3U";
}

/** Child media playlists advertised by an HLS master playlist. */
function variantsOf(manifest) {
  const lines = playlistLines(manifest);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("#EXT-X-STREAM-INF:")) continue;
    const uri = lines.slice(index + 1).find((line) => !line.startsWith("#"));
    if (uri) variants.push(uri);
  }
  return variants;
}

function attributeUri(line) {
  const match = /(?:^|,)URI=(?:"([^"]+)"|([^,]+))/.exec(line);
  return match?.[1] ?? match?.[2]?.trim() ?? null;
}

/** Actual media segments (or low-latency parts), never master-playlist URIs. */
function segmentsOf(manifest) {
  const segments = [];
  let expectsSegment = false;
  for (const line of playlistLines(manifest)) {
    if (line.startsWith("#EXTINF:")) {
      expectsSegment = true;
      continue;
    }
    if (line.startsWith("#EXT-X-PART:")) {
      const uri = attributeUri(line);
      if (uri) segments.push(uri);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (expectsSegment) {
      segments.push(line);
      expectsSegment = false;
    }
  }
  return segments;
}

/** The media sequence number, which advances as the encoder publishes. */
function mediaSequence(manifest) {
  const match = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(String(manifest));
  return match ? Number(match[1]) : null;
}

export class StreamMonitor {
  /**
   * @param options.playbackUrl    the HLS manifest, or null when none is configured
   * @param options.degradedAfterMs how stale the newest segment may be
   * @param options.fetchImpl      injectable for tests
   */
  constructor({ playbackUrl = null, degradedAfterMs = 12_000, fetchImpl = null } = {}) {
    this.playbackUrl = playbackUrl;
    this.degradedAfterMs = degradedAfterMs;
    this.fetch = fetchImpl ?? (typeof fetch === "function" ? (...args) => fetch(...args) : null);

    // Unknown until a poll answers. "unavailable" is a measurement — it says
    // the stream was checked and is down — and claiming it before looking is
    // the same fabrication as claiming it is live.
    this.health = "unknown";
    this.reason = playbackUrl ? "not polled yet" : "no livestream playback source is configured";
    this.lastPolledAt = null;
    this.lastAdvancedAt = null;
    this.lastSignature = null;
    this.segmentCount = 0;
  }

  /** The stream never gates a market. Stated as a field so a caller cannot forget. */
  get affectsSettlement() {
    return false;
  }

  /** One poll. Never throws: an outage is a health state, not an exception. */
  async poll(nowMs = Date.now()) {
    if (!this.playbackUrl) {
      this.health = "unknown";
      this.reason = "no livestream playback source is configured";
      return this.snapshot();
    }
    if (!this.fetch) {
      this.health = "unknown";
      this.reason = "no fetch implementation is available to poll the manifest";
      return this.snapshot();
    }

    const load = async (url) => {
      try {
        const response = await this.fetch(url, { cache: "no-store" });
        if (!response.ok) {
          this.health = "unavailable";
          this.reason = `the playback manifest answered HTTP ${response.status}`;
          this.lastPolledAt = nowMs;
          return null;
        }
        return { manifest: await response.text(), url: response.url || url };
      } catch (error) {
        this.health = "unavailable";
        this.reason = `the playback manifest could not be fetched (${error.message})`;
        this.lastPolledAt = nowMs;
        return null;
      }
    };

    let loaded = await load(this.playbackUrl);
    if (!loaded) return this.snapshot();
    const visited = new Set([String(loaded.url)]);
    for (let depth = 0; depth < 3; depth += 1) {
      if (!isHlsPlaylist(loaded.manifest)) {
        this.health = "unavailable";
        this.reason = "the playback response is not a valid HLS playlist (#EXTM3U is missing)";
        this.lastPolledAt = nowMs;
        return this.snapshot();
      }
      const variants = variantsOf(loaded.manifest);
      if (variants.length === 0) break;
      if (depth === 2) {
        this.health = "unavailable";
        this.reason = "the HLS master playlist nesting is too deep";
        this.lastPolledAt = nowMs;
        return this.snapshot();
      }
      let childUrl;
      try {
        childUrl = new URL(variants[0], loaded.url).toString();
      } catch {
        this.health = "unavailable";
        this.reason = "the HLS master playlist contains an invalid media-playlist URL";
        this.lastPolledAt = nowMs;
        return this.snapshot();
      }
      if (visited.has(childUrl)) {
        this.health = "unavailable";
        this.reason = "the HLS master playlist contains a loop";
        this.lastPolledAt = nowMs;
        return this.snapshot();
      }
      visited.add(childUrl);
      loaded = await load(childUrl);
      if (!loaded) return this.snapshot();
    }

    const manifest = loaded.manifest;

    const segments = segmentsOf(manifest);
    // The signature is what changes when the encoder publishes: the media
    // sequence if the manifest carries one, otherwise the newest segment name.
    const signature = `${loaded.url}:${mediaSequence(manifest) ?? ""}:${segments.at(-1) ?? ""}`;
    this.segmentCount = segments.length;
    this.lastPolledAt = nowMs;

    if (segments.length === 0) {
      this.health = "unavailable";
      this.reason = "the HLS media playlist carries no media segments";
      return this.snapshot();
    }

    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.lastAdvancedAt = nowMs;
    }

    const staleFor = this.lastAdvancedAt === null ? 0 : nowMs - this.lastAdvancedAt;
    if (staleFor > this.degradedAfterMs) {
      this.health = "degraded";
      this.reason = `the newest segment has not changed for ${Math.round(staleFor / 1000)}s`;
    } else {
      this.health = "live";
      this.reason = "the manifest is advancing";
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      health: this.health,
      reason: this.reason,
      last_polled_at: this.lastPolledAt,
      segments: this.segmentCount,
      // Repeated in the payload so a consumer reading only this cannot infer
      // that a degraded stream means a suspended market.
      affects_settlement: false,
      presentation_only: true,
    };
  }
}
