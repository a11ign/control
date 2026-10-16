---
"@a11ign/control": patch
---

`fleet:deploy` puts a guest on a core that pins `@a11ign/screenreader-worker` 0.13.4 (a11ign/a11ign#5593): `deploy-pins.json` moves `core.commit` from `7e751f5` (which resolved 0.13.1, the release whose junction start-up fails, screenreader-worker#66) to `e1beb9034` (a11ign#5591), and `layers.nvda-worker` to 0.13.4 with the registry's integrity; this package's own `package.json` and `pnpm-lock.yaml` move with it. `layer-installed-lag.test.ts` now derives the declared release in its refusal assertions and `control-has-no-dependencies.test.ts` pins the 0.13.4 closure entry, so the next bump moves one file.
