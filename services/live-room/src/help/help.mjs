// Searchable help, support and legal surfaces (P1).
//
// The content is deliberately specific to how TraderMarket actually works —
// source-gated settlement, public LP participation, the 1% winning-participant
// reward, Integrity Bonds, challenges, and invalid-market refunds — because a
// generic help centre would teach nothing that distinguishes this product, and
// because a person about to risk collateral deserves the real mechanics.
//
// Nothing here promises legal availability, sponsorship, or production
// readiness.

const CATEGORIES = [
  {
    id: "getting-started",
    title: "Getting started",
    articles: [
      {
        slug: "what-is-tradermarket",
        title: "What is TraderMarket?",
        body:
          "TraderMarket pairs a livestreamed competition with on-chain prediction markets. Two participants compete, " +
          "an audience prices questions about the outcome, and settlement comes from an approved data source rather " +
          "than from the video. The livestream is context; it never decides a result. Everything you trade is Circle " +
          "test USDC on a public test network, which has no real-world value.",
      },
      {
        slug: "how-do-i-take-part",
        title: "How do I take part?",
        body:
          "Connect a browser wallet on the test network, accept the testnet terms, obtain test USDC, and open a live " +
          "room. You buy a YES/NO or participant outcome position with test USDC. Your wallet signs every action " +
          "directly with the market contract: this interface never takes custody of your collateral and never " +
          "receives your order.",
      },
      {
        slug: "where-do-i-watch-the-livestream",
        title: "Where do I watch the livestream?",
        body:
          "The competition creator supplies the stream link for each room. YouTube Live, Twitch, and Kick can play " +
          "inside TraderMarket when the creator allows embedding. Other secure provider links open on the provider's own " +
          "site when they cannot be embedded. A missing or broken stream never changes the market result: it is for " +
          "the audience to follow the competition, while the approved account-data source controls settlement.",
      },
      {
        slug: "what-does-it-cost",
        title: "What does it cost to trade?",
        body:
          "A purchase is split three ways. 0.3% is the Liquidity Fee, which goes to the liquidity providers who make " +
          "the market tradable. On participant and race questions a further 1% is the winning-participant reward, " +
          "which is paid to whichever competitor wins that market. The rest is your actual trade input. A sale " +
          "charges only the 0.3% Liquidity Fee — there is no second winner-reward charge when you exit.",
      },
      {
        slug: "who-pays-for-gas",
        title: "Who pays for gas?",
        body:
          "Unless a paymaster is configured for this deployment, you pay your own gas in test POL. The interface " +
          "states which of the two is true rather than assuming sponsorship. Gas is separate from your collateral: " +
          "it is never taken from your position.",
      },
    ],
  },
  {
    id: "markets",
    title: "Predictions and markets",
    articles: [
      {
        slug: "how-do-predictions-work",
        title: "How do predictions work?",
        body:
          "Each question is its own market with its own automated market maker. Buying an outcome moves its price, " +
          "and the price is the market's implied probability. A winning position redeems for $1 of test USDC each " +
          "once the market is Final. You can also sell a position before resolution at the market's current price.",
      },
      {
        slug: "what-is-a-live-room",
        title: "What is a live room?",
        body:
          "A live room is one competition session carrying a livestream and a rolling programme of questions. The " +
          "headline question runs for the whole session; shorter questions open and close inside it. Only a limited " +
          "number of questions are open at once, and a short question cannot open until the headline market has " +
          "liquidity.",
      },
      {
        slug: "what-does-market-closed-mean",
        title: "What does \"forecasting closed\" mean?",
        body:
          "When the approved source reports the event that decides a question, forecasting closes irreversibly for " +
          "that market. Any action still waiting in the overlapping epoch is refunded in full rather than executed. " +
          "This is what stops someone trading on a result the audience has already seen.",
      },
      {
        slug: "why-is-the-market-suspended",
        title: "Why is the market suspended?",
        body:
          "If the approved data source goes stale, the gate suspends the market and no new action is accepted. This " +
          "is separate from the livestream: a broken video does not suspend anything, and a healthy video does not " +
          "make a stale feed safe. The interface shows stream health, source freshness, and your connection as three " +
          "independent signals for exactly this reason.",
      },
      {
        slug: "why-did-my-action-refund",
        title: "Why was my action refunded?",
        body:
          "Actions do not execute immediately. They wait in a short epoch until the approved source proves no " +
          "decisive event happened during it. If that proof never arrives, if the price moved past your minimum " +
          "return, or if the market closed over your epoch, your collateral is returned in full and no fee is " +
          "charged.",
      },
    ],
  },
  {
    id: "liquidity",
    title: "Providing liquidity",
    articles: [
      {
        slug: "who-can-provide-liquidity",
        title: "Who can provide liquidity?",
        body:
          "Anyone eligible can. Public LP participation is a first-class part of TraderMarket rather than a house " +
          "function: there is no protocol-owned market maker. You supply test USDC to one market, receive LP shares " +
          "in that market only, and earn a pro-rata part of its 0.3% Liquidity Fee.",
      },
      {
        slug: "what-is-lp-risk",
        title: "What is the risk of providing liquidity?",
        body:
          "You hold inventory. If informed flow moves the market against your position, your inventory is worth less " +
          "at settlement than what you supplied, and the 0.3% fee does not guarantee it back. Liquidity is locked " +
          "until that market resolves. No return is guaranteed and no principal is protected.",
      },
      {
        slug: "how-do-lp-claims-work",
        title: "How do I get my liquidity back?",
        body:
          "After a market is Final you settle your inventory, which returns your share of the remaining reserves at " +
          "the resolved payout, and you claim your accumulated fees separately. A later liquidity provider does not " +
          "receive fees earned before they joined, and joining does not move the price.",
      },
    ],
  },
  {
    id: "settlement",
    title: "Settlement and trust",
    articles: [
      {
        slug: "how-are-results-decided",
        title: "How is a result decided?",
        body:
          "Results come from an approved data source, not from the livestream and not from an operator. Three " +
          "independent resolvers reconstruct the result from the raw source data, and two must agree before a " +
          "provisional result is recorded. A challenge window follows before the result is final.",
      },
      {
        slug: "what-is-a-challenge",
        title: "Can a result be challenged?",
        body:
          "Yes. Anyone can post a fixed bond to challenge a provisional result within its challenge window. " +
          "Resolvers then rule on the challenge. An upheld challenge invalidates the market, and an unreviewed " +
          "challenge also fails closed to Invalid rather than standing by default.",
      },
      {
        slug: "what-is-an-invalid-market",
        title: "What happens if a market is Invalid?",
        body:
          "If the facts cannot be verified, quorum is never reached, or a challenge is upheld, the market becomes " +
          "Invalid. Positions redeem at half each rather than one side taking everything, and the 1% winning-" +
          "participant reward you paid is refunded to you. Failing closed to Invalid is deliberate: a missing " +
          "result never becomes a default win for either side.",
      },
      {
        slug: "what-is-an-integrity-bond",
        title: "What is an Integrity Bond?",
        body:
          "Each competitor posts a bond for the whole session before any question opens. It is released only after " +
          "the session closes, every question has settled, and the integrity claim window has passed with no " +
          "unresolved claim against them. An upheld integrity claim forfeits it.",
      },
      {
        slug: "who-cannot-trade",
        title: "Who is restricted from trading?",
        body:
          "Competitors, their reward addresses, disclosed related and insider wallets, the source gate signer, the " +
          "publisher, and the resolvers are all restricted wallets on their own markets. They cannot buy positions " +
          "or provide liquidity there. This is enforced by the contract, not by policy.",
      },
      {
        slug: "market-activity-and-replay",
        title: "How do I verify a settlement myself?",
        body:
          "Every settled market has an activity record: the frozen question and its closing condition, the source " +
          "events that decided it with their sequences, the evaluator version, the resolvers who attested, any " +
          "challenge, the payout vector, and every claim transaction — each linked to chain. Re-running the archived " +
          "evaluator over the archived source log reproduces the same result.",
      },
    ],
  },
  {
    id: "account",
    title: "Account, funding and payouts",
    articles: [
      {
        slug: "how-do-i-get-test-usdc",
        title: "How do I get test USDC?",
        body:
          "Test USDC comes from a faucet, when one is configured for this deployment. You also need a small amount " +
          "of test POL to pay gas. Neither has real-world value and neither can be withdrawn for anything of value.",
      },
      {
        slug: "where-are-my-payouts",
        title: "Where are my payouts?",
        body:
          "Payouts are claims you make from the market contract after it is Final: redeeming winning positions, " +
          "settling LP inventory, claiming LP fees, the winning-participant reward, and winner-fee refunds on an " +
          "invalid market. Your portfolio lists what is claimable and your history lists what you have claimed, " +
          "each linked to its transaction.",
      },
      {
        slug: "legal-and-eligibility",
        title: "Legal and eligibility",
        body:
          "This is unaudited testnet software. The collateral is Circle test USDC on a public test network and has " +
          "no real-world value. TraderMarket is not licensed, not regulated, and makes no claim of legal " +
          "availability in any jurisdiction; legal review is not complete. Where an interface allowlist is enabled " +
          "it restricts who uses this interface only — the contracts remain open on a public test network. Nothing " +
          "here is financial, investment, or trading advice.",
      },
      {
        slug: "support",
        title: "How do I get help?",
        body:
          "Every market state, fee, and settlement record in this interface is derived from chain data you can " +
          "verify yourself through the linked transactions. If a surface disagrees with the chain, trust the chain " +
          "and report it. Report suspected vulnerabilities privately to the project owner rather than testing " +
          "against live users or other people's funds.",
      },
    ],
  },
];

