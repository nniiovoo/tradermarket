// The report's central demand: configured live paths must be truthful, and
// fixture claims must go. These tests read the shipped source and assert that
// nothing asserts a capability the deployment has not got.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

function allSource() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(jsx?|css)$/.test(entry.name)) files.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(SRC);
  return files;
}

test("the hard-coded leaderboard fixture is gone", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(!/signal\.sara|Northstar|latecall|0xMaya/.test(app), "invented forecaster names must not ship");
  assert.ok(!/const leaderboard = \[/.test(app), "the leaderboard fixture must not ship");
});

test("no surface claims gas sponsorship", () => {
  for (const { path, text } of allSource()) {
    assert.ok(
      !/gas is sponsored|we sponsor|sponsored for you|no gas fees/i.test(text),
      `${path} must not claim gas sponsorship`
    );
  }
});

test("no surface invents users, volume or payouts", () => {
  for (const { path, text } of allSource()) {
    if (path.endsWith(".css")) continue;
    assert.ok(!/\$\d[\d,]*,\d{3}(\.\d+)? (volume|payout|paid out)/i.test(text), `${path} invents a money figure`);
    assert.ok(!/\b\d+(\.\d+)?[KM] (viewers|traders|users)\b/i.test(text), `${path} invents an audience figure`);
  }
});

test("the app never asserts a deployment it cannot see", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  // Any "connected"/"live" deployment claim must be guarded by testnet.deployed.
  const claims = [...app.matchAll(/Connected to the deployed[^"']*/g)];
  assert.ok(claims.length > 0, "the strip still exists");
  for (const claim of claims) {
    const context = app.slice(Math.max(0, claim.index - 320), claim.index);
    // `confirmedDeployment` is `testnet.deployed && testnet.snapshot`: an env
    // var says an address was configured, a snapshot says it answered.
    assert.match(
      context,
      /confirmedDeployment/,
      "a deployment claim must depend on a read that succeeded, not on configuration"
    );
  }
});

test("legal availability is never claimed anywhere in the app", () => {
  for (const { path, text } of allSource()) {
    assert.ok(
      !/(licensed|regulated|legally available|approved in your)/i.test(text.replace(/not (licensed|regulated)/gi, "")),
      `${path} must not claim legal standing`
    );
  }
});

test("every route target in the shell is a real declared route", async () => {
  const { ROUTES } = await import("../src/router.js");
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  for (const match of app.matchAll(/buildPath\("([a-zA-Z]+)"/g)) {
    assert.ok(match[1] in ROUTES, `buildPath("${match[1]}") is not a declared route`);
  }
  for (const match of app.matchAll(/case "([a-zA-Z]+)":/g)) {
    const name = match[1];
    if (["home", "notFound"].includes(name)) continue;
    if (!(name in ROUTES)) continue;
    assert.ok(name in ROUTES, `${name} must be declared`);
  }
});

test("the interface states who holds custody, and it is not the interface", () => {
  const entry = readFileSync(join(SRC, "views/EntryView.jsx"), "utf8");
  assert.match(entry, /never (holds|takes custody)/i);
});

test("the activity view explains invalid markets rather than hiding them", () => {
  const activity = readFileSync(join(SRC, "views/ActivityView.jsx"), "utf8");
  assert.match(activity, /Invalid/);
  assert.match(activity, /refund/i);
  assert.match(activity, /never becomes a default win/i);
});

test("TraderMarket's differentiators are visible in the product, not just the docs", () => {
  const files = allSource().map((entry) => entry.text).join("\n");
  assert.match(files, /0\.3%/, "the LP fee");
  assert.match(files, /1%/, "the winning-participant reward");
  assert.match(files, /liquidity/i);
  assert.match(files, /Integrity Bond|integrity bond/i);
  assert.match(files, /challenge/i);
  assert.match(files, /restricted/i);
  assert.match(files, /approved (event )?(data|source)/i);
});

test("chat is served by the chat service, not by invented messages", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/chainreaction|watchtower|That probability moved fast/.test(app),
    "the invented chat transcript must not ship"
  );

  const chat = readFileSync(join(SRC, "views/LiveChat.jsx"), "utf8");
  assert.match(chat, /\/chat/, "chat must read from the room chat endpoint");
  assert.match(chat, /client\.post\(/, "the chat input must actually submit");
  assert.match(chat, /capabilities\?\.capabilities\?\.chat/, "chat must respect the chat capability");
  assert.match(
    chat,
    /never changes a result|cannot change a result/i,
    "chat must state that it is not authoritative"
  );
});

test("no surface ships a scripted activity feed", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/Nova market gate opened|liquidity added<|moved to 54¢|Rooftop challenge/.test(app),
    "the invented activity feed must not ship"
  );
  assert.ok(
    !/\$[\d,]+ liquidity added/.test(app),
    "an invented liquidity figure must not ship"
  );
});

