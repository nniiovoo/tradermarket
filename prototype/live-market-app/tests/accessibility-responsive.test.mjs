import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function hexLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first, second) {
  const a = hexLuminance(first);
  const b = hexLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function cssVariable(name) {
  return css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
}

test("mobile navigation renders and styles anchors for every available destination", () => {
  const mobile = app.slice(app.indexOf("function MobileNav"), app.indexOf("export function App"));
  assert.match(mobile, /navFor\(capabilities\)/);
  assert.doesNotMatch(mobile, /slice\(0,\s*4\)/);
  assert.ok(
    (app.match(/event\.preventDefault\(\);\s*onNavigate\?\.\(route\)/g) ?? []).length >= 2,
    "sidebar and mobile links must not let native hash navigation steal routed focus",
  );
  assert.match(mobile, /scrollIntoView\(\{[^}]*inline:\s*"nearest"[^}]*behavior:\s*scrollBehavior\(\)/s);
  assert.match(css, /\.mobile-nav\s+a\s*\{/);
  assert.match(css, /\.mobile-nav\s+a\.active\s*\{/);
});

test("narrow activity, profile and leaderboard content can reflow without clipping", () => {
  assert.match(css, /\.activity-grid[^}]*minmax\(min\(100%,\s*320px\),\s*1fr\)/s);
  assert.match(css, /\.credit-list\s+a[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.view-title\s+h1\.mono[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.portfolio-grid[^}]*minmax\(min\(100%,/s);
  assert.match(css, /@media\s*\(max-width:\s*520px\)[\s\S]*\.leader-row[^}]*grid-template-areas/s);
});

test("keyboard users get a skip target, routed focus, and visible form focus", () => {
  assert.match(app, /className="skip-link"/);
  assert.match(app, /id="main-content"/);
  assert.match(app, /function RouteFocus/);
  assert.match(css, /\.help-search:focus-within/);
  assert.match(css, /\.chat-input:focus-within/);
  assert.match(css, /\.amount-field\s*>\s*div:focus-within/);
  assert.match(css, /a:focus-visible/);
});

test("transaction errors, confirmations and global feedback are live announcements", () => {
  assert.ok((app.match(/className="inline-error" role="alert"/g) ?? []).length >= 5);
  assert.ok((app.match(/className="success-state" role="status"/g) ?? []).length >= 4);
  assert.match(app, /toast\.tone === "error" \? "alert" : "status"/);
  assert.match(app, /toast\.tone === "error" \? <Info/);
});

test("rapid block metadata is outside the health live region", () => {
  const health = app.slice(app.indexOf("function HealthStrip"), app.indexOf("const SLOT_STATE_LABEL"));
  assert.match(health, /className="health-statuses" role="status"/);
  const liveRegionEnd = health.indexOf("</div>", health.indexOf('className="health-statuses"'));
  assert.ok(liveRegionEnd > 0);
  assert.ok(health.indexOf("indexed block") > liveRegionEnd);
});

test("small text and solid action buttons meet normal-text contrast", () => {
  const background = cssVariable("panel");
  const muted = cssVariable("muted-2");
  const primary = cssVariable("violet");
  const yes = cssVariable("yes");
  const no = cssVariable("no");
  assert.ok(contrast(muted, background) >= 4.5, "muted secondary text must meet 4.5:1 on panels");
  for (const color of [primary, yes, no]) {
    assert.ok(contrast("#ffffff", color) >= 4.5, `${color} must support normal white action text`);
  }
});

test("programmatic scrolling respects reduced-motion preferences", () => {
  assert.match(app, /function scrollBehavior/);
  assert.match(app, /prefers-reduced-motion:\s*reduce/);
  assert.match(app, /window\.scrollTo\(\{ top:\s*90, behavior:\s*scrollBehavior\(\) \}\)/);
});