export class HelpCenter {
  constructor({ categories = CATEGORIES } = {}) {
    this.categories = categories.map((category) => ({
      ...category,
      articles: category.articles.map((article) => ({
        ...article,
        category: category.id,
        route: `/help/${article.slug}`,
      })),
    }));
  }

  list() {
    return { categories: this.categories };
  }

  article(slug) {
    for (const category of this.categories) {
      const found = category.articles.find((article) => article.slug === slug);
      if (found) return found;
    }
    return null;
  }

  /** Case-insensitive search over titles and bodies, most relevant first. */
  search(query) {
    const needle = String(query ?? "").trim().toLowerCase();
    if (needle.length === 0) {
      return { results: [], empty_reason: "Enter something to search for." };
    }
    const results = [];
    for (const category of this.categories) {
      for (const article of category.articles) {
        const title = article.title.toLowerCase();
        const body = article.body.toLowerCase();
        if (!title.includes(needle) && !body.includes(needle)) continue;
        results.push({
          slug: article.slug,
          title: article.title,
          category: category.id,
          route: article.route,
          // Title matches rank above body matches.
          score: title.includes(needle) ? 2 : 1,
          excerpt: excerpt(article.body, needle),
        });
      }
    }
    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return {
      results,
      empty_reason: results.length === 0 ? `No article mentions "${query}".` : null,
    };
  }
}

function excerpt(body, needle) {
  const index = body.toLowerCase().indexOf(needle);
  if (index === -1) return body.slice(0, 140);
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "…" : ""}${body.slice(start, start + 160)}…`;
}
