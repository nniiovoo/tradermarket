import { BadgeCheck, Droplets, Gavel, Radio, ShieldCheck, Undo2 } from "lucide-react";

/**
 * What TraderMarket does that a plain prediction app does not.
 *
 * These are the protocol's real, verifiable properties, so they belong in the
 * product rather than only in the docs: a person deciding whether to supply
 * liquidity or trust a settlement should be able to read the actual rules on
 * the page they are standing on.
 */
const POINTS = [
  {
    icon: Droplets,
    title: "Anyone can be the market maker",
    body:
      "There is no house. Public liquidity providers supply the market and earn its 0.3% Liquidity Fee pro rata. " +
      "Liquidity is per-market and locked until that market resolves, and inventory risk is real — the fee " +
      "guarantees nothing.",
  },
  {
    icon: BadgeCheck,
    title: "1% goes to the winning participant",
    body:
      "On participant and race questions, 1% of each purchase forms a whole-market reward paid to whichever " +
      "competitor wins. Threshold questions carry no participant reward at all, because Yes and No are not people.",
  },
  {
    icon: ShieldCheck,
    title: "Competitors and insiders cannot trade their own market",
    body:
      "Both competitors, their reward addresses, disclosed related and insider wallets, the source gate, the " +
      "publisher and the resolvers are restricted wallets. The contract refuses their trades and their liquidity — " +
      "this is enforced in code, not promised in policy.",
  },
  {
    icon: Radio,
    title: "The stream is context; approved data settles",
    body:
      "Markets settle from an approved data source. A broken livestream never suspends a market, and a healthy " +
      "livestream never makes a stale data feed safe. Stream health, source freshness and your connection are shown " +
      "as three separate signals.",
  },
  {
    icon: Gavel,
    title: "Integrity Bonds and challenges",
    body:
      "Each competitor posts a bond for the whole session, released only after every question settles and the " +
      "integrity claim window passes. Anyone can bond a challenge against a provisional result, and an unreviewed " +
      "challenge fails closed rather than standing.",
  },
  {
    icon: Undo2,
    title: "Sell early, claim separately, refund when invalid",
    body:
      "You can sell a position before resolution at the market price. Redemptions, LP inventory, LP fees, the " +
      "participant reward and invalid-market refunds are each claimed separately by their owner. If a market cannot " +
      "be resolved it becomes Invalid: collateral returns and the 1% you paid is refunded.",
  },
];

export function Differentiators() {
  return (
    <section className="differentiators" aria-labelledby="differentiators-heading">
      <div className="section-heading">
        <div>
          <ShieldCheck size={19} />
          <h2 id="differentiators-heading">How TraderMarket is different</h2>
        </div>
      </div>
      <div className="differentiator-grid">
        {POINTS.map(({ icon: Icon, title, body }) => (
          <article key={title}>
            <Icon size={20} aria-hidden="true" />
            <h3>{title}</h3>
            <p>{body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
