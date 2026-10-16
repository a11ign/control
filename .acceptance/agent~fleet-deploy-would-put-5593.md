Row a11ign/a11ign#5593. `deploy-pins.json`'s `core.commit` moves to `e1beb9034967a8660533350859576b2a737f0e81` (a11ign#5591, pins `@a11ign/screenreader-worker` 0.13.4) and `layers.nvda-worker` to 0.13.4 with integrity `sha512-LjaRCrew...RIFoBg==` (`npm view @a11ign/screenreader-worker@0.13.4 dist.integrity`, read 2026-10-16, equal to the core lockfile's value). `package.json` and `pnpm-lock.yaml` move with it. No `fleet:*`, `lab:*`, `worker:*` or `gate:stability` command was run (resource ban).

Acceptance: `cd ~/repos/control && jq -r '.core.commit, .layers["nvda-worker"].version' deploy-pins.json && git -C ~/repos/a11y-witness show "$(jq -r .core.commit deploy-pins.json)":package.json | grep -n 'screenreader-worker"'` (run in the worktree `~/repos/control-wt-5593`, which is the same file until merge), then the pin tests below

**As run (measured, 2026-10-16, worktree `~/repos/control-wt-5593`):** printed `e1beb9034967a8660533350859576b2a737f0e81`, `0.13.4`, then `65: "@a11ign/screenreader-worker": "^0.13.4",` and `96: "@a11ign/screenreader-worker": "0.13.4"`.

**The row's `node --test src/layer-pins-core-lock.test.ts src/layer-pins.test.ts` cannot run:** those files import `@rstest/core` and `node --test` fails with `Rstest API 'afterAll' is not registered` (measured, also on main's files). control's own rstest `include` is `scripts/**` only, so the `src/` tests run laid over a core checkout, as `ci.yml` does. I laid this tree over `~/repos/wt-5593` (core at `c758ee1a3`, which holds `e1beb9034`) and ran `pnpm exec rstest run packages/control/src/layer-pins-core-lock.test.ts packages/control/src/layer-pins.test.ts`: both files pass. The whole `packages/control` run fails 13 tests, the SAME 13 as unmodified `origin/main` laid the same way (diff of the two failure lists empty), which are the lay's artefacts against a newer core than `CORE_REF`, not this change.

**Fails before, measured:** with the pins moved and the two tests below untouched, `layer-installed-lag.test.ts` (the `#5556` assertions quoting `0.13.1`, 5 tests) and `control-has-no-dependencies.test.ts` (`PRODUCTION CLOSURE ... IS PINNED`) failed. Both now pass.

**Mutation (measured):** `layers.nvda-worker.version` set back to `0.13.1` with the core commit unchanged: `layer-pins-core-lock.test.ts` fails with `deploy-pins.json layers.nvda-worker.version is 0.13.1, the core's pnpm-lock.yaml resolves 0.13.4`. Restored from a scratchpad copy and checked byte-identical with `diff`.

## What changed

- `deploy-pins.json`, `package.json`, `pnpm-lock.yaml`: the three pins, together. `screenreader-fleet` (0.11.0) and `lab` (`v0.1.40`) are unchanged: the core lockfile at `e1beb9034` still resolves fleet 0.11.0, and the lab-laid-copy tests are in the 13-failure baseline set unchanged.
- OUTSIDE THE ROW'S REGION, needed for main to stay green: `src/layer-installed-lag.test.ts` derives the declared release in five refusal assertions instead of the literal `0.13.1`; `src/control-has-no-dependencies.test.ts` line 169 names `screenreader-worker@0.13.4` in the pinned closure. Both fail on any worker bump otherwise.
- Not done: no deploy (a11ign#5155's), and the plane's clone moves on `fleet:deploy`'s first write (done-when 2).

Closes a11ign/a11ign#5593
