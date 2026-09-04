import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Droplets,
  Eye,
  History,
  Home,
  Info,
  ExternalLink,
  MessageCircle,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Swords,
  Trophy,
  UserRoundPlus,
  Wallet,
  X,
} from "lucide-react";
import { EXPLORER_URL } from "./web3/config.js";
import { fromUsdc, toUsdc } from "./web3/marketGateway.js";
import { quoteBuy, quoteSell } from "./web3/marketMath.js";
import { useTestnetMarket } from "./web3/useTestnetMarket.js";
import { useLiveRoom } from "./web3/useLiveRoom.js";
import { createApiClient } from "./api/client.js";
import { parseRoute, buildPath, titleFor, onRouteChange, navigate as routeTo } from "./router.js";
import { ActivityView, ActivityDetailView } from "./views/ActivityView.jsx";
import { Differentiators } from "./views/Differentiators.jsx";
import { LiveChat } from "./views/LiveChat.jsx";
import { PortfolioHistory } from "./views/PortfolioHistory.jsx";
import { ReferralsView, SocialProof } from "./views/GrowthViews.jsx";
import { EntryView } from "./views/EntryView.jsx";
import { OracleView, ResolutionEvidence } from "./views/OracleView.jsx";
import { ScheduleView, LeaderboardView, ProfileView, HelpView } from "./views/DiscoveryViews.jsx";
import { useApiResource } from "./hooks/useApiResource.js";
import {
  marketAcceptsLiquidity,
  marketCardPresentation,
  marketIsTradable,
  marketSectionTitle,
} from "./market-state.js";
import { useModal } from "./hooks/useModal.js";
import { resolveStreamSource } from "./stream-source.js";
import {
  GUEST_RACE_MARKET,
  buildReviewableDraft,
  creatorDraftSeed,
  validateCreatorDraft,
} from "./market-drafts.js";

// The four mock markets that used to live here — with invented pools and
// viewer counts — have been removed. The Home grid now renders the configured
// Live Room's real slots, or an honest "no room is configured" state. There is
// no fixture fallback: a market nobody can trade is not a market.

const navItems = [
  { label: "Home", icon: Home, route: "home" },
  { label: "Schedule", icon: Radio, route: "schedule" },
  { label: "Activity", icon: Activity, route: "activity" },
  { label: "Portfolio", icon: Wallet, route: "portfolio" },
  { label: "Leaderboard", icon: Trophy, route: "leaderboard" },
  { label: "Help", icon: CircleDollarSign, route: "help" },
  { label: "Compete", icon: Swords, route: "compete" },
];

// The leaderboard fixture that used to live here has been removed. Rankings now
// come from indexed chain claims through /v1/leaderboard, and show an honest
// empty state until real settlements exist.

function formatMoney(value) {
  // A null is "not read", not zero. Printing $0.00 for an unread pool told
  // every reader an active market was empty.
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 100 ? 2 : 0,
  }).format(value);
}

function Brand() {
  return (
    <div className="brand" aria-label="TraderMarket">
      <div className="brand-mark"><BarChart3 size={19} strokeWidth={2.6} /></div>
      <div>
        <strong>TRADERMARKET</strong>
        <span>LIVE PREDICTION</span>
      </div>
    </div>
  );
}

// Chain names for the networks this build knows by id. Anything else is
// reported by its number rather than given a name it might not deserve.
const CHAIN_NAMES = { 80002: "POLYGON AMOY", 137: "POLYGON", 31337: "LOCAL TEST CHAIN" };

function chainLabel(chainId) {
  if (!chainId) return "NO CHAIN CONFIGURED";
  return CHAIN_NAMES[chainId] ?? `CHAIN ${chainId}`;
}

/** Nav for this deployment: a surface nothing has configured is not shown. */
function navFor(capabilities) {
  const items = [...navItems];
  if (capabilities?.capabilities?.referrals?.available) {
    items.splice(items.length - 1, 0, { label: "Refer", icon: Sparkles, route: "referrals" });
  }
  if (capabilities?.capabilities?.livestream_oracle?.available) {
    items.push({ label: "Resolve", icon: ShieldCheck, route: "oracle" });
  }
  return items;
}

const desktopPrimaryRoutes = new Set(["home", "schedule", "activity", "portfolio", "leaderboard"]);

function AppHeader({ activeView, onNavigate, walletConnected, account, balance, configured, deployed, loading, onConnect, onAddFunds, chainId, capabilities }) {
  const items = navFor(capabilities);
  const primary = items.filter((item) => desktopPrimaryRoutes.has(item.route));
  const secondary = items.filter((item) => !desktopPrimaryRoutes.has(item.route));
  return (
    <header className="app-header">
      <Brand />
      <nav className="desktop-nav" aria-label="Primary navigation">
        {primary.map(({ label, icon: Icon, route }) => (
          <a
            key={label}
            href={buildPath(route)}
            aria-current={activeView === route ? "page" : undefined}
            className={activeView === route ? "nav-item active" : "nav-item"}
            onClick={(event) => {
              event.preventDefault();
              onNavigate?.(route);
            }}
          >
            <Icon size={18} />
            <span>{route === "home" ? "Live rooms" : route === "schedule" ? "Markets" : label}</span>
          </a>
        ))}
      </nav>
      <div className="header-actions">
        <span className={deployed ? "header-network live" : "header-network"}>
          <span /> {chainLabel(chainId)} · {deployed ? "LIVE" : configured ? "CONTRACT UNREACHABLE" : "TESTNET"}
        </span>
        {secondary.length ? (
          <details className="header-more">
            <summary>More</summary>
            <div>
              {secondary.map(({ label, icon: Icon, route }) => (
                <a key={label} href={buildPath(route)} onClick={(event) => { event.preventDefault(); onNavigate?.(route); }}>
                  <Icon size={16} /> {label}
                </a>
              ))}
            </div>
          </details>
        ) : null}
        {walletConnected ? (
          <button className="header-balance" onClick={onAddFunds}>
            <small>Test USDC</small>
            <strong>{loading ? "Reading…" : balance === null || balance === undefined ? "—" : formatMoney(balance)}</strong>
          </button>
        ) : null}
        <button className="connect-button" onClick={onConnect}>
          <Wallet size={16} />
          {walletConnected ? `${account.slice(0, 5)}…${account.slice(-4)}` : "Connect"}
        </button>
      </div>
    </header>
  );
}

