---
"@a11ign/control": patch
---

`control-plane-fleet.ts` and `fleet-switch.ts` no longer reach `../../worker-fleet` (a11ign/a11ign#5190, follow-on to #5184 and parent #4425 done-when 3). The declarations they need (`WORKER_GROUP`, `groupPerLine`, the inventory readers `workersFromInventory`, `workerNamesFromInventory` and `portFromGroupVars`, and `DEFAULT_WORKER_PORT`) are carried verbatim in `src/worker-fleet-carried.ts`, each judged against its original in `src/worker-fleet-carried.test.ts`. Nothing the control plane runs changes behaviour.