test("the portfolio reads its history from the portfolio API", () => {
  const view = readFileSync(join(SRC, "views/PortfolioHistory.jsx"), "utf8");
  assert.match(view, /\/v1\/portfolio\//, "history must come from the portfolio endpoint");
  for (const heading of [/Predictions/i, /Transactions/i, /Payouts/i, /Liquidity/i]) {
    assert.match(view, heading, `the history must cover ${heading}`);
  }
  // Strip comments first: the rule is about what the view renders, and the
  // module's own note explaining why there is no profit column is not a claim.
  const code = view.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(
    !/profit|P&L|unrealised|unrealized/i.test(code),
    "an open position must not be shown with a profit figure"
  );
});

test("growth surfaces never invent a community, a referral reward, or a win", () => {
  const growth = readFileSync(join(SRC, "views/GrowthViews.jsx"), "utf8");
  assert.match(growth, /\/v1\/referrals\//, "referrals must come from the referral endpoint");
  assert.match(growth, /\/v1\/social-proof/, "social proof must come from the social-proof endpoint");
  assert.ok(
    !/\b\d+[,\d]*\s*(members|traders online|people watching)\b/i.test(growth),
    "a community figure must not be hard-coded"
  );
  assert.ok(
    !/earn \$|get \$\d|bonus of/i.test(growth),
    "no reward may be advertised in the surface itself"
  );
});

test("the entry flow states which kinds of account this deployment supports", () => {
  const entry = readFileSync(join(SRC, "views/EntryView.jsx"), "utf8");
  assert.match(entry, /\/v1\/account-options/, "account choice must come from the API, not from assumptions");
});

test("the home grid never falls back to invented markets", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // Invented audience and pool figures from the original mock.
  assert.ok(!/viewers: "\d+(\.\d+)?K"/.test(app), "an invented viewer count must not ship");
  assert.ok(!/pool: \d{4,}/.test(app), "an invented pool figure must not ship");
  assert.ok(
    !/Nova vs Arc|Maya's rooftop|Alice vs Remi|Bob's \$10K/.test(app),
    "invented market titles must not ship"
  );

  // And the grid itself must not silently substitute a fixture list.
  assert.ok(
    !/room\?\.roomCards\?\.length \? room\.roomCards : markets/.test(app),
    "the home grid must not fall back to a fixture list"
  );
});

test("the network strip names the chain that is actually configured", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/POLYGON AMOY · (LIVE CONTRACT|DEPLOYMENT READY)/.test(app),
    "the network name must not be hard-coded: a build serving another chain would misreport it"
  );
  assert.ok(
    !/chain 80002/.test(app),
    "a hard-coded chain id misreports every other deployment"
  );
  assert.match(app, /chain_id/, "the strip must read the chain id the API reports");
});

test("a settled or closed market does not offer to sell you a position", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const panel = app.slice(app.indexOf("function MarketPanel"), app.indexOf("function MarketCard"));

  assert.ok(
    !/<span className="market-open"><span \/> \{market\.gateLabel \|\| "MARKET OPEN"\}/.test(panel),
    "a market with no gate state must not be labelled open by default"
  );
  assert.match(
    panel,
    /tradable|market\.state|canTrade/,
    "the outcome buttons must depend on whether the market can actually be traded"
  );
  assert.ok(
    !/contract demo mode/.test(panel),
    "a market read from a real chain is not a demo"
  );
});

test("no balance is invented for a wallet the app has not read", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  assert.ok(
    !/testnet\.snapshot\?\.wallet \? toUsdc\(testnet\.snapshot\.wallet\.usdcBalance\) : 250/.test(app),
    "a wallet with no reading must not be shown a made-up balance"
  );
  assert.ok(
    !/\{ usdc: 250,/.test(app),
    "an unread portfolio must not be filled with a made-up balance"
  );
  assert.match(
    app,
    /walletBalance = testnet\.snapshot\?\.wallet \? toUsdc\([^)]*\) : null/,
    "an unread balance is null, and the surface renders that honestly"
  );
});

