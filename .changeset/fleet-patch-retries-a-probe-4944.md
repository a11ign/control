---
"@a11ign/control": patch
---

Carries `a11ign/a11ign` #4944 (parent #4405): `probeWorker` retries once when either endpoint fails before it counts a box unreachable, so `fleet:patch` no longer refuses a fleet it could reach on one `socket hang up` (a11ign#4937's live run refused two boxes that answer in 11 ms).
