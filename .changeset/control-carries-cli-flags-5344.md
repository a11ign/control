---
"@a11ign/control": patch
---

Six control modules (`fleet-auto-off`, `fleet-converge`, `fleet-playbook`, `lab-failed-units`, `lab-pipeline`, `post-qualification-status`) take `refuseUnknownFlags` and `flagValue` from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/cli-flags.ts` (a11ign/a11ign#5344, step 1 of ruling B on #5335): a path the core's lay stopped providing at #5175. The carried copy was already compared with the original by `worker-fleet-carried.test.ts`, which now also pins that these six import it and none names `cli-flags` by path.
