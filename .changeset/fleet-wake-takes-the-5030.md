---
"@a11ign/control": minor
---

`fleet:wake` takes the fleet lock for the boxes it woke, so the provision or patch typed next meets them awake (a11ign/a11ign#5030, #4405 item 2). After a wake in which at least one box ended `ready` (`woken`, `already-up` or `came-up`), the command takes `runs/fleet-lock.json` with operation `wake`, running to `now + LOCK_GRACE_MS`; with no box ready it takes none, and `wakeFleet`, the library call `lab:job` and the scripted run make, takes none. A fresh `wake` lock is a keep and not a claim: `fleet:deploy`, `fleet:provision` and `fleet:patch` end it under its holder's name and take their own instead of refusing, while a fresh lock of one of those three still refuses a different one. Cost: a box woken by `fleet:wake` and then left alone stays awake until the grace has passed. Revert: drop the `keepWokenBoxes` call in `fleet-wake.ts`'s `main`; auto-off then reads as it does today.
