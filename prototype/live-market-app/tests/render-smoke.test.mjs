// A render smoke test.
//
// Every other app test reads source text. That caught a great deal, and missed
// the thing that actually mattered: a `useMemo` moved below its first use is
// valid syntax, builds cleanly, passes every source-level assertion — and makes
// the entire application a blank white page. The only way to catch that class
// is to render.
//
// This renders the real App against a fake API and asserts that each route
// produces content and throws nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// JSX and `import.meta.env` are build-time concerns; a loader supplies both.
globalThis.__VITE_ENV__ = {};
register(new URL("./helpers/jsx-loader.mjs", import.meta.url), pathToFileURL("./"));

/** The browser surface the shell touches while rendering once on the server. */
function shimBrowser(hash) {
  globalThis.window = globalThis;
  globalThis.location = { hash, href: `http://localhost/${hash}`, pathname: "/" };
  globalThis.document = {
    title: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
  };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.scrollTo = () => {};
  // Nothing is configured, so every read fails the way an unreachable API does.
  globalThis.fetch = async () => {
    throw new Error("no API in this test");
  };
}

test("every route renders without throwing", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { App } = await import("../src/App.jsx");

  const routes = ["#/", "#/schedule", "#/activity", "#/portfolio", "#/leaderboard", "#/help", "#/enter", "#/compete", "#/oracle"];
  for (const route of routes) {
    shimBrowser(route.slice(1));
    const markup = renderToStaticMarkup(React.createElement(App));
    assert.ok(markup.length > 200, `${route} rendered ${markup.length} characters`);
    assert.ok(!/NaN|undefined/.test(markup), `${route} rendered a placeholder value`);
  }
});
