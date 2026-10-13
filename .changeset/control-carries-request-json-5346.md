---
"@a11ign/control": patch
---

`fleet-auto-off` and `fleet-status`'s test take `requestJson` from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/worker-http.ts`, a path the core's lay stopped providing at a11ign/a11ign#5175 (a11ign/a11ign#5346, step 1b of ruling B on #5335). The carried copy was already compared with the original by `worker-fleet-carried.test.ts`, which now also pins that these two import it and neither names `worker-http` by path. The closure test in `fleet-auto-off.test.ts` and the `check-worker-code` reader in `layer-checkouts.test.ts` now read the layer through its resolver and the layer's own files.
