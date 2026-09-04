import { useState } from "react";
import { ArrowRight, CalendarClock, LifeBuoy, Radio, Search, Trophy, UserRound } from "lucide-react";
import { useApiResource } from "../hooks/useApiResource.js";
import { Surface } from "./Surface.jsx";
import { buildPath } from "../router.js";

const USDC = 1_000_000n;
const usdc = (value) => {
  try {
    const amount = BigInt(value ?? 0);
    return `${amount / USDC}.${String((amount % USDC) / 10_000n).padStart(2, "0")}`;
  } catch {
    return "0.00";
  }
};

/** Live, upcoming and recent rooms — the global schedule. */
export function ScheduleView({ client }) {
  const schedule = useApiResource(client, "/v1/schedule", { refreshMs: 20_000 });

  const group = (title, entries, emptyCopy) => (
    <section className="schedule-group" key={title}>
      <div className="section-heading">
        <div>
          <Radio size={18} /> <h2>{title}</h2>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="muted-note">{emptyCopy}</p>
      ) : (
        <ul className="schedule-list">
          {entries.map((entry) => (
            <li key={entry.room_id}>
              <a href={`#${entry.route}`} className="schedule-row">
                <span className={`state-chip ${entry.state === "live" ? "ok" : "muted"}`}>{entry.state}</span>
                <span className="schedule-question">{entry.headline_question ?? entry.room_id}</span>
                <span className="muted-note">
                  {entry.open_slots} open · {entry.settled_slots} settled of {entry.slots}
                </span>
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <CalendarClock size={15} /> PROGRAMME
        </span>
        <h1>Schedule</h1>
        <p>Rooms are listed by the state the chain reports. Nothing is listed before it exists.</p>
      </div>
      <Surface resource={schedule} label="the schedule">
        {(data) => (
          <>
            {group("Live now", data.live, "No room is live right now.")}
            {group("Upcoming", data.upcoming, "No room is armed and waiting to start.")}
            {group("Recently settled", data.recent, "No room has settled yet.")}
            {data.empty_reason ? <p className="muted-note">{data.empty_reason}</p> : null}
          </>
        )}
      </Surface>
    </main>
  );
}

/** Rankings derived from indexed claims. Empty until real payouts exist. */
export function LeaderboardView({ client }) {
  const board = useApiResource(client, "/v1/leaderboard", { refreshMs: 30_000 });

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <Trophy size={15} /> RANKINGS
        </span>
        <h1>Leaderboard</h1>
        <p>
          Ranked by test USDC actually credited on settled markets, derived from indexed chain claims. There is no XP,
          season, or volume figure here because none of those exist on chain.
        </p>
      </div>
      <Surface
        resource={board}
        label="the leaderboard"
        emptyWhen={(data) => data.entries.length === 0}
        empty={
          <div>
            <strong>No rankings yet</strong>
            <p>{board.data?.empty_reason}</p>
          </div>
        }
      >
        {(data) => (
          <div className="leaderboard-card">
            <div className="leaderboard-basis muted-note">
              Basis: {data.basis} · source: {data.derived_from}
            </div>
            {data.entries.map((entry) => (
              <a className="leader-row" key={entry.account} href={`#${entry.route}`}>
                <span className="rank">{entry.rank}</span>
                <div>
                  <strong className="mono">{entry.account}</strong>
                  <small>
                    {entry.settled_markets} settled market{entry.settled_markets === 1 ? "" : "s"} · {entry.claims}{" "}
                    claim{entry.claims === 1 ? "" : "s"} · {entry.trades} trade{entry.trades === 1 ? "" : "s"}
                  </small>
                </div>
                <strong className="positive">{usdc(entry.credited)}</strong>
              </a>
            ))}
          </div>
        )}
      </Surface>
    </main>
  );
}

/** One account's indexed facts. */
export function ProfileView({ client, address }) {
  const profile = useApiResource(client, `/v1/profiles/${encodeURIComponent(address)}`, { deps: [address] });

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <UserRound size={15} /> PROFILE
        </span>
        <h1 className="mono">{address}</h1>
        <p>Everything below is derived from indexed chain facts for this address.</p>
      </div>
      <Surface resource={profile} label="this profile">
        {(data) => (
          <div className="portfolio-grid">
            <div className="portfolio-card">
              <span>Credited</span>
              <strong>{usdc(data.credited)} test USDC</strong>
              <small>Total claimed across settled markets</small>
            </div>
            <div className="portfolio-card">
              <span>Settled markets</span>
              <strong>{data.settled_markets}</strong>
              <small>Markets this address took part in</small>
            </div>
            <div className="portfolio-card">
              <span>Claims</span>
              <strong>{data.claims}</strong>
              <small>Redemptions, LP settlements, fees and refunds</small>
            </div>
            <div className="portfolio-card">
              <span>Trades</span>
              <strong>{data.trades}</strong>
              <small>Executed purchases and sales</small>
            </div>
          </div>
        )}
      </Surface>
    </main>
  );
}

/** Searchable help, support and legal. */
export function HelpView({ client, slug }) {
  const [query, setQuery] = useState("");
  const path = slug
    ? `/v1/help/${encodeURIComponent(slug)}`
    : query.trim()
      ? `/v1/help?q=${encodeURIComponent(query.trim())}`
      : "/v1/help";
  const help = useApiResource(client, path, { deps: [slug, query] });

  if (slug) {
    return (
      <main className="page secondary-view">
        <div className="view-title">
          <span className="eyebrow">
            <LifeBuoy size={15} /> HELP
          </span>
          <a className="inline-link" href={buildPath("help")}>
            ← All help
          </a>
        </div>
        <Surface resource={help} label="this article">
          {(article) => (
            <article className="help-article">
              <h1>{article.title}</h1>
              <p>{article.body}</p>
            </article>
          )}
        </Surface>
      </main>
    );
  }

  return (
    <main className="page secondary-view">
      <div className="view-title">
        <span className="eyebrow">
          <LifeBuoy size={15} /> HELP
        </span>
        <h1>Help centre</h1>
        <p>How markets settle, what the fees are, what liquidity providers risk, and what happens when a market is invalid.</p>
      </div>

      <div className="help-search">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search payouts, liquidity, settlement…"
          aria-label="Search help articles"
        />
      </div>

      <Surface resource={help} label="help">
        {(data) =>
          data.results ? (
            data.results.length === 0 ? (
              <p className="muted-note">{data.empty_reason}</p>
            ) : (
              <ul className="help-results">
                {data.results.map((item) => (
                  <li key={item.slug}>
                    <a href={`#${item.route}`}>
                      <strong>{item.title}</strong>
                      <small>{item.excerpt}</small>
                    </a>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <div className="help-grid">
              {data.categories.map((category) => (
                <section key={category.id}>
                  <h2>{category.title}</h2>
                  <ul>
                    {category.articles.map((article) => (
                      <li key={article.slug}>
                        <a href={`#${article.route}`}>
                          {article.title} <ArrowRight size={14} aria-hidden="true" />
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )
        }
      </Surface>
    </main>
  );
}
