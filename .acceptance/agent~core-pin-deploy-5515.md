Row a11ign/a11ign#5515, the `deploy.yml` half: the core commit every guest is put on is DECLARED, not whatever `--ref` names. Ruling: comment 6190621810 (option 3). Change 1 (the `provision.yml` fast-forward) is #102 and is not repeated here.

Region is `ansible/provision.yml` and `src/fleet-playbook.test.ts`, as the row says.
Outside-Region: `deploy-pins.json`, `src/layer-pins.ts`, `src/fleet-playbook.ts` and `src/core-pin.test.ts`. The ruling's build shape (steps 1 to 3) cannot be made without the pin's declaration, its reader, the playbook call that hands it to the core plays, and a test that the pinned object exists on the core's remote. No `ansible/*.yml` changed: `provision-role.yml` (step 4) already reads `a11y_expected_commit | default(origin/<ref>)`, so the same `-e` pin satisfies it.

Acceptance: `A11Y_CHECK_CORE_PIN=1 pnpm exec tsx --test src/core-pin.test.ts`

**Seed (measured, 2026-10-15T11:12:54Z):** `git ls-remote https://github.com/a11ign/a11ign.git main` gives `7e751f5682c1ad35280e24ca424bab3023fc3a40`. That is the value in `deploy-pins.json` `core.commit`.

**As run (measured, 2026-10-15, on this branch):**
- `A11Y_CHECK_CORE_PIN=1 pnpm exec tsx --test src/core-pin.test.ts`: 3 passed, 0 failed, 0 skipped. The network test fetched the pinned commit from the core's remote and then fetched a sha nobody has pushed (`1234567890abcdef1234567890abcdef12345678`), which was refused: the positive control.
- `pnpm exec tsx --test src/core-pin.test.ts` (no env var): 2 passed, 1 skipped. The skip is the network half, by design (see below).
- `pnpm exec tsx --test src/fleet-playbook.test.ts`: 132 passed, 0 failed, 0 skipped.
- `pnpm exec rstest run src/layer-pins.test.ts`: exit 0, no failed tests.
- `pnpm run typecheck`: exit 0. `pnpm run layout-check`: `ok (377 files read ...)`, exit 0. `pnpm test`: exit 0, 45 passed in 8 files.

**Pre-existing failures, not caused by this change (the files are identical to origin/main):** `src/layer-guests.test.ts` and `src/layer-control-lab.test.ts` fail with ENOENT on `packages/control/ansible/tasks/read-layer-checkouts.yml`, the core's layout, which this standalone checkout does not have (they run in the core's CI). `src/layer-checkouts.test.ts` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@a11ign/toolchain/lib/git-sandbox`.

**Mutation (measured, both directions, each restored from a `cp` backup and checked with `cmp`):**
- (a) the reader's sha pattern loosened to `[0-9a-f]{7,40}`: `the reader refuses a core pin that cannot name one commit, and says which field` fails (a 12-character sha is accepted).
- (b) `main` passes control's own sha as the core pin (`const core = expected;`): `#5512/#5515: both core plays are handed the declared core commit, never control's` fails, and 131 of the other tests pass.

**Why the network half is gated:** repository policy is that no test fails when the network does (`layer-pins.test.ts` header). So CI runs only the offline half. The existence of the pinned commit is therefore checked by hand, with `A11Y_CHECK_CORE_PIN=1`, before a pin moves. A commit force-pushed away after the pin was set is caught only by that gated run, not live.

**Not run here:** no `fleet:*`, `lab:*`, `training:capture*`, `worker:*`, `evidence:check`, `gate:stability` or `capture:check`. The live reading (a `fleet:deploy` that puts the boxes on the pinned commit) is `orchestrator`'s, because it is a fleet write. The pin takes effect at the next `fleet:deploy`.

Closes a11ign/a11ign#5515
