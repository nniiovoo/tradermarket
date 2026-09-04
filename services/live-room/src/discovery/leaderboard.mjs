// Rankings from indexed facts only (P1).
//
// The previous website shipped four hard-coded rows. This replaces them with
// something derived: an account appears only because the chain credited it, and
// is ranked by the total it was actually credited. There is no XP, no season, no
// league and no volume figure here, because none of those exist on chain — and
// inventing them would make the whole leaderboard untrustworthy.

export class Leaderboard {
  constructor({ store }) {
    this.store = store;
  }

  _accounts() {
    const accounts = new Map();
    const touch = (account) => {
      const key = String(account).toLowerCase();
      if (!accounts.has(key)) {
        accounts.set(key, {
          account: key,
          credited: 0n,
          claims: 0,
          trades: 0,
          markets: new Set(),
        });
      }
      return accounts.get(key);
    };

    for (const claim of this.store.listClaims()) {
      const entry = touch(claim.account);
      entry.credited += BigInt(claim.amount ?? 0n);
      entry.claims += 1;
      entry.markets.add(String(claim.market_address).toLowerCase());
    }
    for (const trade of this.store.listTrades()) {
      const entry = touch(trade.account);
      entry.trades += 1;
      entry.markets.add(String(trade.market_address).toLowerCase());
    }
    return accounts;
  }

  /**
   * How many of an account's markets actually resolved.
   *
   * `markets.size` is every market the account touched, so an open position was
   * reported as a settled market — on the leaderboard and on the profile.
   */
  _settledCount(markets) {
    let settled = 0;
    for (const market of markets) {
      if (Number(this.store.getMarket(market)?.final_outcome ?? 0) !== 0) settled += 1;
    }
    return settled;
  }

  /** Top accounts by credited amount. Empty until settlements exist. */
  top(limit = 25) {
    const accounts = [...this._accounts().values()].filter((entry) => entry.claims > 0);
    if (accounts.length === 0) {
      return {
        entries: [],
        basis: "total credited on settled markets",
        derived_from: "indexed chain claims",
        empty_reason:
          "No settled market has credited anyone yet. Rankings appear here once real payouts are claimed on chain.",
      };
    }
    const entries = accounts
      .sort((a, b) => (b.credited === a.credited ? 0 : b.credited > a.credited ? 1 : -1))
      .slice(0, limit)
      .map((entry, index) => ({
        rank: index + 1,
        account: entry.account,
        credited: entry.credited.toString(),
        claims: entry.claims,
        trades: entry.trades,
        settled_markets: this._settledCount(entry.markets),
        route: `/profile/${entry.account}`,
      }));
    return {
      entries,
      basis: "total credited on settled markets",
      derived_from: "indexed chain claims",
      empty_reason: null,
    };
  }

  /** One account's own indexed facts. Absent accounts read as zero, not error. */
  profile(account) {
    const key = String(account).toLowerCase();
    const entry = this._accounts().get(key);
    if (!entry) {
      return {
        account: key,
        credited: "0",
        claims: 0,
        trades: 0,
        settled_markets: 0,
        derived_from: "indexed chain claims",
      };
    }
    return {
      account: key,
      credited: entry.credited.toString(),
      claims: entry.claims,
      trades: entry.trades,
      settled_markets: this._settledCount(entry.markets),
      derived_from: "indexed chain claims",
    };
  }
}
