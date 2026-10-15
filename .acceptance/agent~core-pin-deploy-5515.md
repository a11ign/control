Row a11ign/a11ign#5515, the `deploy.yml` half: the core commit every guest is put on is DECLARED, not whatever `--ref` names. Ruling: comment 6190621810 (option 3). Change 1 (the `provision.yml` fast-forward) is #102 and is not repeated here.

Region is `ansible/provision.yml` and `src/fleet-playbook.test.ts`, as the row says.
Outside-Region: `deploy-pins.json`, `src/layer-pins.ts`, `src/fleet-playbook.ts` and `src/core-pin.test.ts`. The ruling's build shape (steps 1 to 3) cannot be made without the pin's declaration, its reader, the playbook call that hands it to the core plays, and a test that the pinned object exists on the core's remote. No `ansible/*.yml` changed: `provision-role.yml` (step 4) already reads `a11y_expected_commit | default(origin/<ref>)`, so the same `-e` pin satisfies it.

Acceptance: `A11Y_CHECK_CORE_PIN=1 node --test src/core-pin.test.ts`

(`node` strips the types itself, Node 24; `tsx` is not a dependency of this tool, so `pnpm exec tsx` is refused by `agent-org pr:open`.)

**Seed (measured, 2026-10-15T11:12:54Z):** `git ls-remote https://github.com/a11ign/a11ign.git main` gives `7e751f5682c1ad35280e24ca424bab3023fc3a40`. That is the value in `deploy-pins.json` `core.commit`.

**As run (measured, 2026-10-15, on this branch):**
- `A11Y_CHECK_CORE_PIN=1 node --test src/core-pin.test.ts` (the Acceptance): 3 passed, 0 failed, 0 skipped. The same with `pnpm exec tsx --test` also passed 3 of 3. The network test fetched the pinned commit from the core's remote and then fetched a sha nobody has pushed (`1234567890abcdef1234567890abcdef12345678`), which was refused: the positive control.
- `pnpm exec tsx --test src/core-pin.test.ts` (no env var): 2 passed, 1 skipped. The skip is the network half, by design (see below).
- `pnpm exec rstest run src/layer-pins.test.ts`: exit 0, no failed tests.
- `pnpm run typecheck`: exit 0. `pnpm run layout-check`: `ok (377 files read ...)`, exit 0. `pnpm test`: exit 0, 45 passed in 8 files.

**Pre-existing failures, not caused by this change (the files are identical to origin/main):** `src/layer-guests.test.ts` and `src/layer-control-lab.test.ts` fail with ENOENT on `packages/control/ansible/tasks/read-layer-checkouts.yml`, the core's layout, which this standalone checkout does not have (they run in the core's CI). `src/layer-checkouts.test.ts` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@a11ign/toolchain/lib/git-sandbox`.

**Rework at the review's `not convinced` (reviewer-control-103 at `8d8b1dcf`): the dispatcher wiring is now run, not regex-matched.** `startPlaybookUnit` takes its three outside reaches (ssh, the fleet lock, the core pin) as an injectable second argument, defaulting to the real ones, and reads the pin itself where it is used, so `main` carries no core value and has no call site that could hand a guest control's own commit. Two tests run it and read the command it built: `#5515: the command the dispatcher sends carries the DECLARED core commit for every core play, observed by running it` (both core plays; the pin appears once; pin, then lock, then ssh) and `#5515: a DIFFERENT pin gives a different command` (the positive control). The early read is run too (reviewer-control-103 at `88b50a60`): `main`'s first write to the control plane is `moveControlPlane`, which reads the pin and then asks ssh for the checkout, with both injectable. `#5515: a missing core pin refuses BEFORE the control plane is written to (observed by running moveControlPlane)` makes the pin read throw and asserts ssh was asked for nothing, and its positive control asserts that with a pin the order is pin, then ssh. The three older ordering assertions that looked for `ssh(controlPlaneCheckout(` in `main` now look for `moveControlPlane({`.

**As run on the rework (measured, 2026-10-15, on this branch):** `node --test src/fleet-playbook.test.ts`: 135 passed, 0 failed (re-run at the second rework). `A11Y_CHECK_CORE_PIN=1 node --test src/core-pin.test.ts`: 3 passed, 0 failed. `pnpm run typecheck`: exit 0.

**Mutation (measured, each restored from a `cp` backup and checked with `diff`):**
- (a) the reader's sha pattern loosened to `[0-9a-f]{7,40}`: `the reader refuses a core pin that cannot name one commit, and says which field` fails.
- (b) the dispatcher's call handed control's ref as the core (`guestCommitVars({ chosen, ref, core: ref })`): both `#5515` execution tests fail, and no other test.
- (c) the pin read replaced by control's value (`const core = ref;` in `startPlaybookUnit`): the same two fail, and no other.
- (d) the pin read deleted from `moveControlPlane`: `#5515: a missing core pin refuses BEFORE the control plane is written to` fails (restored from a `cp` backup).

**Why the network half is gated:** repository policy is that no test fails when the network does (`layer-pins.test.ts` header). So CI runs only the offline half. The existence of the pinned commit is therefore checked by hand, with `A11Y_CHECK_CORE_PIN=1`, before a pin moves. A commit force-pushed away after the pin was set is caught only by that gated run, not live.

**Not run here:** no `fleet:*`, `lab:*`, `training:capture*`, `worker:*`, `evidence:check`, `gate:stability` or `capture:check`. The live reading (a `fleet:deploy` that puts the boxes on the pinned commit) is `orchestrator`'s, because it is a fleet write. The pin takes effect at the next `fleet:deploy`.

Closes a11ign/a11ign#5515