test("no rendered copy names a chain the deployment might not be on", () => {
  // Rendered copy has to hold for whatever chain the API reports. The wallet
  // gateway is different: it is pinned to Amoy by construction, so its Amoy
  // messages are true — the next test keeps that pinning honest.
  for (const { path, text } of allSource()) {
    if (path.endsWith(".css") || path.includes("/web3/")) continue;
    const code = text.replace(/const CHAIN_NAMES = \{[^}]*\};/, "");
    assert.ok(
      !/\b(on|to) (Polygon )?Amoy\b/i.test(code),
      `${path} names Amoy without checking the configured chain`
    );
  }
});

test("the wallet gateway that names Amoy is actually pinned to Amoy", () => {
  const gateway = readFileSync(join(SRC, "web3/marketGateway.js"), "utf8");
  if (!/\b(on|to) (Polygon )?Amoy\b/i.test(gateway)) return;

  assert.match(gateway, /polygonAmoy/, "the client must be pinned to the chain it names");
  assert.match(gateway, /ensureAmoy|AMOY_CHAIN_ID/, "and must require the wallet to be on it");
});

test("a viewer badge is shown only where viewers are actually counted", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/viewers: String\(liveRoom\.snapshot\.viewers\?\.count \?\? 0\)/.test(app),
    "an uncounted viewer figure must not default to a number"
  );
  // The badges must be conditional: rendering `market.viewers` unguarded prints
  // "0" or "undefined" where nothing measures an audience.
  for (const badge of [/viewer-badge/, /card-viewers/]) {
    const index = app.search(badge);
    assert.ok(index > 0, `${badge} still exists`);
    const around = app.slice(index - 120, index + 160);
    assert.match(around, /market\.viewers \?|market\.viewers &&|viewers != null/, "the badge must be guarded");
  }
});

test("the LIVE badge is shown only over an actual live stream", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const player = app.slice(app.indexOf("function StreamPlayer"), app.indexOf("function MarketPanel"));

  // The badge must sit behind a guard on the same line, not be rendered
  // unconditionally: over a still image on a settled market it claims a
  // broadcast that is not happening.
  const badgeLine = player.split("\n").find((line) => line.includes("live-badge"));
  assert.ok(badgeLine, "the badge still exists");
  assert.match(
    badgeLine,
    /hasStream|streamHealth|playing/,
    "the LIVE badge must depend on there actually being a stream"
  );
});

test("the player embeds only a resolved provider URL, never the raw market URL", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const player = app.slice(app.indexOf("function StreamPlayer"), app.indexOf("function MarketPanel"));

  assert.match(player, /resolveStreamSource/, "the player must resolve the provider before embedding");
  assert.ok(!/src=\{market\.streamUrl\}/.test(player), "an arbitrary market URL must never become an iframe source");
  assert.match(player, /source\.embedUrl/, "the iframe must use the provider-safe embed URL");
});

test("room cards receive the stream URL projected by the coordinator", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const cards = app.slice(app.indexOf("const roomCards = useMemo"), app.indexOf("const room = useMemo"));
  assert.match(cards, /streamUrl:\s*slot\.stream_url/, "the audience must receive the room's indexed stream URL");
});

