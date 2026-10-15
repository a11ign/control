---
"@a11ign/control": patch
---

`fleet:deploy` judges a laid worker or fleet tree by the release the install put under `node_modules/@a11ign/<package>`, against `deploy-pins.json`'s `version`, instead of by the commit its stale `.layer-ref` tag names (a11ign/a11ign#5546, #5155): at the core's pinned commit nothing re-lays the tree, so the old post-install assertion refused every guest. A layer held as a clone is still judged by commit. `deploy-pins.json` moves to what the core commit's lockfile resolves, `@a11ign/screenreader-worker` 0.13.1 and `@a11ign/screenreader-fleet` 0.11.0 (version and integrity together), and `src/layer-pins-core-lock.test.ts` fails when the two disagree. Revert: restore the previous `deploy.yml` read and assertion and the 0.13.0/0.10.2 pins.
