# TraderMarket livestream market UI prototype

> PROTOTYPE — throwaway UI used to answer: “What is the simplest Polymarket-like interface for a variable-duration Live Competition?”

The active product model is defined in the [Livestream Prediction Markets spec](../../docs/specs/livestream-prediction-markets.md) and [ADR 0020](../../docs/adr/0020-use-event-driven-market-gating.md). The current prototype code predates that decision and may still contain trader-specific fixture copy or timestamp-cutoff behavior; it is a structural layout experiment, not the source of truth for terminology or behavior.

The route contains three structural variants of the same Competition Market page, switchable with the floating bar or the left/right arrow keys:

- `?variant=A` — classic two-column market page (recommended)
- `?variant=B` — centered head-to-head page
- `?variant=C` — compact single-column page

Run from the repository root:

```sh
node prototype/market-ui/server.js
```

Then open `http://localhost:4173/?variant=A`.

All actions are local, in-memory demonstrations. No wallet, RPC, contract, database, or persistence is used.
