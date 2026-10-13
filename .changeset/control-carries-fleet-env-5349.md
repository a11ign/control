---
"@a11ign/control": patch
---

Six control modules (`fleet-playbook`, `fleet-discover.test`, `fleet-switch.test`, `fleet-build-incident.test`, `fleet-watch.test`, `fleet-status.test`) take `WORKER_GROUP`, `groupPerLine`, `workersFromInventory` and `fleetConsistency` (with `MUST_MATCH` and `REPORTED_ONLY`) from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/fleet-env.ts` and `fleet-consistency.ts`, paths the core's lay stopped providing at a11ign/a11ign#5175 (a11ign/a11ign#5349, the last of three steps split from #5344 under ruling B on #5335). The carried copies were already compared with the originals by `worker-fleet-carried.test.ts`, which now also pins that these modules import the copy and none names `fleet-env` or `fleet-consistency` by path.
