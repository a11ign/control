Part of a11ign/a11ign#4405 (row a11ign/a11ign#5027, pointed at by a11ign#4948). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5027-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/edge-updater-before-install.test.ts'
```

**As run here (2026-10-11):** `VERDICT pass: 7 tests in 1 file`. The row's command as written (`cd /home/agent/repos/control && pnpm exec rstest run src/fleet-layer/...`, no `--config`) prints `No test suites found in file` and exits 1: control's default rstest run lacks the `node:test` shim only the toolchain config carries. The positional path without `--include` is refused by that config too (`No test files found`), so the `--include` form is the one that runs. `edge-pin-parity.test.ts` and `provision-stamp-inputs.test.ts` are not in this command: they read the layout the core lays over control (`packages/control/...`, `../../../guards/...`), load only in CI's composed job, and still gate the merge there (PM's ruling on #5027, 2026-10-11T13:14Z).

## What changed

- `ansible/roles/worker/tasks/edge-version.yml`: the two updater tasks, repeated after "Complete the launcher rename..." and before the closing refusal. Names: "Stop and disable EVERY Edge-updater scheduled task again, after the install" and "Stop and disable the updater's services again, after the install". Bodies copied from the early pair (stop before disable; by prefix). Unconditional, not gated on an install having run. The early pair stays where it was.
- `src/fleet-layer/edge-updater-before-install.test.ts`: the late pair must sit after the rename and before the closing assertion; controls delete the pair and move it after the refusal, each turning the assertion red.
- `.changeset/edge-updater-stopped-after-install-5027.md` (patch).

## Mutations (`cp` before, `cp` after, `cmp` identical)

- `origin/main`'s role file under the new test: 3 of 7 red (the late-pair position and its controls). The branch's file: 7 of 7 green. So the test fails before the change and passes after.
- Real file with the late pair deleted: 3 of 7 red.
- Real file with the late pair moved after the refusal: 2 of 7 red.
- Unmutated: 7 of 7 green.

## Consequences this change carries

- **`provisionRevision` moves.** The role file is a hashed provisioning input and a capture cache key, so the fleet reads INCONSISTENT until a whole-fleet `fleet:provision --serial=0` runs. That run is the orchestrator's, and it is not run here. Reported on a11ign/a11ign#4405.
- **Revert in one line:** delete the late pair from `edge-version.yml` (the two `again, after the install` tasks) and the test's late-pair assertion with it. The role then reads as it does on `origin/main`.
- **The live proof is not in this row.** A box that installs Edge this run should end with the updater off; that is seen only on a real Windows worker, at the next Edge pin change or a rollback. It is filed as a VERIFY row by the orchestrator.

Closes a11ign/a11ign#5027
