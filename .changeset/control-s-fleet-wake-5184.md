---
"@a11ign/control": patch
---

`fleet-discover.ts`, `fleet-status.ts` and `with-control-plane-fleet.ts` no longer import the core's `worker-fleet` by relative path (a11ign/a11ign#5184, found at #5183). The helpers they used (the `/health` read, the inventory group reader, the flag refusal, the health assessment and the fleet-consistency comparison) are carried in `src/worker-fleet-carried.ts`, pinned to their originals by `worker-fleet-carried.test.ts`. Revert: restore the nine `../../worker-fleet/src/` imports in the three files and delete the two new files.
