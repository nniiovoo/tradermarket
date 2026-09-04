// PROTOTYPE — Three variants of a simple TraderMarket Winner Market page,
// switchable via ?variant=, with local in-memory interactions only.

const variants = {
  A: "Classic market",
  B: "Head-to-head",
  C: "Compact single column",
};

const markets = [
  {
    id: "maya-jin-30",
    a: { name: "Maya Chen", initials: "MC", rating: 1184, return: "+2.84%" },
    b: { name: "Jin Park", initials: "JP", rating: 1129, return: "+1.17%" },
    horizon: "30 minutes",
    source: "Binance × Hyperliquid",
    aPrice: 0.62,
    liquidity: 1840,
    volume: 426,
    countdown: "18:42",
    status: "Forecasting",
  },
  {
    id: "rae-mo-5",
    a: { name: "Rae Silva", initials: "RS", rating: 1088, return: "+0.62%" },
    b: { name: "Mo Ali", initials: "MA", rating: 1103, return: "+0.31%" },
    horizon: "5 minutes",
    source: "Hyperliquid",
    aPrice: 0.48,
    liquidity: 1210,
    volume: 198,
    countdown: "03:11",
    status: "Live",
  },
  {
    id: "alex-noor-60",
    a: { name: "Alex Kim", initials: "AK", rating: 1216, return: "−0.14%" },
    b: { name: "Noor Khan", initials: "NK", rating: 1201, return: "−0.41%" },
    horizon: "60 minutes",
    source: "Binance",
    aPrice: 0.54,
    liquidity: 2640,
    volume: 806,
    countdown: "Complete",
    status: "Final",
  },
];

const appState = {
  page: (location.hash.replace("#", "") || "markets").split("/")[0],
  marketId: "maya-jin-30",
  lifecycle: "forecasting",
  side: "a",
  amount: 25,
  connected: false,
  modal: null,
  notice: "",
};

function currentVariant() {
  const value = new URLSearchParams(location.search).get("variant") || "A";
  return variants[value] ? value : "A";
}

