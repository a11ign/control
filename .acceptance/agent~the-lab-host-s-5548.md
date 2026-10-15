Row a11ign/a11ign#5548 (parent a11ign#5155, waits on 5546.1). Region is `ansible/tasks/run-job.yml`, `ansible/tasks/lab-layer-checkouts.yml` (comments only) and `src/layer-control-lab.test.ts`. Fleet: no. No `fleet:*`, `lab:*`, `training:capture*`, `pnpm run worker:*`, `evidence:check`, `gate:stability` or `capture:check` was run; the live lab job is `orchestrator`'s.

Acceptance: `bash -c '! grep -q "re-lays a LAID layer" ansible/tasks/run-job.yml'`

**As run (measured, 2026-10-15):** `grep -c "re-lays a LAID layer" ansible/tasks/run-job.yml` prints `0`, the count the row asks for, but `grep -c` exits 1 on no match, and `pr:open` runs the Acceptance as a command and refused it as a failure. The Acceptance is therefore the `bash -c '! grep -q …'` form the repo's other rows use (`ansible/…`, `src/fleet-auto-off.ts`): it passes exactly when the phrase is absent, which is the same check. The lab test over the core at CI's `CORE_REF` (`c5dddb33d622e547945289b690510fa223ebcb79`, a scratch core with control laid by CI's `sync` step and the layers laid from `deploy-pins.json`): `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/src/layer-control-lab.test.ts"` gives `VERDICT pass: 34 tests in 1 file`. Full CI-style suite (`--include "packages/control/**/*.test.ts"`): 1307 passed, 2 failed, both in `control-owned/protocol-guard.test.ts`; the same two fail on unmodified `origin/main` (5be9b94) in the same scratch core, so they come from the scratch setup and not from this change. `pnpm run typecheck` clean; `pnpm run layout-check` ok (392 files). ESLint over `packages/control` in the scratch core: 0 errors (warnings pre-existing).

**Premise (row's open check):** holds in substance. At the core commit deploy-pins names, the install does not re-lay a laid tree, and the lockfile resolves `screenreader-worker` 0.13.1 and `screenreader-fleet` 0.11.0, which are the pins. Drift to flag, not fixed here: origin/main's core lockfile resolves `screenreader-worker` 0.13.3 against the pin 0.13.1.

**Head check (new test against unchanged `run-job.yml`):** 34 tests, 2 fail. The new laid-tree case fails with `tasks/run-job.yml has no task named "Which release deploy-pins.json names for each layer"`, which is a missing-task failure, not the mechanism; the mechanism-level failure at head is not separately demonstrated. The order test fails on the new marker.

**Mutations (scratch core copy only, restored by re-sync from the control worktree; restored file diffed byte-identical):**
- A, a laid tree compared against the commit form of its pin: the laid pass case fails at the post-install assert (exit 2 at `under-test.yml`).
- B, the post-install assert set to `that: true or …`: the refusal case fails with `the install resolved 1.0.0 where deploy-pins.json names 1.2.0`.

**Fix found while running:** the first run failed with `'reading' is undefined` in the assert's `fail_msg`, because a task's `vars:` is not visible to `fail_msg`. The reading and its pin are now written out in `that:` and `fail_msg:`; the test passed after it.

Closes a11ign/a11ign#5548
