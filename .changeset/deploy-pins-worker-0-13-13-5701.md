---
"@a11ign/control": patch
---

`fleet:deploy` puts a guest on a core that pins `@a11ign/screenreader-worker` 0.13.13 (a11ign/a11ign#5701, the release carrying the a11ign/a11ign#5697 fix): `deploy-pins.json` moves `core.commit` from `e1beb9034` (which resolved 0.13.4) to `721e2b88e` (a11ign/a11ign#5702, row #5700), and `layers.nvda-worker` to 0.13.13 with the registry's integrity; this package's own `package.json` and `pnpm-lock.yaml` move with it. `control-has-no-dependencies.test.ts` pins the 0.13.13 closure entry.
