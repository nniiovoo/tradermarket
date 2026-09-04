// Stable, shareable routes (P2 in the report, but a prerequisite for every
// surface below it: a help article, a settled market, or a profile that cannot
// be linked to is not really a page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, buildPath, titleFor, ROUTES } from "../src/router.js";

test("the home route is the default and round-trips", () => {
  assert.deepEqual(parseRoute(""), { name: "home", params: {} });
  assert.deepEqual(parseRoute("#/"), { name: "home", params: {} });
  assert.equal(buildPath("home"), "#/");
});

test("every declared route parses and rebuilds identically", () => {
  const samples = {
    home: {},
    schedule: {},
    room: { roomId: "gameday" },
    activity: {},
    activityDetail: { market: "0xAbC123" },
    portfolio: {},
    leaderboard: {},
    profile: { address: "0xdead" },
    help: {},
    helpArticle: { slug: "what-is-an-invalid-market" },
    enter: {},
    compete: {},
    referrals: {},
    oracle: {},
  };
  for (const name of Object.keys(ROUTES)) {
    assert.ok(name in samples, `no sample for route ${name}`);
    const path = buildPath(name, samples[name]);
    const parsed = parseRoute(path);
    assert.equal(parsed.name, name, `${path} should parse back to ${name}`);
    assert.deepEqual(parsed.params, samples[name], `${path} params round-trip`);
  }
});

test("unknown routes resolve to a not-found route rather than crashing", () => {
  assert.equal(parseRoute("#/nope/whatever").name, "notFound");
  assert.equal(parseRoute("#/room").name, "notFound", "a room needs an id");
});

test("route params are URI-decoded, so addresses and slugs survive", () => {
  assert.deepEqual(parseRoute("#/profile/0xAbC%20D").params, { address: "0xAbC D" });
  assert.equal(buildPath("profile", { address: "0xAbC D" }), "#/profile/0xAbC%20D");
});

test("each route declares a document title, so tabs and history are legible", () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.equal(typeof route.title, "function", `${name} needs a title`);
    const title = route.title({ roomId: "r", market: "0xm", address: "0xa", slug: "s" });
    assert.ok(title.length > 0);
    assert.match(title, /TraderMarket/, `${name} title should carry the brand`);
  }
});

test("routes that need an account are declared, so the shell can prompt", () => {
  assert.equal(ROUTES.portfolio.requiresAccount, true);
  assert.equal(ROUTES.help.requiresAccount, undefined);
});

test("the referrals surface has its own shareable route", () => {
  assert.ok("referrals" in ROUTES, "referrals must be a declared route");
  assert.deepEqual(parseRoute("#/referrals"), { name: "referrals", params: {} });
  assert.equal(buildPath("referrals"), "#/referrals");
  assert.match(titleFor("referrals", {}), /refer/i);
});

test("the resolver console has an unambiguous operator route", () => {
  assert.deepEqual(parseRoute("#/oracle"), { name: "oracle", params: {} });
  assert.match(titleFor("oracle", {}), /resolve|oracle/i);
});

test("view branches compare against real route names, not display labels", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.jsx", import.meta.url).pathname, "utf8");

  // EmptyView receives `activeView={route.name}` — a lowercase route id. Any
  // branch comparing it to a capitalised label is dead code, and the surface it
  // guards silently never renders. Portfolio was exactly this: the whole
  // positions-and-history page fell through to a generic feed.
  for (const match of app.matchAll(/activeView === "([A-Za-z]+)"/g)) {
    assert.ok(
      match[1] in ROUTES,
      `activeView === "${match[1]}" can never be true: it is not a route name`
    );
  }
});
