const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv"]);
const TWITCH_RESERVED_PATHS = new Set([
  "directory",
  "downloads",
  "jobs",
  "p",
  "search",
  "settings",
  "subscriptions",
  "videos",
  "wallet",
]);

const KICK_HOSTS = new Set(["kick.com", "www.kick.com"]);
// Kick's own site navigation, confirmed against help.kick.com and kick.com
// itself — not guessed, since treating one of these as a channel name would
// generate an embed for a channel that does not exist.
const KICK_RESERVED_PATHS = new Set(["categories", "search", "following", "browse"]);

const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/;
const TWITCH_CHANNEL = /^[A-Za-z0-9_]{3,25}$/;
const KICK_CHANNEL = /^[A-Za-z0-9_-]{4,24}$/;

// `watchUrl` is what the player offers as an "open on the platform" anchor, so
// a caller passes null when the link is not one an anchor may carry. Refusing
// to *embed* a scheme is not refusing to *link* it, and `href` is one of the
// few places a `javascript:` URL still executes.
function unavailable(watchUrl, provider = "external", label = "External stream", reason = "This stream cannot play inside TraderMarket.") {
  return { provider, label, watchUrl, embedUrl: null, embeddable: false, reason };
}

function youtubeVideoId(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname.endsWith("youtu.be")) return segments[0] ?? null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  if (["live", "embed"].includes(segments[0])) return segments[1] ?? null;
  return null;
}

/**
 * Turns a creator-facing stream link into the only URL the player may embed.
 * Raw market URLs never become iframe sources.
 */
export function resolveStreamSource(value, { parentHost = globalThis.location?.hostname ?? "" } = {}) {
  const watchUrl = typeof value === "string" ? value.trim() : "";
  if (!watchUrl) return null;

  let url;
  try {
    url = new URL(watchUrl);
  } catch {
    return unavailable(null, "invalid", "Invalid stream", "The stream URL is not valid.");
  }

  if (url.protocol !== "https:") {
    return unavailable(null, "invalid", "Insecure stream", "Stream links must use HTTPS.");
  }

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeVideoId(url);
    if (!VIDEO_ID.test(id ?? "")) {
      return unavailable(
        watchUrl,
        "youtube",
        "YouTube Live",
        "Paste the link for the active YouTube live video, not a channel or homepage."
      );
    }
    return {
      provider: "youtube",
      label: "YouTube Live",
      watchUrl,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1`,
      embeddable: true,
      reason: null,
    };
  }

  if (TWITCH_HOSTS.has(host)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const channel = segments.length === 1 ? segments[0].toLowerCase() : "";
    if (!TWITCH_CHANNEL.test(channel) || TWITCH_RESERVED_PATHS.has(channel)) {
      return unavailable(
        watchUrl,
        "twitch",
        "Twitch",
        "Paste the creator's Twitch channel link, not a clip, category, or recording."
      );
    }
    if (!parentHost) {
      return unavailable(watchUrl, "twitch", "Twitch", "Twitch playback needs TraderMarket's public hostname.");
    }
    const query = new URLSearchParams({ channel, parent: parentHost, autoplay: "true", muted: "true" });
    return {
      provider: "twitch",
      label: "Twitch",
      watchUrl,
      embedUrl: `https://player.twitch.tv/?${query}`,
      embeddable: true,
      reason: null,
    };
  }

  if (KICK_HOSTS.has(host)) {
    const segments = url.pathname.split("/").filter(Boolean);
    const channel = segments.length === 1 ? segments[0].toLowerCase() : "";
    if (!KICK_CHANNEL.test(channel) || KICK_RESERVED_PATHS.has(channel)) {
      return unavailable(
        watchUrl,
        "kick",
        "Kick",
        "Paste the creator's Kick channel link, not a category, search, or other page."
      );
    }
    // Unlike Twitch, Kick's embed takes no parent-domain parameter — confirmed
    // against help.kick.com's own embed documentation, not assumed from the
    // Twitch pattern.
    const query = new URLSearchParams({ autoplay: "true", muted: "true" });
    return {
      provider: "kick",
      label: "Kick",
      watchUrl,
      embedUrl: `https://player.kick.com/${channel}?${query}`,
      embeddable: true,
      reason: null,
    };
  }

  return unavailable(watchUrl);
}
