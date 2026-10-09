---
"@a11ign/control": patch
---

`layerPinTag` returns the tag a layer's repository really made (a11ign/a11ign #4363): `v<semver>` from the package's first flat version (`screenreader-worker` 0.3.0, `screenreader-fleet` 0.5.3), `@a11ign/<package>@<version>` before it, the rule of `scripts/lay-layer.mjs`'s `releaseTag`. `lab:job --qualify-sha` asked `git ls-remote` for `@a11ign/screenreader-worker@0.5.0`, which the remote never held, so it refused every sha pinning a flat-tagged layer; and `fleet:auto-off`'s stale-checkout guard compared a laid layer's `.layer-ref` (`v0.5.3`) with the scoped form, so it read a current tree as stale.
