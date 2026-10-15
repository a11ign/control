Row a11ign/a11ign#5546: `fleet:deploy` refused a laid worker tree after the install, because nothing re-lays the tree at the core's pinned commit, so the post-install pin assertion could not pass. Ruled by `ceo` on a11ign/a11ign#5155 (option b): a laid tree is judged by the release under `node_modules/`, a clone keeps the commit assertion, and `deploy-pins.json` moves to what the core commit's lockfile resolves.

Acceptance:

```bash
cd ~/repos/control-wt-5546 && pnpm exec rstest run src/layer-pins-core-lock.test.ts src/layer-pins.test.ts
```

Hand-run: `src/layer-control-lab.test.ts`, `src/control-has-no-dependencies.test.ts`, `src/control-owned/edge-pin-parity.test.ts` and `src/layer-checkouts.test.ts` need the core's layout (`packages/control` beside `packages/nvda-worker`), so they run as `ci.yml` runs them: this repository laid over a checkout of the core at `CORE_REF` (`c5dddb33`), the two layers and the lab cloned at the tags `deploy-pins.json` names, then `rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/src/<file>"`.

**As run (measured, 2026-10-15, on this branch):**
- The Acceptance above, in this checkout: 21 passed, 0 failed, 1 skipped. The skip is `layer-pins-core-lock.test.ts`'s real-commit case, which names its reason in its title: this checkout does not hold core commit `7e751f5`, and the commit is fetched on CI only.
- The seven files above laid over a core worktree at `c5dddb33` (the commit object `7e751f5` present there): `VERDICT pass: 98 tests in 7 files (2 skipped)`, and the real-commit case RAN and passed. The two skips are the pre-existing network half of `core-pin.test.ts` and one older case.
- `eslint --no-ignore --quiet packages/control` on that laid core: no errors. `tsc --noEmit -p tsconfig.control.json`: no output. `pnpm test` and `pnpm run typecheck` in this checkout: 45 passed in 8 files, exit 0.

**Positive control, at `1d4c831` (measured by running the new tests against the old text):**
- `src/layer-pins-core-lock.test.ts`'s real-commit case fails with the pins at 0.13.0/0.10.2 (one of six fails; the other five need no commit and pass).
- The new laid-tree case in `src/layer-control-lab.test.ts` fails under the old shape, which is mutation M2 below (a laid tree judged by commit again).

Mutation: M1, M2 and M3 below, each broken, run, and restored from a `cp` backup checked with `diff`.

**Mutation (each restored from a `cp` backup and checked with `diff`):**
- M1, `deploy-pins.json` versions put back to 0.13.0/0.10.2: only `every layer's version is the one the core's pnpm-lock.yaml resolves at core.commit` fails.
- M2, the post-install assertion never takes the `version` branch (`if false else`): only the laid-tree case fails.
- M3, the assertion replaced by `that: true`: the laid-tree case and the clone case both fail (the wrong-release refusal and the wrong-commit refusal each break their own test), and no other.

**Integrity (done-when 2), read 2026-10-15 from the registry and the core lockfile at `7e751f5682c1`:**
- `npm view @a11ign/screenreader-worker@0.13.1 dist.integrity` prints `sha512-DG1Ws9bkEt3Hxqeh45bMg5o/jTWbg1ybwnMfS8HWnsln7Et6ZPce4b2Lrs1TPdtkhUf802lmw0GRWDKN2n0jfw==`
- `npm view @a11ign/screenreader-fleet@0.11.0 dist.integrity` prints `sha512-V4fNZjEToXfX2seAqgb2mAwKTf8/oRPBLsO8EEhnHDJzD/bLGe3jtB4lmtd9vbxQrLRKZW7OcdjUS80NBnmdvQ==`

**Not run:** no `fleet:*`, `lab:*`, `training:capture*`, `worker:*`, `evidence:check`, `gate:stability` or `capture:check`. The live reading (a `fleet:deploy --limit=a11y-worker-5`) is `orchestrator`'s on a11ign/a11ign#5155. The registered task's action (`ansible/roles/worker/tasks/tasks.yml:33`) is outside this row, as ruled.

**Found beside the Region, not changed:** `ansible/tasks/run-job.yml`'s post-install read (line 342) makes the same assumption for the LAB host: it resolves a laid tree's tag with `git ls-remote` and compares it with `lab_layer_commits`/`layer_refs`, on the claim that the install re-lays it (`run-job.yml:267`). That is outside this row's Region and is filed as its own row.

Closes a11ign/a11ign#5546