test("no view branch references an identifier that no longer exists", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // The leaderboard fixture was removed, but its render branch survived. It is
  // dead only because routing happens to reach LeaderboardView first; the code
  // itself still maps over a `leaderboard` that is not defined anywhere, and it
  // still describes rankings by "verified profit and prediction accuracy",
  // which is not what the real leaderboard measures.
  assert.ok(!/\{leaderboard\.map\(/.test(app), "a removed fixture must not still be mapped over");
  assert.ok(
    !/Ranked by verified profit and prediction accuracy/.test(app),
    "a description of a ranking basis that does not exist must not ship"
  );
});

test("chat posts sign a bound claim, not the bare message text", () => {
  const chat = readFileSync(join(SRC, "views/LiveChat.jsx"), "utf8");
  const claim = readFileSync(join(SRC, "chat-claim.js"), "utf8");

  assert.match(claim, /tradermarket-chat-v1/, "the signed string must name its purpose");
  assert.match(claim, /roomId/, "and the room it is for");
  assert.match(claim, /issuedAt/, "and when it was made, so it can expire");

  assert.match(chat, /chatClaim\(/, "the view must use the shared definition, not its own copy");
  assert.match(chat, /claim,/, "and the claim must be sent alongside the signature");
});

test("the client's claim string matches the service's, field for field", async () => {
  const { chatClaim } = await import("../src/chat-claim.js");
  const built = chatClaim({ roomId: "room-1", address: "0xAbC", text: "hello", issuedAt: 42 });

  // The same five fields, in the same order, joined the same way as
  // ChatService.claimFor. A drift here rejects every post with "claim does not
  // match", so it is pinned rather than left to agree by luck.
  assert.deepEqual(built.split("\n"), ["tradermarket-chat-v1", "room-1", "0xabc", "42", "hello"]);
});

test("a submission that did not happen produces no receipt", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // The demo path slept, said "queued", and returned {} — and the trade sheet
  // then rendered "PREDICTION QUEUED / 24.25 positions / $24.25 if correct" for
  // a transaction that was never built, let alone sent.
  assert.ok(
    !/Demo prediction queued|Demo liquidity queued|demo queued/i.test(app),
    "no surface may report queueing something it did not submit"
  );
  assert.ok(
    !/await new Promise\(\(resolve\) => window\.setTimeout\(resolve, 350\)\)/.test(app),
    "a fake latency that stands in for a submission must not ship"
  );
  assert.match(
    app,
    /if \(!isLiveSelection\) throw new Error\(/,
    "an unsubmittable action must fail loudly rather than return an empty success"
  );
});

test("liquidity and price come from the room, not from placeholder defaults", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const cards = app.slice(app.indexOf("const roomCards = useMemo"), app.indexOf("const room = useMemo"));

  assert.ok(!/pool: 0,/.test(cards), "a hard-coded zero pool misreports a market that holds real inventory");
  assert.ok(
    !/yes: slot\.price \? [^:]*: 50,/.test(cards),
    "a 50¢ placeholder is a price nobody quoted"
  );
  assert.match(cards, /slot\.liquidity/, "the card must read the liquidity the room reports");
});

test("an estimated pool share is not offered without a real pool", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const sheet = app.slice(app.indexOf("function LiquiditySheet"), app.indexOf("function FundsSheet"));

  // With pool === 0 the fallback computes deposit/(0+deposit) = 100%, and shows
  // that to a prospective LP as their estimated share of a pool whose real size
  // this build never read.
  assert.ok(
    !/deposit \/ \(market\.pool \+ deposit\)/.test(sheet),
    "a share computed from an unread pool is a fabricated number"
  );
  assert.match(sheet, /poolShare === null|shareKnown|share == null/, "an unknown share must render as unknown");
});

test("a probability bar with no price renders as unpriced, not as a number", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const start = app.indexOf("function ProbabilityBar");
  const bar = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.match(
    bar,
    /market\.yes === null|priced|yes == null/,
    "an unpriced market must say so rather than draw a bar at NaN%"
  );
});

test("an unreachable room is not reported as a room with nothing on", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const anchor = app.indexOf("No live room is configured");
  assert.ok(anchor > 0, "the home empty state still exists");
  const empty = app.slice(anchor - 900, anchor + 1400);

  // "This room has no open slot at the moment" is a positive claim about the
  // room's state. Made while the API is unreachable, it reports something the
  // app cannot see — the two cases must not share a message.
  assert.match(
    empty,
    /!room\.snapshot|cannot be reached/i,
    "an unreachable room must be distinguished from a room with no open slot"
  );
});

test("a deployed standalone market still renders without a Live Room", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // Removing the fixture markets removed the object that the standalone path
  // used to overlay real contract state onto. A deployment configured with only
  // VITE_MARKET_ADDRESS — no room API — must still show its one market, or the
  // single-market product regressed to a blank page.
  assert.match(
    app,
    /standaloneMarket|testnet\.deployed && !room/,
    "the deployed single-market path must build a market of its own"
  );
  assert.match(
    app,
    /activeMarket \?\? standaloneMarket|standaloneMarket \?\?/,
    "and it must be what the page selects when there is no room"
  );
});

