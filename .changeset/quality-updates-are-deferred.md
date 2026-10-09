---
"@a11ign/control": patch
---

Windows quality updates are deferred 30 days on every worker (a11ign/a11ign#4438, under #4405): `worker_update_deferral_policy` gains `DeferQualityUpdates` = 1 and `DeferQualityUpdatesPeriodInDays` = 30, Windows Update for Business's documented ceiling, beside the two feature-update values, so the patch window is the only thing that moves a box's build inside a month. The comment that called quality updates "deliberately left unrestricted" is rewritten, and `update-deferral-policy.test.ts` pins the two values, the 30-day ceiling and the absence of that sentence. `provision.yml` already reads the whole list back; it lands on the fleet at the next `fleet:provision`.
