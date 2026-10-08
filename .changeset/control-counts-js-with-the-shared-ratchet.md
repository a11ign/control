---
"control-workspace": patch
---

Control counts its `.js`/`.mjs`/`.cjs` source against a committed baseline (a11ign/a11ign #4265, the adoption half of #4243). `@a11ign/toolchain` is bumped to ^0.1.4, the release that carries `./mjs-ratchet`, and `packages/control/src/mjs-ratchet.test.ts` calls `checkMjsRatchet` against `mjs-ratchet.baseline.json` at the repository root: 23 files today (22 under `packages/control/src/`, plus `scripts/rstest/rstest.config.mjs`), no exceptions. A new `.mjs` fails and is named; a drop passes and says the baseline can be lowered. No workflow file is edited: the test is picked up by the `packages/control/**/*.test.ts` step `ci.yml` already runs.
