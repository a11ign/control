---
"@a11ign/control": patch
---

The control plane's follow-main step (`a11y-fleet-auto-off.service`) runs `scripts/lay-layer.ts` under the `tsx` loader `ExecStart` already names, instead of `scripts/lay-layer.mjs`, which the core no longer holds: every firing logged `Cannot find module` behind the `-` prefix, so a move of a layer pin was not followed in one tick. A test now fails when any script the unit runs is absent from the core it is laid into (#4571).
