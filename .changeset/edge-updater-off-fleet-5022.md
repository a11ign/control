---
"@a11ign/control": patch
---

A box whose Edge updater came back is posted on the off-fleet ledger (a11ign/a11ign#5022, #4405 item 3): each box whose worker reports `edgeUpdaterGuard` as `drift` or `stale` gets one `edge-updater: <box> <state>` line, so the box is named where it appears instead of being found by a provision across the fleet. `ok`, `absent` and the `unknown` placeholder are quiet, and an asleep box's line is carried until it reads `ok` (`src/fleet-watch.ts`). Revert: drop `...edgeUpdaterLines(status)` from `offFleetLines` in `src/fleet-watch.ts`.