function money(value) {
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function selectedMarket() {
  return markets.find((market) => market.id === appState.marketId) || markets[0];
}

function tradeMath() {
  const market = selectedMarket();
  const price = appState.side === "a" ? market.aPrice : 1 - market.aPrice;
  const amount = Math.max(1, Number(appState.amount) || 1);
  const fee = amount * 0.01;
  const gas = 0.03;
  const positions = (amount - fee) / price;
  return { price, amount, fee, gas, positions, payout: positions, maxLoss: amount + gas };
}

function statusClass(status) {
  if (status === "Live") return "live";
  if (status === "Final") return "final";
  if (status === "Recovering") return "pending";
  return "";
}

function setPage(page) {
  appState.page = page;
  location.hash = page;
  appState.notice = "";
  render();
}

function selectMarket(id) {
  appState.marketId = id;
  const market = selectedMarket();
  appState.lifecycle = market.status === "Live" ? "live" : market.status === "Final" ? "final" : "forecasting";
  appState.page = "market";
  location.hash = `market/${id}`;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function shell(content) {
  const pages = ["markets", "compete", "rankings", "portfolio"];
  return `
    <div class="shell">
      <header class="topbar">
        <button class="brand" data-page="markets"><span class="brand-mark">TM</span>TraderMarket</button>
        <nav class="nav" aria-label="Primary navigation">
          ${pages.map((page) => `<button data-page="${page}" class="${appState.page === page || (page === "markets" && appState.page === "market") ? "active" : ""}">${page[0].toUpperCase() + page.slice(1)}</button>`).join("")}
        </nav>
        <button class="wallet" id="walletButton">${appState.connected ? "0x71…4C2 · 382 USDC" : "Connect wallet"}</button>
      </header>
      <main class="content">${content}</main>
      ${prototypeSwitcher()}
      ${appState.modal ? modal() : ""}
    </div>`;
}

function prototypeSwitcher() {
  const key = currentVariant();
  return `
    <div class="prototype-switcher" aria-label="Prototype variant switcher">
      <button id="variantPrev" aria-label="Previous variant">←</button>
      <div class="prototype-label"><small>THROWAWAY PROTOTYPE</small>${key} — ${variants[key]}</div>
      <button id="variantNext" aria-label="Next variant">→</button>
    </div>`;
}

function renderMarkets() {
  return `
    <div class="page-head">
      <div><h1>Trader markets</h1><p>Forecast which verified trader will finish with the higher return.</p></div>
      <div class="filters"><button class="chip active">All</button><button class="chip">Forecasting</button><button class="chip">Live</button><button class="chip">Final</button></div>
    </div>
    <div class="market-list">
      ${markets.map((market) => `
        <button class="market-row" data-market="${market.id}">
          <div>
            <div class="versus-title"><span class="avatar">${market.a.initials}</span>${market.a.name}<span class="muted">vs</span>${market.b.name}<span class="avatar blue">${market.b.initials}</span></div>
            <div class="micro">${market.horizon} · ${market.source}</div>
          </div>
          <div class="quote">${Math.round(market.aPrice * 100)}¢<small>${market.a.name.split(" ")[0]}</small></div>
          <div class="quote">${Math.round((1 - market.aPrice) * 100)}¢<small>${market.b.name.split(" ")[0]}</small></div>
          <div><div class="quote">${market.countdown}</div><div class="micro">${market.status === "Forecasting" ? "until lock" : "market state"}</div></div>
          <span class="status ${statusClass(market.status)}">${market.status}</span>
        </button>`).join("")}
    </div>`;
}

function stateDemo() {
  const states = ["forecasting", "live", "recovering", "final"];
  return `<div class="state-demo"><strong>Preview state</strong>${states.map((state) => `<button data-state="${state}" class="${appState.lifecycle === state ? "active" : ""}">${state[0].toUpperCase() + state.slice(1)}</button>`).join("")}</div>`;
}

function marketHeader(market) {
  const stateText = {
    forecasting: `Forecasting closes in ${market.countdown}`,
    live: "Live · market locked",
    recovering: "Recovering performance data",
    final: "Final result",
  }[appState.lifecycle];
  return `
    <button class="back" data-page="markets">← All markets</button>
    ${stateDemo()}
    <header class="market-header">
      <div class="eyebrow">${stateText}</div>
      <h1>${market.a.name} vs ${market.b.name}</h1>
      <div class="subline"><span>${market.horizon}</span><span>${market.source}</span><span>Ranked</span><span>Native USDC</span></div>
    </header>`;
}

function probabilityBlock(market) {
  return `
    <div class="card card-pad">
      <div class="probability"><span style="width:${market.aPrice * 100}%"></span></div>
      <div class="probability-labels"><span>${market.a.name.split(" ")[0]} ${Math.round(market.aPrice * 100)}% implied</span><span>${market.b.name.split(" ")[0]} ${Math.round((1 - market.aPrice) * 100)}% implied</span></div>
      <p class="disclosure">Market-implied estimate from AMM pricing and liquidity—not a platform forecast or a vote.</p>
    </div>`;
}

function chartBlock() {
  return `
    <div class="card chart">
      <div class="chart-title"><span>Market-implied probability</span><span class="muted">Last 30 min</span></div>
      <svg viewBox="0 0 640 130" preserveAspectRatio="none" aria-label="Illustrative probability history">
        <defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f7c5a" stop-opacity=".22"/><stop offset="1" stop-color="#2f7c5a" stop-opacity="0"/></linearGradient></defs>
        <path d="M0 105 C70 88 100 96 148 78 S225 72 270 67 S360 58 405 70 S490 42 540 48 S605 29 640 34 L640 130 L0 130 Z" fill="url(#fill)"/>
        <path d="M0 105 C70 88 100 96 148 78 S225 72 270 67 S360 58 405 70 S490 42 540 48 S605 29 640 34" fill="none" stroke="#205f45" stroke-width="3"/>
      </svg>
    </div>`;
}

function comparison(market) {
  return `
    <div class="card card-pad">
      <h3 class="section-title">Trader comparison</h3>
      <div class="compare">
        <div class="compare-side"><div class="big-stat">${market.a.rating}</div><div class="muted tiny">30m rating · 8W 5L</div></div>
        <div class="muted tiny">VS</div>
        <div class="compare-side"><div class="big-stat">${market.b.rating}</div><div class="muted tiny">30m rating · 7W 4L</div></div>
      </div>
    </div>`;
}

function timeline(current = "Forecasting") {
  const steps = ["Forecasting", "Live", "Verify", "Resolve", "Redeem"];
  const index = steps.indexOf(current);
  return `<div class="card card-pad"><h3 class="section-title">Timeline</h3><div class="timeline">${steps.map((step, i) => `<span class="${i < index ? "done" : i === index ? "current" : ""}">${step}</span>`).join("")}</div></div>`;
}

function detailsBlock() {
  return `
    <div class="card card-pad">
      <details><summary>How the winner is determined</summary><p>Both traders begin flat. Net percentage return over the same immutable window determines the winner. Capital flows are neutralized.</p></details>
      <details><summary>Fees and invalid-market rule</summary><p>Purchases include a 1% fee: 75% goes to LPs and 25% becomes a winner-contingent trader Support Reward. Invalid markets follow the published collateral refund path.</p></details>
      <details><summary>Data, oracle, and contracts</summary><p>Performance comes from the frozen Binance and Hyperliquid Source Policies. Resolution uses the configured evidence and challenge process. Contract and evidence links will live here.</p></details>
    </div>`;
}

function tradeTicket(mode = "vertical") {
  const market = selectedMarket();
  const math = tradeMath();
  const trader = appState.side === "a" ? market.a : market.b;
  const sideButtons = `
    <div class="quote-grid">
      <button class="trader-choice a ${appState.side === "a" ? "active" : ""}" data-side="a"><span class="name">${market.a.name}</span><span class="price">${Math.round(market.aPrice * 100)}¢</span><span class="rating">${market.a.rating} rating</span></button>
      <button class="trader-choice b ${appState.side === "b" ? "active" : ""}" data-side="b"><span class="name">${market.b.name}</span><span class="price">${Math.round((1 - market.aPrice) * 100)}¢</span><span class="rating">${market.b.rating} rating</span></button>
    </div>`;
  const amount = `
    <div><label class="field-label" for="amountInput">USDC amount</label><div class="amount-wrap"><input id="amountInput" inputmode="decimal" type="number" min="1" value="${appState.amount}"/><span>USDC</span></div><div class="quick-amounts"><button data-amount="10">10</button><button data-amount="25">25</button><button data-amount="100">100</button></div></div>`;
  const lines = `
    <div class="receipt-lines">
      <div class="receipt-line"><span>Estimated positions</span><strong>${money(math.positions)}</strong></div>
      <div class="receipt-line"><span>1% market fee</span><strong>${money(math.fee)} USDC</strong></div>
      <div class="receipt-line"><span>Network charge</span><strong>~${money(math.gas)} USDC</strong></div>
      <div class="receipt-line"><span>If ${trader.name.split(" ")[0]} wins</span><strong>${money(math.payout)} USDC</strong></div>
      <div class="receipt-line"><span>Maximum loss</span><strong>${money(math.maxLoss)} USDC</strong></div>
    </div>`;
  if (mode === "horizontal") {
    return `<div class="horizontal-ticket card"><h2>Make a forecast</h2><div class="ticket-body"><div>${sideButtons}</div>${amount}<div>${lines}</div><button class="primary" id="reviewButton">Review forecast</button></div><p class="disclosure">No POL required. The separately quoted USDC network charge does not change market collateral or fees.</p></div>`;
  }
  return `<aside class="ticket card"><h2>Make a forecast</h2>${sideButtons}${amount}${lines}<button class="primary" id="reviewButton">Review forecast</button><p class="disclosure">No POL required. Your forecast cannot affect performance, Resolution, or rating.</p></aside>`;
}

function nonForecastState(market) {
  if (appState.lifecycle === "live") {
    return `
      <div class="card state-panel">
        <span class="status live">LIVE · MARKET LOCKED</span>
        <h2>Verified performance is provisional</h2>
        <div class="scoreboard"><div class="score-side"><div>${market.a.name}</div><div class="score">+1.42%</div></div><div class="muted">12:08 left</div><div class="score-side"><div>${market.b.name}</div><div class="score">+0.73%</div></div></div>
        <p class="muted">Latest source update 7 seconds ago. Positions cannot be bought, sold, or transferred during the Round.</p>
      </div>${timeline("Live")}`;
  }
  if (appState.lifecycle === "recovering") {
    return `
      <div class="card state-panel">
        <div class="state-icon">↻</div><h2>Recovering performance data</h2><p class="muted">18:24 remaining in the Performance Recovery Window</p><p>Hyperliquid event backfill is incomplete. No winner is proposed while data is missing.</p>
      </div>${timeline("Verify")}`;
  }
  return `
    <div class="card state-panel final">
      <div class="state-icon">✓</div><h2>${market.a.name} wins</h2><p class="muted">Final verified return · ${market.a.return} vs ${market.b.return}</p>
      <div class="scoreboard"><div class="score-side"><div>${market.a.name}</div><div class="score">${market.a.return}</div><div class="status">+18 rating</div></div><div class="muted">FINAL</div><div class="score-side"><div>${market.b.name}</div><div class="score">${market.b.return}</div><div class="status final">−18 rating</div></div></div>
      <button class="secondary" id="redeemButton">View redemption</button>
    </div>${timeline("Redeem")}`;
}

function variantA(market) {
  return `${marketHeader(market)}<div class="classic-grid"><div class="stack">${probabilityBlock(market)}${appState.lifecycle === "forecasting" ? `${chartBlock()}${comparison(market)}${timeline("Forecasting")}` : nonForecastState(market)}${detailsBlock()}</div>${appState.lifecycle === "forecasting" ? tradeTicket() : `<aside class="card card-pad"><h3 class="section-title">Your position</h3><div class="big-stat">41.92 Maya</div><p class="muted tiny">Cost basis 25.00 USDC · locked</p></aside>`}</div>`;
}

function variantB(market) {
  if (appState.lifecycle !== "forecasting") return `${marketHeader(market)}${nonForecastState(market)}<div style="margin-top:14px">${detailsBlock()}</div>`;
  return `
    ${marketHeader(market)}
    <div class="duel-grid">
      <button class="duel-card card trader-choice a ${appState.side === "a" ? "active" : ""}" data-side="a"><span class="avatar">${market.a.initials}</span><h2>${market.a.name}</h2><span class="rating">${market.a.rating} rating</span><span class="duel-price">${Math.round(market.aPrice * 100)}¢</span><span class="muted tiny">market-implied</span></button>
      <div class="versus-rail"><div><strong>VS</strong><span class="tiny">${market.countdown}<br/>until lock</span></div></div>
      <button class="duel-card card trader-choice b ${appState.side === "b" ? "active" : ""}" data-side="b"><span class="avatar blue">${market.b.initials}</span><h2>${market.b.name}</h2><span class="rating">${market.b.rating} rating</span><span class="duel-price">${Math.round((1 - market.aPrice) * 100)}¢</span><span class="muted tiny">market-implied</span></button>
    </div>
    ${tradeTicket("horizontal")}
    <div style="margin-top:14px" class="stack">${timeline("Forecasting")}${detailsBlock()}</div>`;
}

function variantC(market) {
  return `
    <div class="compact-page">
      ${marketHeader(market)}
      <div class="compact-match card">
        <div class="compact-top"><span>${market.horizon} · Ranked</span><strong>${appState.lifecycle === "forecasting" ? `${market.countdown} to lock` : appState.lifecycle}</strong></div>
        <div class="compact-quotes">
          <button class="compact-quote ${appState.side === "a" ? "active" : ""}" data-side="a"><strong>${market.a.name}</strong><span class="muted tiny">${market.a.rating} rating</span><b>${Math.round(market.aPrice * 100)}¢</b></button>
          <button class="compact-quote ${appState.side === "b" ? "active" : ""}" data-side="b"><strong>${market.b.name}</strong><span class="muted tiny">${market.b.rating} rating</span><b>${Math.round((1 - market.aPrice) * 100)}¢</b></button>
        </div>
      </div>
      <div style="margin-top:12px">${probabilityBlock(market)}</div>
      ${appState.lifecycle === "forecasting" ? `<div class="compact-ticket card">${tradeTicket().replace('<aside class="ticket card">', '').replace('</aside>', '')}</div>` : `<div style="margin-top:12px">${nonForecastState(market)}</div>`}
      <div style="margin-top:12px">${detailsBlock()}</div>
    </div>`;
}

function renderMarket() {
  const market = selectedMarket();
  const variant = currentVariant();
  if (variant === "B") return variantB(market);
  if (variant === "C") return variantC(market);
  return variantA(market);
}

function renderCompete() {
  return `
    <div class="page-head"><div><h1>Compete</h1><p>Create one simple ranked 1v1 competition or invite someone.</p></div></div>
    <div class="form-grid">
      <section class="form-card card"><h2>Create public match</h2><label class="field-label">Horizon</label><select class="select"><option>5 minutes</option><option selected>30 minutes</option><option>60 minutes</option><option>120 minutes</option></select><label class="field-label">Format</label><select class="select"><option>Rated</option><option>Unrated</option></select><p class="disclosure">Offer expires after 30 minutes. Rules become immutable after acceptance.</p><button class="primary" data-action="createOffer">Create offer</button></section>
      <section class="form-card card"><h2>Invite anyone</h2><p class="muted">Share a seven-day onboarding link. It creates no match and moves no funds.</p><label class="field-label">Invitation link</label><div class="amount-wrap"><input readonly value="tradermarket.local/invite/7FQ2"/><span>7 days</span></div><p class="disclosure">After the recipient becomes eligible, you approve their exact profile and create the 30-minute directed offer.</p><button class="primary" data-action="copyInvite">Copy invitation</button></section>
    </div>
    ${appState.notice ? `<div class="notice">${appState.notice}</div>` : ""}`;
}

function renderRankings() {
  const rows = [
    [1, "Alex Kim", 1216, "11–4", "+32"],
    [2, "Maya Chen", 1184, "8–5", "+18"],
    [3, "Jin Park", 1129, "7–4", "+9"],
    [4, "Mo Ali", 1103, "6–6", "−4"],
    [5, "Rae Silva", 1088, "5–5", "+12"],
  ];
  return `
    <div class="page-head"><div><h1>Rankings</h1><p>Season 1 · 12 days remaining · 30-minute Horizon</p></div><div class="filters"><button class="chip">Overall</button><button class="chip">5m</button><button class="chip active">30m</button><button class="chip">60m</button><button class="chip">120m</button></div></div>
    <table class="rank-table"><thead><tr><th>Rank</th><th>Trader</th><th>Rating</th><th>Record</th><th>Season</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="rank">${row[0]}</td><td><strong>${row[1]}</strong></td><td>${row[2]}</td><td>${row[3]}</td><td>${row[4]}</td></tr>`).join("")}</tbody></table>`;
}

function renderPortfolio() {
  return `
    <div class="page-head"><div><h1>Portfolio</h1><p>Your positions, settlements, and competition bonds.</p></div><button class="secondary">382.14 USDC available</button></div>
    <div class="portfolio-grid">
      <section class="portfolio-card card"><span class="status">Forecasting</span><h3>Maya vs Jin</h3><div class="micro">41.92 Maya positions</div><div class="value">41.92 USDC</div><div class="muted tiny">Maximum payout</div></section>
      <section class="portfolio-card card"><span class="status pending">Resolving</span><h3>Rae vs Mo</h3><div class="micro">26.14 Mo positions</div><div class="value">Pending</div><div class="muted tiny">Evidence verification</div></section>
      <section class="portfolio-card card"><span class="status final">Bond</span><h3>Alex vs Noor</h3><div class="micro">Integrity Bond returned</div><div class="value">100.00 USDC</div><div class="muted tiny">Final Resolution</div></section>
    </div>`;
}

function modal() {
  const market = selectedMarket();
  const math = tradeMath();
  const trader = appState.side === "a" ? market.a : market.b;
  if (appState.modal === "confirmed") {
    return `<div class="modal-backdrop"><section class="modal"><span class="status">Prototype receipt</span><h2>Forecast confirmed</h2><p>You acquired <strong>${money(math.positions)} ${trader.name.split(" ")[0]} positions</strong>.</p><div class="receipt-lines"><div class="receipt-line"><span>USDC input</span><strong>${money(math.amount)}</strong></div><div class="receipt-line"><span>Market fee</span><strong>${money(math.fee)}</strong></div><div class="receipt-line"><span>Network charge</span><strong>~${money(math.gas)}</strong></div><div class="receipt-line"><span>Possible redemption</span><strong>${money(math.payout)}</strong></div></div><button class="primary" id="closeModal">Done</button><p class="disclosure">Prototype only—no wallet or blockchain transaction occurred.</p></section></div>`;
  }
  return `<div class="modal-backdrop"><section class="modal"><h2>Review forecast</h2><p><strong>${trader.name} wins</strong> · ${market.horizon}</p><div class="receipt-lines"><div class="receipt-line"><span>USDC input</span><strong>${money(math.amount)}</strong></div><div class="receipt-line"><span>Estimated positions</span><strong>${money(math.positions)}</strong></div><div class="receipt-line"><span>1% market fee</span><strong>${money(math.fee)}</strong></div><div class="receipt-line"><span>Maximum network charge</span><strong>0.05 USDC</strong></div><div class="receipt-line"><span>If correct</span><strong>${money(math.payout)} USDC</strong></div><div class="receipt-line"><span>If incorrect</span><strong>0.00 USDC</strong></div></div><p class="disclosure">The 25% trader share of the market fee is paid only if ${trader.name.split(" ")[0]} is a final Winner. Your forecast cannot change the competition result.</p><div class="modal-actions"><button class="secondary" id="closeModal">Cancel</button><button class="primary" id="confirmForecast">Confirm prototype</button></div></section></div>`;
}

function render() {
  let content = renderMarkets();
  if (appState.page === "market") content = renderMarket();
  if (appState.page === "compete") content = renderCompete();
  if (appState.page === "rankings") content = renderRankings();
  if (appState.page === "portfolio") content = renderPortfolio();
  document.getElementById("app").innerHTML = shell(content);
  bindEvents();
}

function setVariant(offset) {
  const keys = Object.keys(variants);
  const current = keys.indexOf(currentVariant());
  const next = keys[(current + offset + keys.length) % keys.length];
  const url = new URL(location.href);
  url.searchParams.set("variant", next);
  history.replaceState({}, "", url);
  render();
}

function bindEvents() {
  document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
  document.querySelectorAll("[data-market]").forEach((button) => button.addEventListener("click", () => selectMarket(button.dataset.market)));
  document.querySelectorAll("[data-state]").forEach((button) => button.addEventListener("click", () => { appState.lifecycle = button.dataset.state; render(); }));
  document.querySelectorAll("[data-side]").forEach((button) => button.addEventListener("click", () => { appState.side = button.dataset.side; render(); }));
  document.querySelectorAll("[data-amount]").forEach((button) => button.addEventListener("click", () => { appState.amount = Number(button.dataset.amount); render(); }));

  const amountInput = document.getElementById("amountInput");
  if (amountInput) amountInput.addEventListener("change", (event) => { appState.amount = event.target.value; render(); });

  const review = document.getElementById("reviewButton");
  if (review) review.addEventListener("click", () => { appState.modal = "review"; render(); });
  const confirm = document.getElementById("confirmForecast");
  if (confirm) confirm.addEventListener("click", () => { appState.modal = "confirmed"; render(); });
  const close = document.getElementById("closeModal");
  if (close) close.addEventListener("click", () => { appState.modal = null; render(); });
  const redeem = document.getElementById("redeemButton");
  if (redeem) redeem.addEventListener("click", () => { appState.page = "portfolio"; setPage("portfolio"); });

  const wallet = document.getElementById("walletButton");
  if (wallet) wallet.addEventListener("click", () => { appState.connected = !appState.connected; render(); });
  const previous = document.getElementById("variantPrev");
  const next = document.getElementById("variantNext");
  if (previous) previous.addEventListener("click", () => setVariant(-1));
  if (next) next.addEventListener("click", () => setVariant(1));

  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.action === "createOffer") appState.notice = "Prototype offer created. It expires in 30:00 and moves no market funds until readiness completes.";
    if (button.dataset.action === "copyInvite") {
      appState.notice = "Invitation copied. Opening it starts onboarding only; it does not create a competition.";
      try { await navigator.clipboard.writeText("https://tradermarket.local/invite/7FQ2#prototype-secret"); } catch (_) {}
    }
    render();
  }));
}

window.addEventListener("hashchange", () => {
  const [page, id] = location.hash.replace("#", "").split("/");
  if (page) appState.page = page;
  if (id) appState.marketId = id;
  render();
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target.matches("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === "ArrowLeft") setVariant(-1);
  if (event.key === "ArrowRight") setVariant(1);
});

render();
