---
"@a11ign/control": patch
---

`@a11ign/control/fleet-wake` no longer imports the core's `worker-fleet` by relative path (a11ign/a11ign#5183, found at #5176). Its `/health` read and its no-flags refusal are now its own, so the module resolves outside a core checkout. Revert: restore the two `../../worker-fleet/src/` imports in `src/fleet-wake.ts`.
