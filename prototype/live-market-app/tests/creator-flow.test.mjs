import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(import.meta.dirname, "../src/App.jsx"), "utf8");

test("the Compete call to action opens a real creator draft workflow", () => {
  assert.match(app, /function CreatorDraftSheet/);
  assert.match(app, /setShowCreatorDraft\(true\)/);
  assert.match(app, /<CreatorDraftSheet/);
  assert.doesNotMatch(app, /onStartDraft=\{\(\) => notify\(/);
});

test("a creator draft captures the minimum reviewable competition facts", () => {
  for (const field of ["participantA", "participantAAccount", "participantB", "participantBAccount", "question", "streamUrl", "winningRule"]) {
    assert.match(app, new RegExp(`name="${field}"`));
  }
  assert.match(app, /resolveStreamSource\(draft\.streamUrl/);
  assert.match(app, /localStorage\.setItem\("tradermarket-creator-draft"/);
  assert.match(app, /new Blob\(/);
  assert.match(app, /"tradermarket-competition-draft\.json"/);
});

test("a livestream event draft captures outcomes and evidence without fake trader accounts", () => {
  for (const field of ["marketType", "subject", "outcomeA", "outcomeB", "approvedSource"]) {
    assert.match(app, new RegExp(`name="${field}"`));
  }
  assert.match(app, /Livestream event/);
  assert.match(app, /independent resolvers/i);
  assert.match(app, /CreatorDraftSheet initialDraft=\{creatorDraftPreset\}/);
});

test("the prepared event shows the betting controls beside the livestream without pretending trading is open", () => {
  const prepared = app.slice(app.indexOf("function PreparedEventMarket"), app.indexOf("function HomeView"));
  assert.match(prepared, /<StreamPlayer market=\{streamMarket\}/);
  assert.match(prepared, /GUEST_RACE_MARKET/);
  assert.match(prepared, /CHOOSE AN OUTCOME/);
  assert.match(prepared, /aria-pressed=\{outcome === "A"\}/);
  assert.match(prepared, /aria-pressed=\{outcome === "B"\}/);
  // Both outcomes are still labelled — but from the draft, not from the
  // participant names of the one draft these strings were copied from.
  assert.match(prepared, /\{draft\.outcomeA\}/);
  assert.match(prepared, /\{draft\.outcomeB\}/);
  assert.match(prepared, /Prediction amount/);
  assert.match(prepared, /className="primary-button prepared-submit" disabled/);
  assert.match(prepared, /Market not open/);
  assert.match(prepared, /first liquidity are confirmed/i);
});
