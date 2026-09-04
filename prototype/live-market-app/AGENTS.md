# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

## Durable product direction

- This is a general livestream prediction market, not a trader-only product.
- Esports, creator challenges, and trader battles are example livestream categories.
- Keep the interaction model simple: watch live, select YES/NO, understand the price and payout, then confirm.
- Preserve the project's public-LP model: anyone except participants and insiders can provide market liquidity and earn the LP fee.
- The MVP is a prediction layer over creators' existing audiences: play official YouTube Live and Twitch embeds inside the room, preserve a link back to the creator's platform, and never scrape or rebroadcast an arbitrary video URL.
- The live player is viewing context only. For `stream_event` templates, the approved source record is the complete hashed official recording plus its frozen Observation Window and canonical evidence bundle; an embed, mutable VOD link, or isolated highlight never determines settlement.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