function StreamPlayer({ market }) {
  const [playing, setPlaying] = useState(false);
  const source = resolveStreamSource(market.streamUrl, {
    parentHost: typeof window === "undefined" ? "" : window.location.hostname,
  });
  const hasStream = Boolean(source?.watchUrl);
  const canEmbed = Boolean(source?.embedUrl);
  const streamHealth = market.streamHealth ?? "unknown";

  useEffect(() => setPlaying(false), [market.streamUrl]);

  return (
    <div className="stream-player">
      {playing && canEmbed ? (
        <iframe
          className="stream-embed"
          src={source.embedUrl}
          title={`${market.title} livestream`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen
        />
      ) : (
        // A decorative still, not a frame of any broadcast. Saying "preview"
        // in the alt text tells a screen-reader user this is the stream.
        market.image ? <img src={market.image} alt="" role="presentation" /> : null
      )}
      {!playing ? <div className="stream-shade" /> : null}
      <div className="stream-topline">
        {/* Only over an actual stream. Over a still image on a settled market
            this badge claims a broadcast that is not happening. */}
        {hasStream && streamHealth === "live" ? <span className="live-badge"><Radio size={12} /> LIVE</span> : null}
        {hasStream ? <span className="provider-badge">{source.label}</span> : null}
        {market.viewers ? <span className="viewer-badge"><Eye size={13} /> {market.viewers}</span> : null}
      </div>
      {!playing ? <div className="stream-copy">
        <span>{market.category}</span>
        <h2>{market.title}</h2>
      </div> : null}
      {!playing && canEmbed && <button className="play-button" onClick={() => setPlaying(true)} aria-label={`Watch on ${source.label}`}><Play size={24} fill="currentColor" /></button>}
      {!hasStream && (
        <div className="stream-placeholder">
          <Radio size={24} />
          <strong>No stream for this question</strong>
          <span>The stream is context only. Markets settle from approved source data, so a question resolves whether or not anyone is watching.</span>
        </div>
      )}
      {hasStream && !canEmbed ? (
        <div className="stream-placeholder">
          <Radio size={24} />
          <strong>{source.label} opens separately</strong>
          <span>{source.reason}</span>
          <a className="stream-external" href={source.watchUrl} target="_blank" rel="noreferrer">Open stream <ExternalLink size={14} /></a>
        </div>
      ) : null}
      {playing ? (
        <div className="stream-controls">
          <a href={source.watchUrl} target="_blank" rel="noreferrer">Open on {source.label} <ExternalLink size={13} /></a>
          <button onClick={() => setPlaying(false)}>Close stream</button>
        </div>
      ) : null}
    </div>
  );
}

function ProbabilityBar({ market }) {
  // No price to draw. Drawing a bar anyway meant `width: NaN%` and a percentage
  // the chain never quoted. Which sentence is true depends on *why* there is no
  // price: settlement drains the reserves and the LP shares, so telling the
  // reader of a resolved market that "a price appears once the first liquidity
  // is supplied" invites them to wait for one that is never coming.
  if (market.yes === null || market.yes === undefined) {
    const resolved = Number(market.finalOutcome ?? 0) !== 0 || ["final", "invalid"].includes(market.state);
    return (
      <div className="probability-block">
        <p className="muted-note">
          {resolved
            ? "This market has settled, so it no longer carries a price. The result and every payout are in its settlement record."
            : "No cleared price yet. A price appears once the first liquidity is supplied and the source clears an epoch."}
        </p>
      </div>
    );
  }
  return (
    <div className="probability-block">
      <div className="probability-meta">
        <span><strong>{market.yes}%</strong> YES</span>
        <span><strong>{market.no}%</strong> NO</span>
      </div>
      <div className="probability-track" aria-label={`${market.yes}% yes, ${market.no}% no`}>
        <span className="yes-fill" style={{ width: `${market.yes}%` }} />
        <span className="no-fill" style={{ width: `${market.no}%` }} />
      </div>
    </div>
  );
}

function MarketPanel({ market, onTrade, onLiquidity, onChallenge, deployed }) {
  const tradable = marketIsTradable(market);
  const acceptsLiquidity = marketAcceptsLiquidity(market);
  // No cleared price means no quote. The fallback estimate would otherwise
  // offer 0 positions for a real deposit.
  const priced = market.yes !== null && market.yes !== undefined;
  // Failing closed on tradability is right, but the reason matters: a question
  // awaiting its first liquidity has not closed, and a suspended one reopens.
  const notYetOpen = ["announced", "awaiting-liquidity"].includes(market.state);
  const paused = market.state === "suspended" || market.state === "recovering" || market.gateState === 1;
  return (
    <section className="market-panel">
      <div className="market-kicker">
        <span className={tradable ? "market-open" : "market-open closed"}>
          <span /> {market.gateLabel || (tradable ? "MARKET OPEN" : "FORECASTING CLOSED")}
        </span>
        <span>{market.liveLabel}</span>
      </div>
      <h1>{market.question}</h1>
      <div className="market-context">
        <Clock3 size={15} />
        <span>{market.duration}</span>
      </div>
      {market.canChallenge && (
        <div className="resolution-alert"><Info size={15} /><span><strong>Provisional result posted</strong><small>Challenge with objective evidence before the window closes.</small></span><button onClick={onChallenge}>Review</button></div>
      )}
      <ProbabilityBar market={market} />
      {tradable ? (
        <div className="outcome-buttons">
          <button className="outcome yes" onClick={() => onTrade("YES")} disabled={!priced || !deployed}>
            <span><strong>YES</strong><small>{!deployed ? "contract unavailable" : market.yes === null || market.yes === undefined ? "no price yet" : `${market.yes}¢ per position`}</small></span>
            <ArrowRight size={18} />
          </button>
          <button className="outcome no" onClick={() => onTrade("NO")} disabled={!priced || !deployed}>
            <span><strong>NO</strong><small>{!deployed ? "contract unavailable" : market.no === null || market.no === undefined ? "no price yet" : `${market.no}¢ per position`}</small></span>
            <ArrowRight size={18} />
          </button>
        </div>
      ) : (
        <div className="closed-note" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <div>
            <strong>
              {notYetOpen
                ? "This question is not open yet"
                : paused
                  ? "Trading is paused on this question"
                  : "Forecasting is closed on this question"}
            </strong>
            <p>
              {notYetOpen
                ? "It accepts positions once it opens and its first liquidity is supplied. Nothing can be traded before then."
                : paused
                  ? "The Market Gate has suspended trading while an important event is unconfirmed. It reopens on its own once the source catches up; positions you already hold are unaffected."
                  : "No new positions can be taken. If you hold one, redeem it from your portfolio — and if the market resolved Invalid, your collateral is returned there instead."}
            </p>
            {market.market ? (
              <a className="inline-link" href={buildPath("activityDetail", { market: market.market })}>
                See how this settled
              </a>
            ) : null}
          </div>
        </div>
      )}
      <div className="pool-row">
        <span><Droplets size={15} /> {market.pool === null || market.pool === undefined ? "Liquidity not read" : `${formatMoney(market.pool)} liquidity`}</span>
        {acceptsLiquidity ? <button onClick={onLiquidity} disabled={!deployed}>Add liquidity</button> : null}
      </div>
      <div className="verified-row">
        <ShieldCheck size={16} />
        <span>Objective result · Circle test USDC · {deployed ? "self-paid test POL" : "market contract unavailable"}</span>
      </div>
    </section>
  );
}

function MarketCard({ market, active, onSelect }) {
  const presentation = marketCardPresentation(market);
  const streamSource = resolveStreamSource(market.streamUrl);
  const streamIsLive = Boolean(streamSource?.embeddable && market.streamHealth === "live");
  return (
    <button className={active ? "market-card active" : "market-card"} onClick={onSelect}>
      <div className="card-image">
        {market.image ? <img src={market.image} alt="" /> : null}
        {/* Only where there is a stream. Room cards map every slot, including
            settled ones, so an unguarded badge advertised LIVE on a question
            that closed hours ago. */}
        {streamIsLive ? (
          <span className="live-badge"><Radio size={11} /> LIVE</span>
        ) : streamSource ? <span className="card-provider">{streamSource.label}</span> : null}
        {market.viewers ? <span className="card-viewers"><Eye size={12} /> {market.viewers}</span> : null}
      </div>
      <div className="card-body">
        <span className="card-category">{presentation.category}</span>
        <h3>{market.question}</h3>
        <ProbabilityBar market={market} />
        <div className="card-footer">
          {market.pool === null || market.pool === undefined ? null : <span>{formatMoney(market.pool)} pool</span>}
          <span>{presentation.action} <ChevronRight size={14} /></span>
        </div>
      </div>
    </button>
  );
}

const HEALTH_COPY = {
  stream: {
    live: ["ok", "Livestream live"],
    degraded: ["warn", "Livestream degraded"],
    unavailable: ["bad", "Livestream unavailable"],
    unknown: ["warn", "Livestream status unknown"],
  },
  source: {
    fresh: ["ok", "Score feed fresh"],
    stale: ["bad", "Market suspended — score feed delayed"],
    unknown: ["warn", "Score feed status unknown"],
  },
  indexer: {
    current: ["ok", "Chain data current"],
    delayed: ["bad", "Chain data behind — figures below may be stale"],
    unknown: ["warn", "Chain data status unknown"],
  },
  connection: {
    live: ["ok", "Live updates connected"],
    polling: ["warn", "Live updates unavailable — polling"],
    disconnected: ["warn", "Connection lost — reconnecting"],
    fallback: ["warn", "Live updates unavailable — reading the contract directly"],
  },
};

/**
 * Four independent signals, never merged.
 *
 * A lost connection is not a suspended market, a broken livestream is neither,
 * and — the one that used to be missing — an indexer behind the chain is not a
 * quiet room. Dropping that signal made a stalled indexer look identical to a
 * healthy one: green pills and a block number read as the chain's head, while
 * every figure on the page came from a projection that had stopped advancing.
 */
function HealthStrip({ room, directContract }) {
  const stream = HEALTH_COPY.stream[room.health?.stream ?? "unknown"] ?? HEALTH_COPY.stream.unknown;
  const source = HEALTH_COPY.source[room.health?.source ?? "unknown"] ?? HEALTH_COPY.source.unknown;
  const indexer = HEALTH_COPY.indexer[room.health?.indexer ?? "unknown"] ?? HEALTH_COPY.indexer.unknown;
  const connection = room.mode === "fallback" && !directContract
    ? ["bad", "Room API unavailable — no direct market read"]
    : HEALTH_COPY.connection[room.mode === "live" ? "live" : room.mode] ?? HEALTH_COPY.connection.polling;
  return (
    // Polite, not assertive: a source going delayed matters, but interrupting
    // someone mid-sentence to say so does not help them.
    <div className="health-strip">
      <div className="health-statuses" role="status" aria-live="polite">
        {[stream, source, indexer, connection].map(([tone, label]) => (
          <span key={label} className={`health-pill ${tone}`}>
            <span className="health-dot" aria-hidden="true" /> {label}
          </span>
        ))}
      </div>
      {room.snapshot?.source?.last_seq ? <span className="health-meta">source seq {room.snapshot.source.last_seq}</span> : null}
      {/* The block the INDEXER has reached, which is not the chain's head when
          the indexer is behind — labelling it "block" invited exactly that
          reading. */}
      {room.snapshot?.chain?.block ? (
        <span className="health-meta">indexed block {room.snapshot.chain.block}</span>
      ) : null}
    </div>
  );
}

const SLOT_STATE_LABEL = {
  announced: "Opens shortly",
  "awaiting-liquidity": "Awaiting liquidity",
  open: "Open",
  suspended: "Suspended",
  closed: "Forecasting closed",
  recovering: "Recovering data",
  provisional: "Provisional",
  challenged: "Challenged",
  final: "Final",
  invalid: "Invalid",
};

/** The rolling program: current, upcoming, and recently resolved questions. */
function QuestionStrip({ slots, focusIndex, onSelect }) {
  if (!slots.length) return null;
  return (
    // Plain buttons rather than a tablist. role="tablist" promises arrow-key
    // navigation between tabs, and promising an interaction that is not
    // implemented is worse for a keyboard user than not claiming it.
    <div className="question-strip" role="group" aria-label="Room questions">
      {slots.map((slot) => (
        <button
          key={slot.slot_index}
          type="button"
          aria-current={slot.slot_index === focusIndex ? "true" : undefined}
          className={slot.slot_index === focusIndex ? "question-chip active" : "question-chip"}
          onClick={() => onSelect(slot)}
        >
          <span className="question-chip-state">{SLOT_STATE_LABEL[slot.state] ?? slot.state}</span>
          <span className="question-chip-text">{slot.question}</span>
          {slot.price ? (
            <span className="question-chip-price">
              {Math.round(Number(slot.price.implied_prob_a) / 10000)}¢
              <small>block {slot.price.block}</small>
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function PreparedEventMarket({ onReview }) {
  const draft = GUEST_RACE_MARKET;
  const [outcome, setOutcome] = useState("A");
  const [amount, setAmount] = useState(25);
  const outcomeLabel = outcome === "A" ? draft.outcomeA : draft.outcomeB;
  const streamMarket = {
    title: draft.subject,
    category: "Prepared event market",
    streamUrl: draft.streamUrl,
    streamHealth: "unknown",
    image: null,
  };
  return (
    <section className="prepared-stage" aria-labelledby="prepared-market-title">
      <div className="prepared-live-pane">
        <StreamPlayer market={streamMarket} />
      </div>
      <div className="prepared-market-dock">
        <div className="prepared-market-copy">
          <span className="prepared-status"><Radio size={13} /> LIVE EVENT MARKET</span>
          <h2 id="prepared-market-title">{draft.question}</h2>
          <p>
            The exact official broadcast must be frozen before trading opens. The market uses a timestamped evidence
            file approved by independent resolvers—not chat votes or an automatic transcript.
          </p>
        </div>
        <div className="prepared-betting">
          <span className="prepared-bet-label">CHOOSE AN OUTCOME</span>
          <div className="prepared-outcomes" aria-label="Prepared market outcomes">
            <button className={outcome === "A" ? "yes selected" : "yes"} type="button" aria-pressed={outcome === "A"} onClick={() => setOutcome("A")}>
              <span><strong>{draft.outcomeA}</strong></span>
              <small>Awaiting price</small>
            </button>
            <button className={outcome === "B" ? "no selected" : "no"} type="button" aria-pressed={outcome === "B"} onClick={() => setOutcome("B")}>
              <span><strong>{draft.outcomeB}</strong></span>
              <small>Awaiting price</small>
            </button>
          </div>
        </div>
        <div className="prepared-order">
          <div className="prepared-order-heading"><span>AMOUNT (USDC)</span><small>Testnet only</small></div>
          <div className="prepared-amounts" role="group" aria-label="Prediction amount">
            {[5, 25, 50, 100].map((value) => (
              <button key={value} type="button" aria-pressed={amount === value} className={amount === value ? "selected" : ""} onClick={() => setAmount(value)}>
                ${value}
              </button>
            ))}
          </div>
          <button type="button" className="primary-button prepared-submit" disabled>
            Market not open
          </button>
          <div className="prepared-order-meta"><span>0.3% LP fee</span><button type="button" onClick={() => onReview(draft)}>View market rules</button></div>
        </div>
      </div>
      <div className="prepared-evidence-ribbon" id="prepared-bet-status">
        <span><ShieldCheck size={14} /> PREPARED · NOT OPEN</span>
        <span>Selected: {outcomeLabel} · ${amount} test USDC</span>
        <span>Trading unlocks after the exact livestream, contract, and first liquidity are confirmed.</span>
      </div>
    </section>
  );
}

function HomeView({ market, onSelectMarket, onTrade, onLiquidity, onChallenge, deployed, room, onSelectSlot, capabilities, client, account, onSignChat, onPrepareMarket }) {
  return (
    <main className="page home-view">
      <PreparedEventMarket onReview={onPrepareMarket} />
      {room?.configured ? <HealthStrip room={room} directContract={deployed} /> : null}
      {room?.deniedCopy ? <div className="denied-banner">{room.deniedCopy}</div> : null}
      {room?.slots?.length ? (
        <QuestionStrip slots={room.slots} focusIndex={room.snapshot?.program?.focus} onSelect={onSelectSlot} />
      ) : null}
      {market ? (
        <>
          <section className="spotlight">
            <StreamPlayer market={market} />
            <MarketPanel market={market} onTrade={onTrade} onLiquidity={onLiquidity} onChallenge={onChallenge} deployed={deployed} />
          </section>
          <ResolutionEvidence client={client} market={market} />
        </>
      ) : null}
      <section className="live-section">
        <div className="section-heading">
          <div><Radio size={19} /><h2>{marketSectionTitle(room?.roomCards ?? (market ? [market] : []))}</h2></div>
          <a className="text-button" href={buildPath("schedule")}>View all <ArrowRight size={15} /></a>
        </div>
        {market && !room?.roomCards?.length ? (
          // A standalone deployment: one market contract, no Live Room. The
          // spotlight above is that market; there is no grid to draw.
          <p className="muted-note">
            This build is configured with a single market contract rather than a Live Room, so there is one question
            here rather than a rolling programme.
          </p>
        ) : room?.roomCards?.length ? (
          <div className="market-grid">
            {room.roomCards.map((item) => (
              <MarketCard key={item.id} market={item} active={item.id === market?.id} onSelect={() => onSelectMarket(item)} />
            ))}
          </div>
        ) : (
          // No fixtures here on purpose. Three different situations, three
          // different messages: not configured; configured but with no snapshot
          // yet, meaning the room cannot be seen; and reachable with nothing
          // open. Collapsing the middle case into the last would report the
          // room's state while unable to observe it. The snapshot is the honest
          // test — the SSE connection label can read "disconnected" while HTTP
          // polling still works fine.
          <div className="empty-card">
            <Radio size={30} />
            <h2>
              {!room?.configured
                ? "No live room is configured"
                : !room.snapshot
                  ? "The room cannot be reached"
                  : "No question is open right now"}
            </h2>
            <p>
              {!room?.configured
                ? "This build is not connected to a Live Room. When one is configured, its real questions, prices and states appear here — nothing is shown before it exists on chain."
                : !room.snapshot
                  ? "The room API is not answering, so this page cannot say what is open. Nothing here is out of date on purpose — it is simply unknown until the connection returns."
                  : "This room has no open slot at the moment. Published questions appear here as soon as the room opens them."}
            </p>
            {room?.configured && !room?.snapshot ? (
              <button type="button" className="secondary-button" onClick={() => room.refresh?.()}>
                Try again
              </button>
            ) : (
              <a className="secondary-button" href={buildPath("schedule")}>See the schedule</a>
            )}
          </div>
        )}
      </section>
      <Differentiators />
      <SocialProof client={client} />
      <section className="below-grid">
        <LiveChat
          client={client}
          roomId={room?.snapshot?.room ?? null}
          account={account}
          capabilities={capabilities}
          onSign={onSignChat}
          viewers={room?.snapshot?.viewers?.measured ? room.snapshot.viewers.count : null}
        />
        <section className="how-panel">
          <span className="eyebrow"><CircleDollarSign size={15} /> SIMPLE BY DESIGN</span>
          <h2>One price. One verified result.</h2>
          <ol>
            <li><span>1</span><div><strong>Choose YES or NO</strong><small>The price reflects the market's probability.</small></div></li>
            <li><span>2</span><div><strong>Follow the livestream</strong><small>The source gate can pause trading when an important event is unconfirmed.</small></div></li>
            <li><span>3</span><div><strong>Winning positions pay $1</strong><small>Settlement comes from approved event data, not the video itself.</small></div></li>
          </ol>
        </section>
      </section>
    </main>
  );
}

function EmptyView({ activeView, onHome, onLiquidity, portfolio, deployed, walletConnected, onClaim, onSell, participantState, onPostBond, onStartDraft, client, account }) {
  if (activeView === "compete") {
    return (
      <main className="page secondary-view">
        <div className="view-title"><span className="eyebrow"><Swords size={15} /> PARTICIPANTS</span><h1>Bring a competition live.</h1><p>Create an objective contest, invite anyone, and let the audience predict alongside it.</p></div>
        <div className="feature-card compete-card">
          <div className="feature-icon"><UserRoundPlus size={25} /></div>
          <div><span>Invite anyone</span><h2>Create a live competition</h2><p>Define the participants, objective winner rule, approved data source, and live stream. The market opens after its first liquidity is supplied.</p></div>
          <button className="primary-button" onClick={onStartDraft}>Start a draft <ArrowRight size={16} /></button>
        </div>
        {participantState?.eligible && (
          <div className="participant-bond-card">
            <div><ShieldCheck size={22} /><span><strong>Participant integrity bond</strong><small>{participantState.posted ? "Your 100 test-USDC bond is posted." : "Post 100 test USDC before the competition begins."}</small></span></div>
            <button className="secondary-button" disabled={participantState.posted} onClick={onPostBond}>{participantState.posted ? "Bond posted" : "Post test-USDC bond"}</button>
          </div>
        )}
      </main>
    );
  }

  if (activeView === "portfolio") {
    const hasPosition = portfolio && (portfolio.positionA > 0 || portfolio.positionB > 0 || portfolio.lpShares > 0 || portfolio.lpFees > 0 || portfolio.integrityBond > 0 || portfolio.winnerRewardEligible || portfolio.winnerFeePaid > 0);
    return (
      <main className="page secondary-view">
        <div className="view-title">
          {/* There is no demo account any more, so nothing here should be
              labelled as one. Either a market contract is configured or it is
              not, and the history below reads chain facts either way. */}
          <span className="eyebrow"><Wallet size={15} /> {deployed ? "YOUR ACCOUNT" : "NO MARKET CONTRACT CONFIGURED"}</span>
          <h1>Portfolio</h1>
          <p>Outcome Positions, LP ownership, and claimable fees remain separate and transparent.</p>
        </div>
        {!walletConnected || !hasPosition ? (
          <div className="empty-card"><Wallet size={30} /><h2>{walletConnected ? "No positions yet" : "Connect your wallet"}</h2><p>{walletConnected ? "Choose a live market and make your first prediction." : "Your live testnet balances and claims will appear here."}</p><button className="primary-button" onClick={onHome}>Explore live markets</button></div>
        ) : (
          <div className="portfolio-panel">
            <div><span>Test USDC</span><strong>{formatMoney(portfolio.usdc)}</strong></div>
            <div><span>YES positions</span><strong>{portfolio.positionA.toFixed(2)}</strong></div>
            <div><span>NO positions</span><strong>{portfolio.positionB.toFixed(2)}</strong></div>
            <div><span>LP shares</span><strong>{portfolio.lpShares.toFixed(2)}</strong></div>
            <div><span>Recorded LP fees</span><strong>{formatMoney(portfolio.lpFees)}</strong></div>
            {portfolio.integrityBond > 0 && <div><span>Integrity bond</span><strong>{formatMoney(portfolio.integrityBond)}</strong></div>}
            {portfolio.winnerRewardEligible && <div><span>Winner reward pool</span><strong>{formatMoney(portfolio.winnerRewardPool)}</strong></div>}
            <div className="portfolio-actions">
              {portfolio.finalOutcome === 0 && portfolio.positionA > 0 && <button className="secondary-button" onClick={() => onSell("YES")}>Sell YES</button>}
              {portfolio.finalOutcome === 0 && portfolio.positionB > 0 && <button className="secondary-button" onClick={() => onSell("NO")}>Sell NO</button>}
              {portfolio.finalOutcome > 0 && (portfolio.positionA > 0 || portfolio.positionB > 0) && <button className="secondary-button" onClick={() => onClaim("redeemPositions")}>Redeem positions</button>}
              {(portfolio.lpShares > 0 || portfolio.lpFees > 0) && <button className="secondary-button" onClick={() => onClaim("claimLpFees")}>Claim LP fees</button>}
              {portfolio.finalOutcome > 0 && portfolio.lpShares > 0 && <button className="secondary-button" onClick={() => onClaim("settleLpInventory")}>Settle LP inventory</button>}
              {portfolio.winnerRewardEligible && portfolio.winnerRewardPool > 0 && <button className="secondary-button" onClick={() => onClaim("claimWinnerReward")}>Claim winner reward</button>}
              {portfolio.finalOutcome === 4 && portfolio.winnerFeePaid > 0 && <button className="secondary-button" onClick={() => onClaim("claimInvalidWinnerFeeRefund")}>Refund winner fee</button>}
              {portfolio.finalOutcome > 0 && portfolio.integrityBond > 0 && <button className="secondary-button" onClick={() => onClaim("claimIntegrityBond")}>Claim integrity bond</button>}
            </div>
          </div>
        )}
        {walletConnected && account ? (
          <>
            <div className="section-heading">
              <div><History size={18} /> <h2>Your history</h2></div>
            </div>
            <PortfolioHistory client={client} account={account} />
          </>
        ) : null}
      </main>
    );
  }

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow"><Activity size={15} /> LIVE FEED</span>
        <h1>{activeView}</h1>
        <p>Settled markets, the source facts behind each result, and every payout are recorded in Market Activity.</p>
      </div>
      <a className="primary-button" href={buildPath("activity")}>Open Market Activity</a>
      <button className="secondary-button" onClick={onLiquidity}><Droplets size={16} /> Explore LP opportunities</button>
    </main>
  );
}

function TradeSheet({ market, outcome, onClose, walletConnected, onConnect, onSubmit, deployed }) {
  const dialogRef = useModal(onClose);
  const [amount, setAmount] = useState(25);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [transactionUrl, setTransactionUrl] = useState("");
  const priced = market.yes !== null && market.yes !== undefined && market.no !== null && market.no !== undefined;
  const price = priced ? (outcome === "YES" ? market.yes / 100 : market.no / 100) : null;
  /**
   * The order summary, or nothing.
   *
   * There is exactly one source for these numbers: the market's own reserves
   * through the same constant-product maths the contract runs. The previous
   * fallback modelled a constant price, a flat 1% fee and zero slippage, and on
   * any room-only build that path ran for every trade — producing a complete
   * order summary, down to "Estimated profit", for a market this build cannot
   * quote at all. An estimate nobody can check is the thing this product exists
   * not to print.
   */
  const calculations = useMemo(() => {
    const safeAmount = Number.isFinite(Number(amount)) ? Math.max(0, Number(amount)) : 0;
    const quotable =
      market.reserveA > 0n &&
      market.reserveB > 0n &&
      market.winnerRewardBps !== null &&
      market.winnerRewardBps !== undefined;
    if (!quotable) return null;
    try {
      const quote = quoteBuy(
        market.reserveA,
        market.reserveB,
        outcome === "YES",
        fromUsdc(safeAmount),
        market.winnerRewardBps
      );
      const positions = toUsdc(quote.positionsOut);
      const tradeAmount = toUsdc(quote.tradeInput);
      const averagePrice = positions > 0 ? tradeAmount / positions : 0;
      return {
        safeAmount,
        winnerFee: toUsdc(quote.winnerRewardFee),
        lpFee: toUsdc(quote.liquidityFee),
        tradeAmount,
        positions,
        payout: positions,
        profit: positions - safeAmount,
        priceImpact: price > 0 ? Math.max(0, ((averagePrice - price) / price) * 100) : 0,
        maxLoss: safeAmount,
        rewardBps: Number(market.winnerRewardBps),
      };
    } catch {
      // Mid-edit decimal, or reserves that moved under us.
      return null;
    }
  }, [amount, market.reserveA, market.reserveB, market.winnerRewardBps, outcome, price]);

  const submit = async () => {
    if (!walletConnected) {
      try {
        await onConnect();
      } catch (cause) {
        setError(cause?.message || "Wallet connection failed.");
      }
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const result = await onSubmit(outcome, calculations.safeAmount);
      setTransactionUrl(result?.url || "");
      setSubmitted(true);
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "The prediction could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet" role="dialog" aria-modal="true" aria-label="Place prediction" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        {!priced || calculations === null ? (
          <div className="closed-note" role="note">
            <ShieldCheck size={16} aria-hidden="true" />
            <div>
              <strong>{priced ? "This market cannot be quoted here" : "This market has no price yet"}</strong>
              <p>
                {priced
                  ? "Quoting needs the market's own reserves and fee rate, which this build has not read. Rather than model a price, it shows nothing — an estimate you cannot check is worse than no estimate."
                  : "A price appears once the first liquidity is supplied and the source clears an epoch. Until then there is nothing to quote, and an estimate here would be invented."}
              </p>
            </div>
          </div>
        ) : submitted ? (
          <div className="success-state" role="status">
            <div className="success-icon"><Check size={28} /></div>
            <span className="eyebrow">PREDICTION QUEUED</span>
            <h2>You're backing {outcome}.</h2>
            <p>{deployed ? "Your transaction is on chain and will clear only after the live source marks its epoch safe." : "No market contract is configured in this build, so nothing was submitted."}</p>
            <div className="receipt"><span>{calculations.positions.toFixed(2)} positions</span><strong>{formatMoney(calculations.payout)} if correct</strong></div>
            {transactionUrl && <a className="transaction-link" href={transactionUrl} target="_blank" rel="noreferrer">View on PolygonScan <ArrowRight size={14} /></a>}
            <button className="primary-button full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <span className="sheet-kicker">{market.category} · {market.liveLabel}</span>
            <h2>{market.question}</h2>
            <div className={`selected-outcome ${outcome.toLowerCase()}`}><span>{outcome}</span><strong>{Math.round(price * 100)}¢</strong></div>
            <label className="amount-field">
              <span>USDC amount</span>
              <div><span>$</span><input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            </label>
            <div className="amount-presets">
              {[5, 10, 25, 100].map((value) => <button key={value} className={Number(amount) === value ? "active" : ""} onClick={() => setAmount(value)}>${value}</button>)}
            </div>
            <div className="order-summary">
              <div><span>Market input</span><strong>{formatMoney(calculations.tradeAmount)}</strong></div>
              <div>
                <span>Winning participant reward · {(calculations.rewardBps / 100).toFixed(calculations.rewardBps % 100 === 0 ? 0 : 2)}%</span>
                <strong>{formatMoney(calculations.winnerFee)}</strong>
              </div>
              <div><span>LP trading fee · 0.3%</span><strong>{formatMoney(calculations.lpFee)}</strong></div>
              <div><span>Estimated price impact</span><strong>{calculations.priceImpact.toFixed(2)}%</strong></div>
              <div><span>Maximum loss</span><strong>{formatMoney(calculations.maxLoss)}</strong></div>
              <div className="summary-total"><span>Estimated payout if correct</span><strong>{formatMoney(calculations.payout)}</strong></div>
              <div><span>Estimated profit</span><strong className={calculations.profit >= 0 ? "positive" : "negative"}>{formatMoney(calculations.profit)}</strong></div>
            </div>
            <div className="source-note"><ShieldCheck size={17} /><span>The stream is for context. Approved event data determines the result.</span></div>
            {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
            <button className={`confirm-button ${outcome.toLowerCase()}`} disabled={calculations.safeAmount < 1 || submitting} onClick={submit}>
              {submitting ? "Waiting for wallet…" : walletConnected ? `Confirm ${outcome} prediction` : "Connect wallet to continue"}
              <ArrowRight size={17} />
            </button>
            <p className="gas-note">Paid in Circle test USDC. This build uses self-paid test POL until a paymaster policy is configured.</p>
          </>
        )}
      </section>
    </div>
  );
}

function SellSheet({ market, outcome, available, onClose, onSubmit }) {
  const dialogRef = useModal(onClose);
  const [amount, setAmount] = useState(Math.min(25, available));
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [transactionUrl, setTransactionUrl] = useState("");
  // The real curve, or nothing. Returning zeroes on a failed quote printed
  // "Gross pool output $0.00 / Estimated USDC received $0.00" for a market
  // whose reserves this build never read.
  const calculations = useMemo(() => {
    const safeAmount = Math.min(available, Math.max(0, Number(amount) || 0));
    if (!(market.reserveA > 0n && market.reserveB > 0n)) return null;
    try {
      const quote = quoteSell(market.reserveA, market.reserveB, outcome === "YES", fromUsdc(safeAmount));
      return {
        safeAmount,
        gross: toUsdc(quote.grossCollateral),
        fee: toUsdc(quote.liquidityFee),
        output: toUsdc(quote.collateralOut),
      };
    } catch {
      return null;
    }
  }, [amount, available, market.reserveA, market.reserveB, outcome]);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const result = await onSubmit(outcome, calculations.safeAmount);
      setTransactionUrl(result?.url || "");
      setSubmitted(true);
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "The sale could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet" role="dialog" aria-modal="true" aria-label="Sell outcome positions" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        {calculations === null ? (
          <div className="closed-note" role="note">
            <ShieldCheck size={16} aria-hidden="true" />
            <div>
              <strong>This market cannot be quoted here</strong>
              <p>
                Selling is priced from the market's own reserves, which this build has not read. Rather than show an
                estimate you cannot check, it shows none.
              </p>
            </div>
          </div>
        ) : submitted ? (
          <div className="success-state" role="status">
            <div className="success-icon"><Check size={28} /></div>
            <span className="eyebrow">SALE QUEUED</span>
            <h2>Your {outcome} sale is pending.</h2>
            <p>The positions remain escrowed until the live source clears this Forecasting Epoch.</p>
            {transactionUrl && <a className="transaction-link" href={transactionUrl} target="_blank" rel="noreferrer">View on PolygonScan <ArrowRight size={14} /></a>}
            <button className="primary-button full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <span className="sheet-kicker">EXIT BEFORE RESOLUTION</span>
            <h2>Sell {outcome} positions</h2>
            <p className="sheet-description">You have {available.toFixed(2)} {outcome} positions. The final USDC output is protected by 1% slippage and can change while this action waits for source clearance.</p>
            <label className="amount-field">
              <span>Positions to sell</span>
              <div><input type="number" min="0.01" max={available} value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            </label>
            <div className="amount-presets">
              {[25, 50, 100].map((percent) => <button key={percent} onClick={() => setAmount(available * percent / 100)}>{percent}%</button>)}
            </div>
            <div className="order-summary">
              <div><span>Gross pool output</span><strong>{formatMoney(calculations.gross)}</strong></div>
              <div><span>LP trading fee · 0.3%</span><strong>{formatMoney(calculations.fee)}</strong></div>
              <div className="summary-total"><span>Estimated USDC received</span><strong>{formatMoney(calculations.output)}</strong></div>
            </div>
            <div className="source-note"><ShieldCheck size={17} /><span>An unsafe, expired, or failed epoch returns the positions and charges no market fee.</span></div>
            {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
            <button className="primary-button full" disabled={calculations.safeAmount <= 0 || calculations.output <= 0 || submitting} onClick={submit}>{submitting ? "Waiting for wallet…" : `Sell ${calculations.safeAmount.toFixed(2)} ${outcome}`}<ArrowRight size={17} /></button>
          </>
        )}
      </section>
    </div>
  );
}

function ChallengeSheet({ market, onClose, onSubmit }) {
  const dialogRef = useModal(onClose);
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [transactionUrl, setTransactionUrl] = useState("");
  const [evidenceRegistered, setEvidenceRegistered] = useState(true);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const result = await onSubmit(evidence);
      setTransactionUrl(result?.url || "");
      setEvidenceRegistered(result?.evidenceRegistered !== false);
      setSubmitted(true);
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "The challenge could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet compact-sheet" role="dialog" aria-modal="true" aria-label="Challenge provisional result" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        {submitted ? (
          <div className="success-state" role="status">
            <div className="success-icon"><Check size={28} /></div>
            <span className="eyebrow">CHALLENGE SUBMITTED</span>
            <h2>Resolver review is required.</h2>
            <p>If two resolvers accept or no verdict arrives before timeout, the market becomes Invalid and the fixed bond is returned.</p>
            {!evidenceRegistered ? <div className="inline-error" role="alert"><Info size={16} /><span>The on-chain challenge succeeded, but the evidence reference could not be registered after three attempts. Keep the reference and transaction link for operator recovery.</span></div> : null}
            {transactionUrl && <a className="transaction-link" href={transactionUrl} target="_blank" rel="noreferrer">View on PolygonScan <ArrowRight size={14} /></a>}
            <button className="primary-button full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <span className="sheet-kicker">OBJECTIVE EVIDENCE ONLY</span>
            <h2>Challenge the provisional result</h2>
            <p className="sheet-description">This freezes finalization for resolver review. A rejected challenge sends the fixed 10 test-USDC bond to the published bond recipient.</p>
            <label className="evidence-field"><span>Evidence URL or canonical identifier</span><input value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder="https://evidence.example/result.json" /></label>
            <div className="risk-note"><Info size={17} /><span>Use objective counter-evidence: an archived official clip with exact timestamps and a rule-based explanation. Audience opinion or a participant statement is not enough.</span></div>
            {market.challengeEndsAt && <p className="gas-note">Window ends {new Date(market.challengeEndsAt).toLocaleString()}.</p>}
            {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
            <button className="primary-button full" disabled={!evidence.trim() || submitting} onClick={submit}>{submitting ? "Waiting for wallet…" : "Bond 10 test USDC and challenge"}<ArrowRight size={17} /></button>
          </>
        )}
      </section>
    </div>
  );
}

function LiquiditySheet({ market, onClose, walletConnected, onConnect, onSubmit, deployed }) {
  const dialogRef = useModal(onClose);
  const [amount, setAmount] = useState(500);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [transactionUrl, setTransactionUrl] = useState("");
  const poolShare = useMemo(() => {
    const deposit = Math.max(0, Number(amount) || 0);
    if (deployed && market.totalLpShares > 0n && market.reserveA > 0n && market.reserveB > 0n) {
      try {
        const depositUnits = fromUsdc(deposit);
        const largestReserve = market.reserveA > market.reserveB ? market.reserveA : market.reserveB;
        const shares = depositUnits * market.totalLpShares / largestReserve;
        return Number(shares * 1_000_000n / (market.totalLpShares + shares)) / 10_000;
      } catch {
        return 0;
      }
    }
    // Without the real reserves this build cannot compute a share. Falling back
    // to deposit/(pool+deposit) with an unread pool of 0 offered every
    // prospective LP a flat 100%.
    return null;
  }, [amount, deployed, market.reserveA, market.reserveB, market.totalLpShares]);

  const submit = async () => {
    if (!walletConnected) {
      try {
        await onConnect();
      } catch (cause) {
        setError(cause?.message || "Wallet connection failed.");
      }
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const result = await onSubmit(Number(amount));
      setTransactionUrl(result?.url || "");
      setConfirmed(true);
    } catch (cause) {
      setError(cause?.shortMessage || cause?.message || "Liquidity could not be submitted.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet liquidity-sheet" role="dialog" aria-modal="true" aria-label="Provide liquidity" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        {confirmed ? (
          <div className="success-state" role="status">
            <div className="success-icon purple"><Droplets size={28} /></div>
            <span className="eyebrow">LIQUIDITY QUEUED</span>
            <h2>You’re becoming a market maker.</h2>
            <p>{deployed ? "Your Circle test USDC is escrowed until the live source clears this epoch." : "No market contract is configured in this build, so nothing was submitted."}</p>
            {transactionUrl && <a className="transaction-link" href={transactionUrl} target="_blank" rel="noreferrer">View on PolygonScan <ArrowRight size={14} /></a>}
            <button className="primary-button full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <span className="sheet-kicker">PERMISSIONLESS MARKET MAKING</span>
            <h2>Provide liquidity</h2>
            <p className="sheet-description">Anyone except the competition’s participants and insiders can supply this market and earn a share of its 0.3% trading fees.</p>
            <div className="market-mini">{market.image ? <img src={market.image} alt="" /> : null}<div><span>{market.category}</span><strong>{market.question}</strong></div></div>
            <label className="amount-field">
              <span>USDC to supply</span>
              <div><span>$</span><input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
            </label>
            <div className="lp-estimate">
              <div><span>Current liquidity</span><strong>{formatMoney(market.pool)}</strong></div>
              <div>
                <span>Estimated pool share</span>
                <strong>{poolShare === null ? "Not available" : `${poolShare.toFixed(2)}%`}</strong>
              </div>
              <div><span>Trading fee to LPs</span><strong>0.3%</strong></div>
            </div>
            <div className="risk-note"><Info size={17} /><span>LP returns depend on trading and the final result. You can lose some or all of the supplied value.</span></div>
            {error && <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div>}
            <button className="primary-button full" disabled={Number(amount) < 1 || submitting} onClick={submit}>{submitting ? "Waiting for wallet…" : walletConnected ? "Supply both outcomes" : "Connect wallet to continue"}<ArrowRight size={17} /></button>
            <p className="gas-note">LP inventory remains locked until final resolution or invalidation.</p>
          </>
        )}
      </section>
    </div>
  );
}

function CreatorDraftSheet({ onClose, initialDraft = null }) {
  const dialogRef = useModal(onClose);
  const [draft, setDraft] = useState(() => creatorDraftSeed(initialDraft));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const update = (event) => {
    const { name, value } = event.target;
    setDraft((current) => ({
      ...current,
      [name]: value,
      ...(name === "marketType"
        ? {
            approvedSource:
              value === "trader_battle"
                ? "Hyperliquid account data"
                : "The complete archived official livestream and a canonical timestamp evidence file.",
          }
        : {}),
    }));
    setError("");
  };

  const submit = (event) => {
    event.preventDefault();
    const stream = resolveStreamSource(draft.streamUrl.trim(), {
      parentHost: typeof window === "undefined" ? "" : window.location.hostname,
    });
    const validationError = validateCreatorDraft(draft, stream);
    if (validationError) {
      setError(validationError);
      return;
    }

    const reviewableDraft = buildReviewableDraft(draft, stream);

    try {
      localStorage.setItem("tradermarket-creator-draft", JSON.stringify(reviewableDraft));
      const file = new Blob([`${JSON.stringify(reviewableDraft, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = draft.marketType === "stream_event" ? "tradermarket-event-market-draft.json" : "tradermarket-competition-draft.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setSaved(true);
    } catch {
      setError("The browser could not save the draft. Check download permissions and try again.");
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet creator-sheet" role="dialog" aria-modal="true" aria-label="Prepare a market draft" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        {saved ? (
          <div className="success-state" role="status">
            <div className="success-icon purple"><Swords size={28} /></div>
            <span className="eyebrow">DRAFT DOWNLOADED</span>
            <h2>Your market is ready for operator review.</h2>
            <p>The draft is not live yet. The operator must verify its exact source, evidence rule, resolver quorum, market configuration, and publication permissions before audience trading can open.</p>
            <button className="primary-button full" onClick={onClose}>Done</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <span className="sheet-kicker">CREATOR APPLICATION</span>
            <h2>Prepare a live market</h2>
            <p className="sheet-description">Create the reviewable rules now. TraderMarket will not open audience trading until the exact source, resolver evidence, and on-chain market are verified.</p>
            <label className="creator-field">
              <span>Market type</span>
              <select name="marketType" value={draft.marketType} onChange={update}>
                <option value="trader_battle">Trader battle</option>
                <option value="stream_event">Livestream event</option>
              </select>
            </label>
            {draft.marketType === "stream_event" ? (
              <>
                <label className="creator-field"><span>Subject</span><input name="subject" value={draft.subject} onChange={update} placeholder="Creator or event name" autoComplete="off" /></label>
                <div className="creator-pair">
                  <label className="creator-field"><span>Outcome A</span><input name="outcomeA" value={draft.outcomeA} onChange={update} /></label>
                  <label className="creator-field"><span>Outcome B</span><input name="outcomeB" value={draft.outcomeB} onChange={update} /></label>
                </div>
              </>
            ) : (
              <>
                <div className="creator-pair">
                  <label className="creator-field"><span>Participant A</span><input name="participantA" value={draft.participantA} onChange={update} placeholder="Alice" autoComplete="off" /></label>
                  <label className="creator-field"><span>Participant B</span><input name="participantB" value={draft.participantB} onChange={update} placeholder="Bob" autoComplete="off" /></label>
                </div>
                <div className="creator-pair">
                  <label className="creator-field"><span>A's Hyperliquid account</span><input name="participantAAccount" value={draft.participantAAccount} onChange={update} placeholder="0x…" autoComplete="off" /></label>
                  <label className="creator-field"><span>B's Hyperliquid account</span><input name="participantBAccount" value={draft.participantBAccount} onChange={update} placeholder="0x…" autoComplete="off" /></label>
                </div>
              </>
            )}
            <label className="creator-field"><span>Audience question</span><input name="question" value={draft.question} onChange={update} placeholder="Who wins the competition?" /></label>
            <label className="creator-field"><span>{draft.marketType === "stream_event" ? "Official live page — exact video required before launch" : "Livestream link"}</span><input name="streamUrl" type="url" value={draft.streamUrl} onChange={update} placeholder="YouTube Live, Twitch, or Kick URL" /></label>
            <label className="creator-field"><span>Approved evidence source</span><textarea name="approvedSource" value={draft.approvedSource} onChange={update} rows="3" /></label>
            <label className="creator-field"><span>Objective winning rule</span><textarea name="winningRule" value={draft.winningRule} onChange={update} placeholder="Example: highest realized P&amp;L in the approved Hyperliquid accounts when the organizer closes the room." rows="4" /></label>
            <div className="source-note"><ShieldCheck size={17} /><span>{draft.marketType === "stream_event" ? "The player never decides the result automatically. Two independent resolvers must approve the same archived timestamp evidence, followed by a challenge window." : "The stream is for viewers. Resolution comes only from the approved account-data source."}</span></div>
            {error ? <div className="inline-error" role="alert"><Info size={16} /><span>{error}</span></div> : null}
            <button className="primary-button full" type="submit">Download draft for review <ArrowRight size={17} /></button>
          </form>
        )}
      </section>
    </div>
  );
}

function FundsSheet({ onClose, account, client, capabilities }) {
  const dialogRef = useModal(onClose);
  // The faucet is configuration, not a constant: a deployment on another chain
  // has another faucet, or none. Read it rather than assume Circle's Amoy one.
  const entry = useApiResource(client, `/v1/entry/status${account ? `?address=${account}` : ""}`, {
    deps: [account],
  });
  const funding = entry.data?.steps?.find((step) => step.id === "funding") ?? null;
  const faucetUrl = funding?.url ?? null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="trade-sheet compact-sheet" role="dialog" aria-modal="true" aria-label="Add funds" ref={dialogRef} onMouseDown={(event) => event.stopPropagation()}>
        <button className="close-button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        <span className="sheet-kicker">TEST COLLATERAL</span>
        <h2>Add funds</h2>
        <p className="sheet-description">
          {capabilities?.collateral_notice ?? "Collateral is test USDC and has no real-world value."}
        </p>
        {faucetUrl ? (
          <a className="wallet-address" href={faucetUrl} target="_blank" rel="noreferrer">
            <span>{account ? `${account.slice(0, 9)}...${account.slice(-6)}` : "Connect a wallet first"}</span>
            <strong>Open faucet</strong>
          </a>
        ) : (
          <p className="muted-note">
            {funding?.detail ?? "No test-USDC faucet is configured for this deployment. Ask the operator how to obtain test collateral."}
          </p>
        )}
        <div className="source-note">
          <ShieldCheck size={17} />
          <span>{capabilities?.gas_statement ?? "You pay your own gas."}</span>
        </div>
      </section>
    </div>
  );
}

function scrollBehavior() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function RouteFocus({ routeKey }) {
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [routeKey]);

  return null;
}

function MobileNav({ activeView, onNavigate, capabilities }) {
  const items = navFor(capabilities);
  const navRef = useRef(null);

  useEffect(() => {
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
  }, [activeView]);

  return (
    <nav ref={navRef} className="mobile-nav" aria-label="Mobile navigation">
      {items.map(({ label, icon: Icon, route }) => (
        <a
          key={label}
          href={buildPath(route)}
          aria-current={activeView === route ? "page" : undefined}
          className={activeView === route ? "active" : ""}
          onClick={(event) => {
            event.preventDefault();
            onNavigate?.(route);
          }}
        >
          <Icon size={19} />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

export function App() {
  const testnet = useTestnetMarket();
  // The room reads identify the reader, like every other surface, so an
  // allowlisted account is not refused the Live Room alone.
  const liveRoom = useLiveRoom(testnet.account || null);
  // Route state drives the shell, so every destination has a shareable URL.
  const [route, setRoute] = useState(() => parseRoute(typeof window === "undefined" ? "" : window.location.hash));
  const activeView = route.name;
  // The selection is an identity, not a copy of the card. Storing the card
  // froze the spotlight at whatever the room looked like on load: a settled
  // slot kept rendering as OPEN at a stale price, buy buttons enabled, while
  // the grid beside it showed Final at the current block.
  const [selectedSlotIndex, setSelectedSlotIndex] = useState(null);
  const [tradeOutcome, setTradeOutcome] = useState(null);
  const [sellOutcome, setSellOutcome] = useState(null);
  const [showChallenge, setShowChallenge] = useState(false);
  const [showLiquidity, setShowLiquidity] = useState(false);
  const [showFunds, setShowFunds] = useState(false);
  const [showCreatorDraft, setShowCreatorDraft] = useState(false);
  const [creatorDraftPreset, setCreatorDraftPreset] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = (message, tone = "success") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3200);
  };

  // One client for every read surface. The account travels with each request so
  // the allowlist and the entry journey can answer for this specific person.
  const apiClient = useMemo(
    () =>
      createApiClient({
        baseUrl: import.meta.env?.VITE_ROOM_API_URL || "",
        getAddress: () => testnet.account || null,
      }),
    [testnet.account]
  );
  const capabilities = useApiResource(apiClient, "/v1/capabilities");

  useEffect(() => onRouteChange(setRoute), []);

  // A routed page needs a routed title, or history and tabs become unreadable.
  useEffect(() => {
    if (typeof document !== "undefined") document.title = titleFor(route.name, route.params);
  }, [route]);

  // A dialog belongs to the page that opened it. Left open across a route
  // change it covers a page it has nothing to do with, and because the focus
  // trap holds focus, a keyboard user cannot reach the page they navigated to.
  useEffect(() => {
    setTradeOutcome(null);
    setSellOutcome(null);
    setShowChallenge(false);
    setShowLiquidity(false);
    setShowFunds(false);
    setShowCreatorDraft(false);
    setCreatorDraftPreset(null);
  }, [route.name]);

  const openCreatorDraft = (preset = null) => {
    setCreatorDraftPreset(preset);
    setShowCreatorDraft(true);
  };

  // Real room cards replace fixtures once the Coordinator is configured.
  const roomCards = useMemo(() => {
    if (!liveRoom.configured || !liveRoom.snapshot) return [];
    return liveRoom.slots.map((slot) => ({
      id: `slot-${slot.slot_index}`,
      slotIndex: slot.slot_index,
      category: marketCardPresentation({ state: slot.state }).category,
      // The chain's own state, not a display label. Deriving tradability from
      // the label meant "Forecasting closed" did not match "closed", so a
      // closed market kept its buy buttons.
      state: slot.state,
      finalOutcome: slot.state === "final" ? 1 : slot.state === "invalid" ? 4 : 0,
      liveLabel: `QUESTION ${slot.slot_index + 1}`,
      gateLabel: (SLOT_STATE_LABEL[slot.state] ?? slot.state).toUpperCase(),
      title: slot.question,
      question: slot.question,
      image: null,
      streamUrl: slot.stream_url,
      streamHealth: liveRoom.snapshot.health?.stream ?? "unknown",
      // No price yet means no price. A 50¢ placeholder is a quote nobody made,
      // and it fed both the probability bar and the trade sheet's estimate.
      yes: slot.price ? Math.round(Number(slot.price.implied_prob_a) / 10000) : null,
      no: slot.price ? 100 - Math.round(Number(slot.price.implied_prob_a) / 10000) : null,
      // The room reports LP shares; a hard-coded zero told every reader a
      // market holding real inventory was empty.
      totalLpShares: slot.liquidity ? BigInt(slot.liquidity.total_lp_shares) : null,
      winnerRewardBps: slot.winner_reward_bps ?? null,
      pool: null,
      // Only when something actually counted them.
      viewers: liveRoom.snapshot.viewers?.measured ? String(liveRoom.snapshot.viewers.count) : null,
      participants: ["Outcome A", "Outcome B"],
      duration: slot.closed_seq ? `Closed at source sequence ${slot.closed_seq}` : "Closes on its published condition",
      market: slot.market,
      block: slot.price?.block ?? null,
    }));
  }, [liveRoom.configured, liveRoom.snapshot, liveRoom.slots]);

  const room = useMemo(() => ({ ...liveRoom, roomCards }), [liveRoom, roomCards]);

  // A selection is "live" when the deployed market contract is the one being
  // shown. Without a deployment there is nothing live to show.
  // The standalone product: one deployed market contract and no Live Room.
  // Removing the fixture markets removed the object this path used to overlay
  // real contract state onto, which would have left a single-market deployment
  // with a blank page. It builds its own market from the contract instead —
  // every field read, nothing invented.
  // Resolved against the latest cards on every render, so the spotlight shows
  // the same state and price as the grid beside it.
  const activeMarket = useMemo(
    () => roomCards.find((card) => card.slotIndex === selectedSlotIndex) ?? null,
    [roomCards, selectedSlotIndex]
  );

  const standaloneMarket = useMemo(() => {
    if (!testnet.deployed || !testnet.snapshot) return null;
    return {
      id: "standalone",
      slotIndex: 0,
      category: "Live market",
      title: "Live market",
      question: "",
      image: null,
      yes: null,
      no: null,
      pool: null,
      participants: [],
      duration: "",
    };
  }, [testnet.deployed, testnet.snapshot]);

  const selectedMarket = activeMarket ?? standaloneMarket;
  // A rolling room publishes one child contract per question. Make that child
  // the gateway's active contract whenever the spotlight changes, so reads and
  // every subsequent write follow the question the reader actually selected.
  useEffect(() => {
    if (selectedMarket?.market) testnet.selectMarket(selectedMarket.market);
  }, [selectedMarket?.market, testnet.selectMarket]);

  // Identified by the address that produced the snapshot. An env var only says
  // what a standalone build started with; it cannot prove the selected room
  // child has answered this read.
  const isLiveSelection = Boolean(
    testnet.snapshot?.marketAddress &&
      selectedMarket &&
      String(selectedMarket.market ?? testnet.marketAddress).toLowerCase()
        === String(testnet.snapshot.marketAddress).toLowerCase()
  );
  const account = testnet.account;
  const walletConnected = Boolean(account);
  // No reading means no number. A placeholder balance is a fabrication that
  // someone could act on, and "—" is both honest and obvious.
  const walletBalance = testnet.snapshot?.wallet ? toUsdc(testnet.snapshot.wallet.usdcBalance) : null;

  const displayMarket = useMemo(() => {
    if (!selectedMarket) return null;
    if (!isLiveSelection || !testnet.snapshot) return selectedMarket;
    const snapshot = testnet.snapshot;
    const reserveTotal = snapshot.reserveA + snapshot.reserveB;
    // No reserves means no price. A 50/50 placeholder is a quote nobody made,
    // and it fed the probability bar, the buy buttons and the trade sheet alike.
    const yes = reserveTotal === 0n ? null : Math.round(Number(snapshot.reserveB * 10_000n / reserveTotal) / 100);
    const gateLabels = ["MARKET OPEN", "SOURCE DELAYED", "FORECASTING CLOSED"];
    return {
      ...selectedMarket,
      market: snapshot.marketAddress,
      question: snapshot.question,
      title: `${snapshot.participantAName} vs ${snapshot.participantBName}`,
      participants: [snapshot.participantAName, snapshot.participantBName],
      image: snapshot.imageUrl?.startsWith("http") ? snapshot.imageUrl : selectedMarket.image ?? null,
      streamUrl: snapshot.streamUrl,
      yes,
      no: yes === null ? null : 100 - yes,
      pool: toUsdc(snapshot.collateralBacking),
      reserveA: snapshot.reserveA,
      reserveB: snapshot.reserveB,
      totalLpShares: snapshot.totalLpShares,
      winnerRewardBps: snapshot.winnerRewardBps,
      gateLabel: snapshot.finalOutcome ? "FINAL RESULT" : gateLabels[snapshot.gateState] || "MARKET STATUS",
      // The room owns the rolling slot state; the child contract contributes
      // the gate and outcome details without erasing that authoritative state.
      state: selectedMarket.state ?? null,
      gateState: Number(snapshot.gateState),
      finalOutcome: Number(snapshot.finalOutcome),
      liveLabel: `EPOCH ${snapshot.currentEpoch}`,
      duration: `Official source sequence ${snapshot.lastSafeSequence}`,
      canChallenge: snapshot.provisionalOutcome > 0 && !snapshot.challenged && snapshot.finalOutcome === 0 && Date.now() < Number(snapshot.provisionalAt + snapshot.challengeWindow) * 1000,
      challengeEndsAt: Number(snapshot.provisionalAt + snapshot.challengeWindow) * 1000,
    };
  }, [selectedMarket, isLiveSelection, testnet.snapshot]);

  // With a room configured, open on whatever the room is focusing. Without one
  // there is deliberately nothing selected: the spotlight stays empty rather
  // than showing a market that does not exist.
  useEffect(() => {
    if (selectedSlotIndex !== null || roomCards.length === 0) return;
    const focus = liveRoom.snapshot?.program?.focus;
    const opening = roomCards.find((card) => card.slotIndex === focus) ?? roomCards[0];
    setSelectedSlotIndex(opening.slotIndex);
  }, [roomCards, liveRoom.snapshot, selectedSlotIndex]);


  // Liquidity needs a market to provide liquidity to. Asking for the sheet
  // with none configured gets an explanation instead of a dead click.
  const openLiquidity = () => {
    if (!displayMarket) {
      notify("No live market is configured in this build, so there is nothing to provide liquidity to yet.", "error");
      return;
    }
    if (!marketAcceptsLiquidity(displayMarket)) {
      notify("Liquidity can only be added before or while a question is open.", "error");
      return;
    }
    if (!isLiveSelection) {
      notify("The selected market contract is not available, so no liquidity can be submitted.", "error");
      return;
    }
    setShowLiquidity(true);
  };

  const portfolio = useMemo(() => {
    // Without a wallet reading there is nothing to report. The Portfolio shows
    // its own empty state and the history section below reads real chain facts.
    if (!testnet.snapshot?.wallet) return null;
    const snapshot = testnet.snapshot;
    const normalized = account.toLowerCase();
    const rewardA = snapshot.rewardAddressA?.toLowerCase() === normalized;
    const rewardB = snapshot.rewardAddressB?.toLowerCase() === normalized;
    const winnerRewardEligible = (snapshot.finalOutcome === 1 && rewardA)
      || (snapshot.finalOutcome === 2 && rewardB)
      || (snapshot.finalOutcome === 3 && (rewardA || rewardB));
    return {
      usdc: toUsdc(snapshot.wallet.usdcBalance),
      positionA: toUsdc(snapshot.wallet.positionA),
      positionB: toUsdc(snapshot.wallet.positionB),
      lpShares: toUsdc(snapshot.wallet.lpShares),
      lpFees: toUsdc(snapshot.wallet.lpFeeCredit),
      integrityBond: toUsdc(liveRoom.roomAddress ? testnet.bondSnapshot?.postedBond ?? 0n : snapshot.wallet.integrityBond),
      winnerFeePaid: toUsdc(snapshot.wallet.winnerFeePaid),
      winnerRewardPool: toUsdc(snapshot.winnerRewardPool),
      winnerRewardEligible,
      finalOutcome: snapshot.finalOutcome,
    };
  }, [account, liveRoom.roomAddress, testnet.bondSnapshot, testnet.snapshot, walletConnected]);

  const participantState = useMemo(() => {
    if (!testnet.snapshot || !account) return null;
    const normalized = account.toLowerCase();
    const eligible = [testnet.snapshot.participantA, testnet.snapshot.participantB]
      .some((address) => address?.toLowerCase() === normalized);
    return {
      eligible,
      posted: Boolean(
        liveRoom.roomAddress
          ? testnet.bondSnapshot?.postedBond > 0n
          : testnet.snapshot.wallet?.integrityBond > 0n
      ),
    };
  }, [account, liveRoom.roomAddress, testnet.bondSnapshot, testnet.snapshot]);

  useEffect(() => {
    if (!account || !liveRoom.roomAddress) return;
    testnet.readBond({ roomAddress: liveRoom.roomAddress }).catch(() => {});
  }, [account, liveRoom.roomAddress, testnet.readBond]);

  /**
   * Signs a plain string with the connected wallet.
   *
   * Used for chat identity and for the terms acceptance. Both prove who is
   * speaking without an account system and without custody; a wallet that
   * cannot sign simply cannot do those things, which is the honest outcome.
   */
  const signStatement = async (text) => {
    if (typeof window === "undefined" || !window.ethereum || !testnet.account) {
      throw new Error("Connect a wallet that can sign messages to chat.");
    }
    return window.ethereum.request({
      method: "personal_sign",
      params: [text, testnet.account],
    });
  };

  const connectWallet = async () => {
    // A wallet, or nothing. The previous fallback invented an address, showed
    // it in the connect button indefinitely, and sent it as `x-tm-address` on
    // every call and as the subject of a terms acceptance — an invented user,
    // asserted against an address on a public chain that nobody here controls.
    if (typeof window === "undefined" || !window.ethereum) {
      notify("No wallet was found in this browser. Install one to connect — this build will not stand in for it.", "error");
      return null;
    }
    const connected = await testnet.connect();
    notify(`Wallet ${connected.slice(0, 6)}… connected.`);
    return connected;
  };

  // A submission this build cannot make must fail, loudly. Returning an empty
  // success made the sheet render a full receipt — "PREDICTION QUEUED", a
  // position count, an amount "if correct" — for a transaction that was never
  // built, let alone sent. Only one market contract is configured at a time, so
  // any other slot genuinely cannot be traded from here.
  const NOT_CONFIGURED =
    "This question has no market contract configured in this build, so nothing can be submitted for it.";

  const submitPrediction = async (outcome, amount) => {
    if (!isLiveSelection) throw new Error(NOT_CONFIGURED);
    const result = await testnet.predict(outcome, amount, { marketAddress: displayMarket?.market ?? testnet.marketAddress });
    notify("Prediction submitted — pending source clearance.");
    return result;
  };

  const submitLiquidity = async (amount) => {
    if (!isLiveSelection) throw new Error(NOT_CONFIGURED);
    const result = await testnet.provideLiquidity(amount, { marketAddress: displayMarket?.market ?? testnet.marketAddress });
    notify("Liquidity submitted — pending source clearance.");
    return result;
  };

  const submitSale = async (outcome, amount) => {
    // Selling is about the configured contract — the one the position is in —
    // not about which question Home happens to be showing.
    if (!confirmedDeployment) throw new Error(NOT_CONFIGURED);
    const result = await testnet.sell(outcome, amount, { marketAddress: testnet.snapshot?.marketAddress });
    notify("Sale submitted — pending source clearance.");
    return result;
  };

  const submitChallenge = async (evidence) => {
    const marketAddress = displayMarket?.market ?? testnet.marketAddress;
    const result = await testnet.challenge(evidence, { marketAddress });
    let registration = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      registration = await apiClient.post("/v1/oracle/challenges", {
        market: marketAddress,
        evidence,
        evidence_hash: result.evidenceHash,
        transaction_hash: result.hash,
      });
      if (registration.ok) break;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
    }
    const evidenceRegistered = Boolean(registration?.ok);
    notify(
      evidenceRegistered
        ? "Result challenge and counter-evidence confirmed."
        : "Challenge confirmed on chain, but its evidence reference still needs operator recovery.",
      evidenceRegistered ? "success" : "error"
    );
    return { ...result, evidenceRegistered };
  };

  const claim = async (functionName) => {
    try {
      if (!testnet.deployed) {
        notify("Claims become active once a market contract is configured.", "error");
        return;
      }
      const result = functionName === "claimIntegrityBond" && liveRoom.roomAddress
        ? await testnet.claim(functionName, { roomAddress: liveRoom.roomAddress })
        : await testnet.claim(functionName, { marketAddress: testnet.snapshot?.marketAddress ?? testnet.marketAddress });
      notify(`Claim confirmed. ${result.hash.slice(0, 10)}…`);
    } catch (cause) {
      notify(cause?.shortMessage || cause?.message || "Claim unavailable in the current market state.", "error");
    }
  };

  const postBond = async () => {
    try {
      const result = liveRoom.roomAddress
        ? await testnet.postBond({ roomAddress: liveRoom.roomAddress })
        : await testnet.postBond();
      notify(`Integrity bond confirmed. ${result.hash.slice(0, 10)}…`);
    } catch (cause) {
      notify(cause?.shortMessage || cause?.message || "The integrity bond could not be posted.", "error");
    }
  };

  const navigate = (name, params = {}) => {
    routeTo(name, params);
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  };

  function renderRoute() {
    switch (route.name) {
      case "home":
      case "room": {
        // The route names a room; this build serves one. Rendering the
        // configured room's markets under any other room's URL and title is
        // the wrong room's data presented as that room's.
        // Only when the route actually names one: Home carries no room id and
        // must not be told this build does not serve it.
        const named = route.params.roomId ?? null;
        if (named && room.configured && room.snapshot?.room && named !== room.snapshot.room) {
          return (
            <main className="page secondary-view">
              <div className="view-title">
                <span className="eyebrow"><Radio size={15} /> LIVE ROOM</span>
                <h1>This build does not serve that room</h1>
                <p>
                  It is configured for <strong>{room.snapshot.room}</strong>, so it cannot show{" "}
                  <strong>{named}</strong>. Nothing on this page would be that room's data.
                </p>
                <a className="primary-button" href={buildPath("room", { roomId: room.snapshot.room })}>
                  Open {room.snapshot.room}
                </a>
                <a className="secondary-button" href={buildPath("schedule")}>See the schedule</a>
              </div>
            </main>
          );
        }
        return (
          <HomeView
            market={displayMarket}
            onSelectMarket={selectMarket}
            onTrade={setTradeOutcome}
            onLiquidity={openLiquidity}
            onChallenge={() => setShowChallenge(true)}
            deployed={isLiveSelection}
            room={room}
            onSelectSlot={selectSlot}
            capabilities={capabilities.data}
            client={apiClient}
            account={account}
            onSignChat={signStatement}
            onPrepareMarket={openCreatorDraft}
          />
        );
      }
      case "schedule":
        return <ScheduleView client={apiClient} />;
      case "activity":
        return <ActivityView client={apiClient} />;
      case "activityDetail":
        return <ActivityDetailView client={apiClient} market={route.params.market} />;
      case "leaderboard":
        return <LeaderboardView client={apiClient} />;
      case "referrals":
        return <ReferralsView client={apiClient} account={account} onConnect={connectWallet} />;
      case "profile":
        return <ProfileView client={apiClient} address={route.params.address} />;
      case "help":
        return <HelpView client={apiClient} />;
      case "helpArticle":
        return <HelpView client={apiClient} slug={route.params.slug} />;
      case "enter":
        return <EntryView client={apiClient} account={account} onConnect={connectWallet} onSign={signStatement} />;
      case "oracle":
        return <OracleView client={apiClient} testnet={testnet} market={displayMarket} onConnect={connectWallet} onNotify={notify} />;
      case "notFound":
        return (
          <main className="page secondary-view">
            <div className="view-title">
              <h1>Page not found</h1>
              <p>That link does not match any TraderMarket page.</p>
              <a className="inline-link" href={buildPath("home")}>
                ← Back to live markets
              </a>
            </div>
          </main>
        );
      default:
        return (
          <EmptyView
            activeView={route.name}
            client={apiClient}
            account={account}
            onHome={() => navigate("home")}
            onLiquidity={openLiquidity}
            portfolio={portfolio}
            deployed={testnet.deployed}
            walletConnected={walletConnected}
            onClaim={claim}
            onSell={setSellOutcome}
            participantState={participantState}
            onPostBond={postBond}
            onStartDraft={() => openCreatorDraft()}
          />
        );
    }
  }

  // Configured *and* answering. Everything the strip says about a live contract
  // hangs on this rather than on the presence of an env var.
  const confirmedDeployment = Boolean(testnet.deployed && testnet.snapshot?.marketAddress);

  // The market a portfolio position is actually in: the configured contract,
  // read from chain. Distinct from the Home spotlight, which is whatever
  // question the reader is looking at.
  const portfolioMarket = useMemo(() => {
    if (!testnet.snapshot) return null;
    const snapshot = testnet.snapshot;
    const reserveTotal = snapshot.reserveA + snapshot.reserveB;
    const yes = reserveTotal === 0n ? null : Math.round(Number((snapshot.reserveB * 10_000n) / reserveTotal) / 100);
    return {
      id: "configured",
      slotIndex: 0,
      category: "Live market",
      liveLabel: `EPOCH ${snapshot.currentEpoch}`,
      title: `${snapshot.participantAName} vs ${snapshot.participantBName}`,
      question: snapshot.question,
      image: null,
      yes,
      no: yes === null ? null : 100 - yes,
      pool: toUsdc(snapshot.collateralBacking),
      reserveA: snapshot.reserveA,
      reserveB: snapshot.reserveB,
      totalLpShares: snapshot.totalLpShares,
      winnerRewardBps: snapshot.winnerRewardBps,
      gateState: Number(snapshot.gateState),
      finalOutcome: Number(snapshot.finalOutcome),
      state: null,
      duration: `Official source sequence ${snapshot.lastSafeSequence}`,
      participants: [snapshot.participantAName, snapshot.participantBName],
      market: snapshot.marketAddress,
    };
  }, [testnet.snapshot]);

  const selectMarket = (market) => {
    // The index, not the object: the card is re-derived from the latest room
    // snapshot on every render.
    setSelectedSlotIndex(market?.slotIndex ?? null);
    window.scrollTo({ top: 90, behavior: scrollBehavior() });
  };

  // Selecting a question from the rolling strip switches the room's focus
  // locally; the program itself advances on chain, not from the client.
  const selectSlot = (slot) => {
    const card = roomCards.find((entry) => entry.slotIndex === slot.slot_index);
    if (card) selectMarket(card);
  };

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to main content
      </a>
      <RouteFocus routeKey={`${route.name}:${JSON.stringify(route.params)}`} />
      <AppHeader
        activeView={activeView}
        onNavigate={navigate}
        walletConnected={walletConnected}
        account={account}
        balance={walletBalance}
        configured={testnet.deployed}
        deployed={confirmedDeployment}
        loading={testnet.loading}
        onConnect={connectWallet}
        onAddFunds={() => setShowFunds(true)}
        chainId={capabilities.data?.chain_id ?? null}
        capabilities={capabilities.data}
      />
      <div className="app-main">
        {room.configured && room.mode === "fallback" ? (
          <div className="deployment-strip">
            {/* Only a build with a market contract is reading one. On a
                room-only build whose API is down, this app is reading nothing,
                and saying otherwise describes a fallback that does not exist. */}
            <span>
              <ShieldCheck size={14} />{" "}
              {testnet.deployed
                ? "Live updates unavailable — reading the market contract directly over RPC"
                : "Live updates unavailable — the room API is not answering, and this build has no contract to read directly"}
            </span>
            <span>{testnet.deployed ? "Markets and settlement are unaffected" : "Settlement on chain is unaffected"}</span>
          </div>
        ) : null}
        {/* `testnet.deployed` is a regex over an env var: it says an address was
            configured, not that anything answered. The snapshot is the proof a
            read succeeded. */}
        <div className={confirmedDeployment ? "deployment-strip live" : "deployment-strip"}>
          <span>
            <ShieldCheck size={14} />{" "}
            {confirmedDeployment
              ? `Connected to the deployed market on ${chainLabel(capabilities.data?.chain_id ?? null).toLowerCase()}`
              : testnet.deployed
                ? "The selected market contract cannot be read over RPC"
                : "No market contract is configured in this build"}
          </span>
          {confirmedDeployment ? (
            <a href={`${EXPLORER_URL}/address/${testnet.snapshot?.marketAddress ?? testnet.marketAddress}`} target="_blank" rel="noreferrer">View contract <ArrowRight size={13} /></a>
          ) : (
            <span>{capabilities.data?.collateral_notice ?? "Test collateral with no real-world value"}</span>
          )}
        </div>
        <div id="main-content" tabIndex="-1">
          {renderRoute()}
        </div>
      </div>
      <MobileNav activeView={activeView} onNavigate={navigate} capabilities={capabilities.data} />
      {/* Every sheet needs a real market. Without one there is nothing to
          trade, so the sheet does not open rather than opening empty. */}
      {tradeOutcome && displayMarket && <TradeSheet market={displayMarket} outcome={tradeOutcome} onClose={() => setTradeOutcome(null)} walletConnected={walletConnected} onConnect={connectWallet} onSubmit={submitPrediction} deployed={isLiveSelection} />}
      {sellOutcome && portfolioMarket && <SellSheet market={portfolioMarket} outcome={sellOutcome} available={sellOutcome === "YES" ? portfolio?.positionA || 0 : portfolio?.positionB || 0} onClose={() => setSellOutcome(null)} onSubmit={submitSale} />}
      {showChallenge && displayMarket && <ChallengeSheet market={displayMarket} onClose={() => setShowChallenge(false)} onSubmit={submitChallenge} />}
      {showLiquidity && displayMarket && <LiquiditySheet market={displayMarket} onClose={() => setShowLiquidity(false)} walletConnected={walletConnected} onConnect={connectWallet} onSubmit={submitLiquidity} deployed={isLiveSelection} />}
      {showFunds && <FundsSheet onClose={() => setShowFunds(false)} account={account} client={apiClient} capabilities={capabilities.data} />}
      {showCreatorDraft && <CreatorDraftSheet initialDraft={creatorDraftPreset} onClose={() => setShowCreatorDraft(false)} />}
      {toast && (
        <div className={`toast ${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.tone === "error" ? <Info size={16} /> : <Check size={16} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}