test("an unpriced market cannot be quoted", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const panel = app.slice(app.indexOf("function MarketPanel"), app.indexOf("function MarketCard"));
  const sheet = app.slice(app.indexOf("function TradeSheet"), app.indexOf("function SellSheet"));

  // With no cleared price the fallback quote yields 0 positions and a $0.00
  // payout — a quote for a market nobody has priced. The buttons must not open
  // the sheet, and the sheet must say so if it is reached another way.
  assert.match(panel, /priced|market\.yes === null|disabled=\{/, "buy buttons must be inert without a price");
  assert.match(sheet, /no price|unpriced|priced === false|price === null/i, "the sheet must refuse to quote");
});

test("a market with no reserves is not given a 50/50 price", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/reserveTotal === 0n \? 50 :/.test(app),
    "a market before its first liquidity has no price; 50 is a quote nobody made"
  );
});

test("the LIVE badge on a market card depends on there being a stream", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const start = app.indexOf("function MarketCard");
  assert.ok(start > 0);
  const card = app.slice(start, app.indexOf("function ", start + 10));
  const at = card.indexOf("live-badge");
  assert.ok(at > 0, "the card badge still exists");
  // The guard may sit on the line above; look at the surrounding block, with
  // comments stripped so an explanation cannot stand in for one.
  const around = card
    .slice(Math.max(0, at - 320), at)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.match(
    around,
    /streamIsLive|streamHealth|market\.state === "open"/,
    "a settled question with no stream must not advertise LIVE"
  );
});

test("a market that has not opened is not described as closed", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const panel = app.slice(app.indexOf("function MarketPanel"), app.indexOf("function MarketCard"));

  // marketIsTradable correctly fails closed for announced, awaiting-liquidity,
  // suspended and recovering — but the copy said "Forecasting is closed", which
  // is wrong for all four and contradicts the kicker directly above it.
  assert.match(
    panel,
    /notYetOpen|hasNotOpened|awaiting|suspended/i,
    "not-yet-open and paused states need their own copy"
  );
});

test("the entry flow signs its terms acceptance when the wallet can", () => {
  const entry = readFileSync(join(SRC, "views/EntryView.jsx"), "utf8");
  assert.match(entry, /tradermarket-terms-v1|termsClaim/, "the acceptance must be signable");
  assert.match(entry, /signature/, "and the signature sent with it");
  assert.match(
    entry,
    /self-declared|not proven|proven === false|!.*proven/,
    "an acceptance that could not be signed must say what it is"
  );
});

test("the selected contract's data is only overlaid on the market it belongs to", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // Matching by slot index meant that with both a room and a market contract
  // configured, room slot 0 was painted with a different contract's question,
  // reserves, price, pool and outcome — and its Confirm button submitted there.
  assert.ok(
    !/selectedMarket\.slotIndex === 0/.test(app),
    "the deployed market must be identified by address, not by position in a room"
  );
  assert.match(app, /testnet\.snapshot\?\.marketAddress/, "a successful read must identify its contract");
  assert.match(
    app,
    /selectedMarket\.market \?\? testnet\.marketAddress/,
    "the selected market must be compared with the address that produced the snapshot"
  );
});

test("a market that cannot be quoted shows no order summary", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const sheet = app.slice(app.indexOf("function TradeSheet"), app.indexOf("function SellSheet"));

  // The fallback modelled a constant price, a 1% fee and zero slippage — on a
  // room-only build that path ran for every trade, producing a full order
  // summary for a market this build cannot quote.
  assert.ok(
    !/const winnerFee = safeAmount \* 0\.01/.test(sheet),
    "a modelled fee is a number nobody read"
  );
  assert.match(sheet, /calculations === null|quotable/, "an unquotable market must render as such");
});

test("the winning-participant fee rate is read, never assumed", () => {
  const math = readFileSync(join(SRC, "web3/marketMath.js"), "utf8");
  assert.ok(
    !/budget \* 100n \/ 10_000n/.test(math),
    "the rate is per-market and zero is valid; a hardcoded 1% misprices every other market"
  );
  assert.match(math, /winnerRewardBps/, "the rate must be a parameter");
});

test("the RPC-fallback strip only claims to read a contract that exists", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const at = app.indexOf("reading the market contract directly over RPC");
  assert.ok(at > 0, "the strip still exists");
  // The condition that renders the strip, not merely a nearby mention of
  // `testnet.deployed` on some other element.
  // The claim itself must be conditional on there being a contract, whether
  // that guard sits on the strip or on the sentence.
  const sentence = app.slice(Math.max(0, at - 260), at);
  assert.match(
    sentence,
    /testnet\.deployed/,
    "on a room-only build there is no contract to read, so the claim must be guarded"
  );
});

