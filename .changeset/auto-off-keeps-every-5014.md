---
"@a11ign/control": minor
---

Auto-off keeps every box while a fleet operation holds the fleet lock (a11ign/a11ign#5014, #4405 item 2). `fleet:deploy`, `fleet:provision` and `fleet:patch` take `runs/fleet-lock.json` on the control plane before their unit starts (`src/fleet-lock.ts`), refuse to start under a different operation's lock that has not ended, and shorten it to a 30-minute grace when their unit ends instead of clearing it, so a failed run's next attempt meets awake boxes. `fleet:auto-off` keeps every box with `fleet-lock-held` (or `fleet-lock-unreadable`) and ignores a lock past its `expiresAt`, the operation's longest run, so a crashed run cannot keep the fleet awake for ever. `sleep.yml` and the single-box plays take no lock. Revert: drop `fleetLock: readFleetLock` from `fleet-auto-off.ts`'s `main()`; auto-off then reads as before.
