---
"@a11ign/control": patch
---

A test now fails when any script `a11y-fleet-auto-off.service` runs is absent from the core the package is laid into. The follow-main step's `-` prefix hid `Cannot find module` on every firing from a11ign/a11ign#4268 (which renamed `scripts/lay-layer.mjs` to `.ts`) until the unit was repointed, so a move of a layer pin was not followed in one tick; the test is what would have caught it (#4571).
