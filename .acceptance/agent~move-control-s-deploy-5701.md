Row a11ign/a11ign#5701. `deploy-pins.json`'s `core.commit` moves to `721e2b88e7a05b6b6fe88d5673a9f3c3a17aa796` (a11ign/a11ign#5702, row #5700, which pins `@a11ign/screenreader-worker` 0.13.13) and `layers.nvda-worker` to 0.13.13 with integrity `sha512-/23YCeJdUWTsN7bgbCwnzuDDJlELGyg3edgewvoAhj00RpfM2JmlVfXuSqCsSkbmI6//BzpylsZiWhBRpaK5Kw==` (`npm view @a11ign/screenreader-worker@0.13.13 dist.integrity`, read 2026-10-17, equal to the core lockfile's value). `package.json` and `pnpm-lock.yaml` move with it. `screenreader-fleet` (0.11.0) and `lab` (`v0.1.40`) are unchanged: the core lockfile at `721e2b88e` still resolves fleet 0.11.0. No `fleet:*`, `lab:*`, `worker:*`, `training:capture*`, `evidence:check`, `gate:stability` or `capture:check` command was run (resource ban).

Acceptance: `cd ~/repos/control-wt-5701 && jq -r '.core.commit, .layers["nvda-worker"].version' deploy-pins.json && git -C ~/repos/a11y-witness show "$(jq -r .core.commit deploy-pins.json)":package.json | grep -n 'screenreader-worker"'`, then the pin tests below

**As run (measured, 2026-10-17, worktree `~/repos/control-wt-5701`):** printed `721e2b88e7a05b6b6fe88d5673a9f3c3a17aa796`, `0.13.13`, then `65:    "@a11ign/screenreader-worker": "^0.13.13",` and `96:      "@a11ign/screenreader-worker": "0.13.13"`. The core lockfile at that commit has `'@a11ign/screenreader-worker@0.13.13'` at lines 183 and 1969.

**`node --test src/control-has-no-dependencies.test.ts` (measured):** 5 tests, 5 pass, 0 fail (`PRODUCTION CLOSURE ... IS PINNED` among them).

**The row's `node --test src/layer-pins-core-lock.test.ts src/layer-pins.test.ts ...` cannot run:** those files import `@rstest/core`, and `node --test` fails with `Rstest API 'describe' / 'afterAll' is not registered`. control's own rstest `include` is `scripts/**` only, so the `src/` tests run laid over a core checkout, as `ci.yml` does. I laid this tree into `~/repos/wt-5701` at `packages/control` and ran `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/**/*.test.ts"`: 13 of 1273 tests fail in 77 files. The failure list is IDENTICAL to the same run on unmodified `origin/main` laid the same way (`diff` empty, 13 failures each). The pin-related files (`layer-pins-core-lock`, `layer-pins`, `control-has-no-dependencies`) are not among them. The temporary laid tree was removed afterwards and the core worktree is clean.

**Typecheck (measured):** `pnpm run typecheck` in control exits 0.

## What changed

- `deploy-pins.json`, `package.json`, `pnpm-lock.yaml`: the three pins, together. Regenerated the lockfile with `pnpm install --lockfile-only --ignore-scripts`; the `@a11ign/screenreader-worker` entries are the only lockfile lines that changed.
- OUTSIDE THE ROW'S REGION, needed for main to stay green: `src/control-has-no-dependencies.test.ts` line 169 names `screenreader-worker@0.13.13` in the pinned production closure. It fails on any worker bump otherwise.
- Not in this row: `layer-installed-lag.test.ts` is gone from main (the judged-installed-layer logic now lives in `src/layer-checkouts.ts` and `src/fleet-playbook.ts`), so there is no literal `0.13.x` there to move. `CORE_REF` in `.github/workflows/ci.yml` is still `c5dddb33d` and is not moved by this row.
- Not done: no deploy (a11ign#5155's), and the plane's clone moves on `fleet:deploy`'s first write.

Closes a11ign/a11ign#5701
