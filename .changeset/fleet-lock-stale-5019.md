---
"@a11ign/control": patch
---

A fleet lock whose holder died is posted on the off-fleet ledger (a11ign/a11ign#5019, #4405 item 2): a lock past its `expiresAt` with no `endedAt` gets one `fleet-lock: <operation> stale since <time>` line, posted once and not repeated, and dropped when the lock reads `none` or is taken afresh. A held lock and an ended lock are quiet; an unreadable lock is one constant `fleet-lock: unreadable` line and is never quiet, and an unread lock carries its standing line (`src/fleet-watch.ts`). Revert: drop `fleetLockTick` from `recordOffFleet` and the `fleetLock` option from `main()` in `src/fleet-watch.ts`.
