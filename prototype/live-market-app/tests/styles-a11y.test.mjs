// Accessibility regressions that only appear once a control becomes an anchor.
//
// Routing turned several buttons into real links, which is correct — a page you
// can share needs anchors. But an anchor without an explicit colour falls back
// to the user-agent's default blue, which on this near-black surface is roughly
// 1.3:1 against the background: effectively invisible.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const css = readFileSync(join(SRC, "styles.css"), "utf8");

function jsxFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.jsx?$/.test(entry.name)) files.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(SRC);
  return files;
}

test("every anchor styled as a button gets an explicit colour", () => {
  const used = new Set();
  for (const { text } of jsxFiles()) {
    for (const match of text.matchAll(/<a[^>]*className="([^"]*button[^"]*)"/g)) {
      for (const name of match[1].split(/\s+/)) if (name.endsWith("button")) used.add(name);
    }
  }
  assert.ok(used.size > 0, "the app does use button-styled anchors");

  for (const name of used) {
    const rule = new RegExp(`a\\.${name}\\b[^{]*\\{[^}]*\\bcolor\\s*:`, "s");
    assert.match(
      css,
      rule,
      `a.${name} has no explicit colour, so it renders in the user-agent's default link blue`
    );
  }
});

test("button-styled anchors are not underlined like body links", () => {
  assert.match(css, /\.primary-button[^{]*\{[^}]*text-decoration:\s*none/s);
});
