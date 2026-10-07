---
"@a11ign/control": patch
---

The control plane's follow-main step (`a11y-fleet-auto-off.service`) lays `control` after it lays `screenreader-fleet`, so a move of `pinned.control.tag` in `layers.json` is followed in one tick and fleet auto-off no longer refuses `stale-checkout` until somebody lays it by hand (#3976).