test("room health does not claim a direct contract fallback without a readable contract", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const health = app.slice(app.indexOf("function HealthStrip"), app.indexOf("const SLOT_STATE_LABEL"));
  assert.match(health, /directContract/);
  assert.match(health, /Room API unavailable/);
});

test("a placeholder address is never presented as a connected account", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.ok(
    !/0x71A4000000000000000000000000000000092A4F/.test(app),
    "an invented wallet address is an invented user, and it was sent as x-tm-address on every call"
  );
});

test("the sell sheet does not quote zero for a market it cannot read", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const sheet = app.slice(app.indexOf("function SellSheet"), app.indexOf("function ChallengeSheet"));

  // quoteSell throws without reserves, and the catch returned zeroes — so the
  // sheet showed "Gross pool output $0.00 / Estimated USDC received $0.00" for
  // a market whose reserves this build never read. The button is disabled, so
  // nothing wrong is submitted; the numbers are still invented.
  assert.match(sheet, /calculations === null|quotable/, "an unquotable sell must render as unavailable");
});

test("a settled row distinguishes claimable, claimed, and not known", () => {
  const view = readFileSync(join(SRC, "views/PortfolioHistory.jsx"), "utf8");

  // `claimable` is tri-state on the API: true, false, or null where the build
  // cannot read the per-account balances. A plain truthy test collapses null
  // into "claimed", telling someone their money is settled when nobody looked.
  assert.ok(
    !/row\.claimable \? "Claimable" : `\$\{usdc\(row\.claimed\)\} claimed`/.test(view),
    "a null claimable must not render as claimed"
  );
  assert.match(view, /claimable === null|claimable === true/, "the three states must be handled explicitly");
  assert.match(view, /owed/, "and where an amount is known it should be shown");
});

test("no surface names a participant-reward rate it did not read", () => {
  for (const { path, text } of allSource()) {
    if (path.endsWith(".css")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
    // The rate is per-market, and the game day itself runs two markets at 100
    // bps and two at 0. Naming "1%" in copy attached to a specific market is a
    // claim about that market, and it is wrong for half of them.
    assert.ok(
      !/the 1% winning-participant reward|1% participant reward/.test(code),
      `${path} names a rate rather than reading the market's own`
    );
  }
});

test("the spotlight follows the room rather than freezing at the first snapshot", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // Storing the card froze the spotlight at whatever the room looked like when
  // the page loaded: a settled slot kept rendering as OPEN at a stale price,
  // with buy buttons enabled, while the grid beside it showed Final.
  assert.ok(
    !/setActiveMarket\(roomCards\.find/.test(app),
    "the selection must be an identity, not a copy of the card"
  );
  assert.match(app, /selectedSlotIndex|selectedMarketId/, "a stable selection key");
});

test("a deployment is claimed only after a successful contract read", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const at = app.indexOf("Connected to the deployed market");
  assert.ok(at > 0, "the strip still exists");

  // testnet.deployed is a regex over an env var — it says a market address was
  // configured, not that anything answered. The claim must depend on a read.
  const condition = app.slice(Math.max(0, at - 320), at);
  assert.match(
    condition,
    /testnet\.snapshot|contractRead|confirmedDeployment/,
    "an env var is a configuration, not a connection"
  );
});

test("a selected contract address is distinguished from a successful contract read", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.match(app, /CONTRACT UNREACHABLE/);
  assert.match(app, /selected market contract cannot be read/i);
});

test("a room route renders the room it names, or says it cannot", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const at = app.indexOf('case "room":');
  assert.ok(at > 0, "the room route still exists");
  const branch = app.slice(at, at + 900);
  assert.match(
    branch,
    /route\.params\.roomId|params\.roomId/,
    "the route must use its own parameter rather than rendering the one configured room under any URL"
  );
});

test("portfolio actions are about the configured market, not the Home selection", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");

  // `isLiveSelection` is about which market the Home spotlight is showing. The
  // Portfolio's sell and claim buttons act on the one configured contract, so
  // gating them on the spotlight meant real positions could not be sold
  // whenever the reader happened to be looking at another question — and the
  // sheet then said the reserves had not been read when they had.
  const sell = app.slice(app.indexOf("const submitSale"), app.indexOf("const submitChallenge"));
  assert.ok(
    !/if \(!isLiveSelection\) throw new Error\(NOT_CONFIGURED\)/.test(sell),
    "selling from the portfolio must not depend on what Home is showing"
  );
  assert.match(sell, /testnet\.deployed|confirmedDeployment/, "it depends on there being a contract");

  // And the sheet must be given that market, not the spotlight's.
  assert.match(app, /sellOutcome && \(?portfolioMarket|portfolioMarket/, "the sell sheet reads the configured market");
});

