---
"@a11ign/control": patch
---

A guest's layer move accepts a pin that is only a tag (a11ign/a11ign #4158, #4107's chain). `layer-checkouts.yml` fetched heads, checked out `main` and ran `merge --ff-only <pin>`, so a release commit that no branch holds (`screenreader-worker` `v0.4.0`, `@a11ign/screenreader-fleet@0.5.1`) was "not something we can merge", while the control plane's check (#4150) refuses `main`'s tip in its place. The task now fetches tags (`git fetch --quiet --tags origin`) and checks the pin out detached (`checkout --detach <pin>`), as the core's and the lab's moves do. The dirt report and discard and the assertion that HEAD equals the pin are unchanged.
