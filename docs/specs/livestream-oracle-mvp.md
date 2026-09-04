# Livestream Event Resolution MVP

Status: Implemented locally on testnet

Decision: [ADR 0025](../adr/0025-use-canonical-broadcast-evidence-for-observable-livestream-events.md)

## Outcome

TraderMarket can now resolve a narrow objective Livestream Event Market without giving the API unilateral settlement power. The working reference question is:

> Who appears first on a named creator's livestream: the first guest or the second guest?

The question freezes the exact official broadcast, Observation Window, qualification rule, two outcomes, tie/Invalid behavior, Resolver Set, Challenge Window, and source/gate policy before forecasting opens. A person qualifies only under the published rule; audience opinion, a creator statement, a mutable VOD URL, and an isolated winning-moment highlight are insufficient.

## Safety model

The implementation preserves four authority boundaries:

1. The evidence API archives and hashes a complete recording. It holds no chain key.
2. The Source Gate Authority closes forecasting with a monotonic event sequence. It cannot select the final outcome.
3. Two distinct frozen resolver wallets independently review the same complete recording and attest the same outcome and Evidence Bundle hash. One wallet cannot reach quorum.
4. A Forecaster may submit an on-chain bonded Resolution Challenge. Two resolver verdicts are required; an accepted or unanswered challenge makes the market Invalid under the existing contract.

The Coordinator remains a projection. It does not upload on behalf of a resolver, sign a result, receive an order, custody Collateral, or move funds.

## Resolution flow

```text
Frozen question + exact official broadcast + Observation Window
                         |
              observable event occurs
                         |
   Gate Authority irreversibly closes forecasting
   (overlapping/unsafe Forecasting Epoch refunds)
                         |
  operator archives complete MP4 + focused review window
                         |
  canonical JSON + recording SHA-256 -> keccak256 evidence hash
                         |
        Resolver wallet 1 independently attests
        Resolver wallet 2 independently attests
                         |
                Provisional Result
                         |
              frozen Challenge Window
                 /               \
        no challenge          bonded challenge
             |                /             \
 permissionless finalize  rejected       accepted/unanswered
             |                |                  |
          Resolution       Resolution       Invalid Market
```

## Canonical Evidence Bundle

The on-chain `evidenceHash` is `keccak256(UTF8(canonicalJson))`. Version 1 contains exactly, in fixed order:

- `schema`: `tradermarket.livestream-evidence.v1`
- `market`: lower-cased market contract address
- `outcome`: Participant A, Participant B, Tie, or Invalid enum value
- `source_sequence`: the immutable Session Event sequence the Gate Authority uses to close forecasting; it is committed inside the resolver evidence hash
- `stream_url`: exact HTTPS official stream page
- `occurred_at`: normalized UTC timestamp
- `clip_start_ms` and `clip_end_ms`: a focused review window inside the recording, limited to 120 seconds
- `rule`: the frozen objective rule
- `rationale`: the resolver's rule-based explanation
- `recording_sha256`: SHA-256 of every byte in the uploaded MP4

The uploaded MP4 must cover the complete frozen Observation Window. The focused window is only a shortcut to the claimed event. For “first” questions, resolvers must still inspect everything from the opening watermark through that window. If the complete interval is unavailable or ambiguous, they refuse to attest and the contract's unresolved deadline leads to Invalid.

## Evidence service

Configuration:

- `TM_DATA_DIR`: durable SQLite and `oracle-proofs/` recording directory
- `TM_ORACLE_OPERATOR_TOKEN`: upload authentication; never returned by capabilities or logs
- `VITE_ROOM_API_URL`: website origin for public proof retrieval and operator upload

HTTP surface:

- `POST /v1/oracle/proofs?...` — token-authenticated raw `video/mp4`, maximum 250 MiB
- `GET /v1/oracle/markets/:market` — latest public bundle for a market
- `GET /v1/oracle/evidence/:hash` — public bundle by on-chain hash
- `GET /v1/oracle/proofs/:id/video` — public range-capable MP4 playback
- `POST /v1/oracle/challenges` — register a counter-evidence reference only after decoding and verifying its successful on-chain `challengeResult` transaction
- `GET /v1/oracle/markets/:market/challenge` — public verified counter-evidence reference for resolver review

Uploads reject invalid addresses, outcomes, HTTPS sources, timestamps, rules, rationales, focused-window bounds, non-MP4 bytes, and oversized bodies. Identical byte-and-metadata resubmission returns the original record. Recordings are created with private filesystem permissions; public access goes through the evidence endpoint.

## Product surfaces

- `#/oracle` is the resolver console. It uploads the recording, displays its exact hash, detects whether the connected wallet is a frozen Resolver or Gate Authority, closes forecasting from the gate wallet, submits resolver attestations, records challenge verdicts, and exposes permissionless deadline actions.
- The market page displays the public evidence recording, proposed outcome, frozen rule, event time, focused window, and evidence hash.
- The existing Challenge sheet submits the fixed 10 test-USDC bond directly from the Forecaster's wallet to the market contract. After confirmation it registers the evidence reference; the API accepts it only when the named transaction successfully called this market's `challengeResult` with the same hash. This preserves the bond as the anti-spam boundary and gives resolvers the preimage/reference needed to review the hash.

## Current contract behavior preserved

- two matching result attestations from distinct frozen resolver addresses;
- fixed on-chain Challenge Window configured per market (the existing Amoy default remains 10 minutes);
- two matching challenge verdicts;
- accepted challenge: Invalid and challenge bond returned;
- rejected challenge: provisional outcome finalizes and bond goes to the frozen bond recipient;
- unanswered challenge after timeout: Invalid and bond returned;
- no resolver quorum before the deadline: permissionless Invalid;
- no API custody and no backend trading path.

## Verification

- Service tests cover deterministic commitments, durable/idempotent storage, validation, upload authentication, public retrieval, video ranges, verified challenge-call decoding, and relocatable recording backups.
- Website tests cover binary upload, the operator route, resolver/gate contract writes, full route rendering, and the production build.
- Existing contract tests cover distinct resolver quorum, Challenge Window finalization, accepted/rejected challenges, unanswered challenges, missing quorum, bond accounting, and Invalid refunds.

## Known production gaps

This is a working local/testnet MVP, not a production oracle. Production still needs genuinely independent resolver organizations, external contract/security review, object storage plus CDN for recordings larger than the local 250 MiB cap, recording provenance and takedown/retention policy, abuse controls, monitoring for archive loss, legal review, and a deployed room whose frozen roles are funded and separately controlled.
