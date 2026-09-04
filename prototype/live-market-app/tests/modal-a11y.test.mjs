// The report named this gap directly: "modal focus trapping, keyboard return
// focus, routed page titles and live-state announcements still need hands-on
// verification."
//
// Five dialogs in this app carry role="dialog" and aria-modal="true", which is
// a promise to assistive technology that focus is confined to the dialog. None
// of them kept that promise: Tab walked straight out into the page behind,
// Escape did nothing, and closing left focus on <body> — so a keyboard or
// screen-reader user lost their place entirely on every trade.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function source(file) {
  return readFileSync(join(SRC, file), "utf8");
}

test("a focus-trap hook exists and does the three things a dialog owes", () => {
  const hook = source("hooks/useModal.js");
  assert.match(hook, /Escape/, "Escape must close the dialog");
  assert.match(hook, /Tab/, "Tab must be confined to the dialog");
  assert.match(hook, /focus\(\)/, "focus must be moved into, and returned from, the dialog");
  assert.match(hook, /activeElement/, "the previously focused element must be remembered");
});

test("every aria-modal dialog uses the trap", () => {
  const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.jsx$/.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));

  let dialogs = 0;
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const count = (text.match(/aria-modal="true"/g) ?? []).length;
    if (count === 0) continue;
    dialogs += count;
    const traps = (text.match(/useModal\(/g) ?? []).length;
    assert.ok(
      traps >= count,
      `${path} declares ${count} modal dialog(s) but only ${traps} focus trap(s)`
    );
    assert.match(text, /ref=\{/, `${path} must attach the trap to its dialog element`);
  }
  assert.ok(dialogs >= 5, "the known dialogs are still present");
});

test("changing market and source state is announced, not only recoloured", () => {
  const app = source("App.jsx");
  const strip = app.slice(app.indexOf("function HealthStrip"), app.indexOf("const SLOT_STATE_LABEL"));

  assert.match(
    strip,
    /aria-live/,
    "the health strip changes between live, delayed and unavailable — a change nobody hears is a change only sighted users get"
  );
  assert.match(strip, /role="status"|aria-live="polite"/, "state changes are polite, not assertive interruptions");
});

test("the question strip marks which question is in focus", () => {
  const app = source("App.jsx");
  const start = app.indexOf("function QuestionStrip");
  assert.ok(start > 0, "QuestionStrip still exists");
  const strip = app
    .slice(start, app.indexOf("function ", start + 10))
    // Comments explain why a role was avoided; only rendered markup counts.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.match(strip, /aria-current/, "the focused question must be identifiable without colour");
  assert.ok(
    !/role="tablist"|role="tab"/.test(strip),
    "a tablist promises arrow-key navigation between tabs; do not claim the role without it"
  );
});

test("navigating closes any open dialog", () => {
  const app = source("App.jsx");

  // A dialog is scoped to the page that opened it. Left open across a route
  // change it covers a page it has nothing to do with, and — because the trap
  // holds focus — a keyboard user cannot reach the page they navigated to.
  const effect = app.slice(app.indexOf("useEffect(() => onRouteChange"), app.indexOf("useEffect(() => onRouteChange") + 1400);
  assert.match(
    app,
    /setTradeOutcome\(null\);\s*\n?\s*setSellOutcome\(null\)/,
    "a route change must clear the open sheets"
  );
  assert.ok(effect.length > 0, "the route effect still exists");
});

test("the focus trap does not re-run when the page re-renders", () => {
  const hook = source("hooks/useModal.js");

  // Every call site passes a fresh inline arrow, so `onClose` has a new
  // identity on every App render — and App re-renders on the 12 s wallet poll,
  // the 15 s room poll, and every SSE frame. With `onClose` in the dependency
  // array the effect tears down and re-runs each time: cleanup restores focus
  // to a stale capture, then setup pulls focus back to the first field. A
  // keyboard user is thrown out of the control they were on, every few seconds.
  const deps = hook.slice(hook.lastIndexOf("}, ["), hook.lastIndexOf("]"));
  assert.ok(
    !/onClose/.test(deps),
    "the trap must not depend on a callback identity that changes on every render"
  );
  assert.match(hook, /useRef/, "the callback must be held in a ref so the effect can run once");
});
