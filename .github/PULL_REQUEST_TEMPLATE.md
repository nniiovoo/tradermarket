## What this changes

<!-- The behaviour that is different afterwards, not the files touched. -->

## Why

<!-- The problem. If it is a bug, what went wrong and under what conditions. -->

## How it was verified

<!-- Commands run and their results. "Tests pass" is not a result; a count is. -->

- [ ] `forge test` in `contracts/` (if contracts changed)
- [ ] `npm test` in `services/live-room/` (if the service changed)
- [ ] `npm test` in `prototype/live-market-app/` (if the app changed)
- [ ] A test that fails without this change and passes with it

## Money paths

<!-- Delete if untouched. Otherwise: what an incorrect version would cost a
     forecaster, a liquidity provider, or a participant. -->

- [ ] This change cannot move funds, or the path that can is covered by a test
