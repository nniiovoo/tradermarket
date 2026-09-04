# External livestreams

TraderMarket's MVP is the prediction layer around a creator's existing broadcast. It does not ask a creator to move their audience or hand TraderMarket custody of the video feed.

## Supported sources

| Creator pastes | TraderMarket plays |
|---|---|
| A YouTube `watch`, `live`, or `youtu.be` link for the active broadcast | The official `youtube-nocookie.com` player |
| A Twitch channel link | The official Twitch player, bound to TraderMarket's current hostname |
| A Kick channel link | The official `player.kick.com` player. Kick's embed takes no parent-hostname parameter, unlike Twitch's — confirmed against Kick's own embed documentation, not assumed from the Twitch pattern. |

The room keeps a visible link back to the original platform. An HTTPS URL from another provider is never used as an iframe source; the audience receives an explicit external link instead. An insecure, malformed, channel-only YouTube, Twitch clip, Twitch recording, or Kick site-navigation URL is not embedded. A URL that fails the HTTPS check is not offered as an external link either, and the room shows no stream at all: `href` is one of the few places a `javascript:` URL still executes, so refusing to embed a scheme without also refusing to link it would only move the problem.

## Publication flow

The existing durable publication workflow carries the creator's stream link in the slot request and commits it to the market contract:

```sh
npm run queue-question -- \
  --template tpl-participant-v1 \
  --question "Who finishes with the higher verified return?" \
  --param target=10000 \
  --stream-url "https://www.youtube.com/live/VIDEO_ID"
```

The gate and publisher keep their existing responsibilities. A video URL does not bypass template approval, source gating, participant restrictions, or the publication permit.

After `MarketCreated` is indexed, the Coordinator includes `stream_url` in the slot snapshot. The app resolves that creator-facing URL into a provider-controlled embed. The raw URL is never assigned directly to an iframe.

## Truthful status

A configured URL means only that a stream source exists. TraderMarket shows `LIVE` only when the room's playback monitor has actually measured the stream as live. When external providers do not expose a monitorable HLS manifest, the UI names the provider without claiming that the broadcast is currently live.

`TM_STREAM_PLAYBACK_URLS` (or `TM_STREAM_PLAYBACK_URL` for a single room) remains the operator's separately configured HLS health source, one per room — a creator's stream is that room's own fact, so one room's measured health is never shown as another's. Stream health is presentation-only and never opens, pauses, closes, or resolves a market. A Livestream Event Market may separately archive a complete Canonical Stream Recording as its approved source record under ADR 0025; that archive is not the playback-health signal.

## Fairness and settlement

Viewers can receive the same broadcast at different delays. Market cutoffs therefore use the approved event source and its recorded sequence/timestamp, not the player's current frame, browser clock, chat, or a participant's statement. For a Livestream Event Market, the Gate Authority records a monotonic evidence-event sequence and resolvers inspect the complete frozen Observation Window; a viewer's delayed player is still not authoritative. The disclosed stream delay is explanatory evidence only.

## Later native ingest

Native TraderMarket streaming is intentionally deferred. When usage justifies it, a managed RTMPS/SRT service can issue one creator stream key, provide low-latency playback in the room, retain recordings, and optionally relay the broadcast to the creator's existing platforms. That change must preserve creator consent, platform rights, and the separation between video context and settlement evidence.
