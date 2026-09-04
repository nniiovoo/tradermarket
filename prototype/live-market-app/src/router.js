// A dependency-free hash router.
//
// Hash routing rather than history routing because this app is served as static
// files from several hosts; a deep link must work without server rewrites.
// Every secondary surface — a settled market, a help article, a profile — gets a
// real URL so it can be shared, bookmarked, and reached from a support reply.

export const ROUTES = {
  home: {
    pattern: [],
    title: () => "TraderMarket — live prediction markets",
  },
  schedule: {
    pattern: ["schedule"],
    title: () => "Schedule — TraderMarket",
  },
  room: {
    pattern: ["room", ":roomId"],
    title: ({ roomId }) => `Live room ${roomId} — TraderMarket`,
  },
  activity: {
    pattern: ["activity"],
    title: () => "Market Activity — TraderMarket",
  },
  activityDetail: {
    pattern: ["activity", ":market"],
    title: ({ market }) => `Settlement ${short(market)} — TraderMarket`,
  },
  portfolio: {
    pattern: ["portfolio"],
    title: () => "Portfolio — TraderMarket",
    requiresAccount: true,
  },
  leaderboard: {
    pattern: ["leaderboard"],
    title: () => "Leaderboard — TraderMarket",
  },
  profile: {
    pattern: ["profile", ":address"],
    title: ({ address }) => `${short(address)} — TraderMarket`,
  },
  help: {
    pattern: ["help"],
    title: () => "Help centre — TraderMarket",
  },
  helpArticle: {
    pattern: ["help", ":slug"],
    title: ({ slug }) => `${slug.replace(/-/g, " ")} — TraderMarket help`,
  },
  enter: {
    pattern: ["enter"],
    title: () => "Get started — TraderMarket",
  },
  compete: {
    pattern: ["compete"],
    title: () => "Compete — TraderMarket",
  },
  referrals: {
    pattern: ["referrals"],
    title: () => "Refer a forecaster — TraderMarket",
    requiresAccount: true,
  },
  oracle: {
    pattern: ["oracle"],
    title: () => "Resolve livestream evidence — TraderMarket",
  },
};

function short(value = "") {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function segments(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  return raw.split("/").filter((part) => part.length > 0);
}

/** Resolves a hash to a route name and its decoded params. */
export function parseRoute(hash) {
  const parts = segments(hash);
  if (parts.length === 0) return { name: "home", params: {} };

  // Longest pattern first, so `/help/:slug` beats `/help`.
  const candidates = Object.entries(ROUTES).sort((a, b) => b[1].pattern.length - a[1].pattern.length);
  for (const [name, route] of candidates) {
    if (route.pattern.length !== parts.length) continue;
    const params = {};
    let matched = true;
    for (let index = 0; index < route.pattern.length; index++) {
      const segment = route.pattern[index];
      if (segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(parts[index]);
      else if (segment !== parts[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { name, params };
  }
  return { name: "notFound", params: {} };
}

/** Builds the hash path for a route. */
export function buildPath(name, params = {}) {
  const route = ROUTES[name];
  if (!route) throw new Error(`unknown route ${name}`);
  const parts = route.pattern.map((segment) =>
    segment.startsWith(":") ? encodeURIComponent(params[segment.slice(1)] ?? "") : segment
  );
  return `#/${parts.join("/")}`;
}

export function titleFor(name, params = {}) {
  return (ROUTES[name] ?? ROUTES.home).title(params);
}

/** Subscribes to hash changes. Returns an unsubscribe function. */
export function onRouteChange(handler) {
  if (typeof window === "undefined") return () => {};
  const listener = () => handler(parseRoute(window.location.hash));
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function navigate(name, params = {}) {
  if (typeof window === "undefined") return;
  window.location.hash = buildPath(name, params);
}