test("a settled market's missing price is described as past, not pending", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const start = app.indexOf("function ProbabilityBar");
  const bar = app.slice(start, app.indexOf("\nfunction ", start + 10));

  // Settlement drains the reserves and the LP shares, so a resolved market has
  // no current price — but "a price appears once the first liquidity is
  // supplied" tells the reader to wait for one that is never coming.
  assert.match(
    bar,
    /finalOutcome|resolved|settled/i,
    "a resolved market needs different copy from one that has not opened"
  );
});

test("source evidence says when a fact was restated by the provider", () => {
  // A provider can withdraw a figure it already reported. The settlement record
  // publishes the corrected one — showing it without saying it was restated
  // reads as though the source never changed its mind, on the one surface whose
  // whole job is to be checkable.
  const activity = readFileSync(join(SRC, "views/ActivityView.jsx"), "utf8");
  assert.match(activity, /event\.corrected/);
  assert.match(activity, /restated by the source/);
});

test("the health strip renders the indexer signal, not just stream and source", () => {
  // The Coordinator computes three independent signals — stream, source and
  // indexer. The strip rendered two of them plus the SSE connection state, so
  // the one signal that says "the data on this page is behind the chain" was
  // dropped. A stalled indexer then looked exactly like a healthy room: three
  // green pills and a block number presented as current, while the portfolio
  // still listed a settled market as open and owed nothing.
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  assert.match(app, /health\?\.indexer/, "the signal the API sends must reach the page");
  assert.match(app, /indexer: \{/, "with copy of its own");
  // And the block number must not be presented as the chain's head when the
  // indexer is the thing that is behind.
  assert.match(app, /indexed block/i);
});

// The prepared stage renders `draft.question` dynamically but used to hard-code
// the two outcome labels beneath it. That is the one control on the surface a
// user acts on: with any draft other than the one the strings were copied from,
// the buttons offer outcomes the question does not ask about, and the operator
// changing the draft gets no error — only a market whose choices are a lie.
test("the prepared stage labels its outcomes from the draft, not from copied strings", () => {
  const app = readFileSync(join(SRC, "App.jsx"), "utf8");
  const start = app.indexOf('className="prepared-stage"');
  assert.ok(start > 0, "the prepared stage still exists");
  const stage = app.slice(app.lastIndexOf("function ", start), app.indexOf("\n}", start));

  assert.ok(
    !/>(\s*)(FIRST GUEST|SECOND GUEST)(\s*)</.test(stage),
    "outcome buttons must not hard-code a specific draft's participant names"
  );
  assert.match(stage, /draft\.outcomeA/, "outcome A must be labelled from the draft");
  assert.match(stage, /draft\.outcomeB/, "outcome B must be labelled from the draft");
  assert.ok(
    !/outcome === "A" \? "the first guest" : "the second guest"/.test(stage),
    "the confirmation label must be derived from the draft too"
  );
  assert.ok(
    !/title: "Example Creator official Twitch livestream"/.test(stage),
    "the stream title must come from the draft's subject, not a copied string"
  );
});

// An Invalid market refunds a forecaster's collateral and their winner-reward
// fee, but NOT the 0.3% liquidity fee they paid on the way in (ADR 0026). So a
// refunded forecaster is made slightly less than whole, and the explainer that
// tells them what Invalid means has to say so — otherwise the first they learn
// of it is reconciling their own balance against the contract.
test("the invalid-market explainer says the liquidity fee is not refunded", () => {
  const activity = readFileSync(join(SRC, "views/ActivityView.jsx"), "utf8");
  const explainer = activity.slice(
    activity.indexOf("Why this market is Invalid"),
    activity.indexOf("Why this market is Invalid") + 900
  );
  assert.ok(explainer.length > 40, "the invalid explainer still exists");
  assert.match(
    explainer,
    /liquidity fee/i,
    "the explainer must name the liquidity fee a refunded forecaster does not get back"
  );
});
