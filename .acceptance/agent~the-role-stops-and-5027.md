Part of a11ign/a11ign#4405 (row a11ign/a11ign#5027, pointed at by a11ign#4948). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5027-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/edge-updater-before-install.test.ts' --include 'src/fleet-layer/edge-pin-parity.test.ts' --include 'src/fleet-layer/provision-stamp-inputs.test.ts'
```

**As run here (2026-10-11):** the row's command as written (`cd /home/agent/repos/control && pnpm exec rstest run src/fleet-layer/...`, no `--config`) cannot run: the primary checkout has no `rstest` binary, and the default config has no `node:test` shim (`No test suites found in file`). With the toolchain config, `edge-updater-before-install.test.ts` passes (7 of 7) and so does `edge-updater-guard.test.ts` (7 of 7, run for the role file it also reads). `edge-pin-parity.test.ts` and `provision-stamp-inputs.test.ts` cannot load in this checkout: they read the `a11ign/a11ign` monorepo layout (`/home/agent/packages/control/...`, `../../../guards/src/walk-scope.ts`), and that layout is not on this machine. Both fail on the path before reading any file this change touches, so the failure is the layout, not the change. They are the first thing to check in a full checkout.

## What changed

- `ansible/roles/worker/tasks/edge-version.yml`: the two updater tasks, repeated after "Complete the launcher rename..." and before the guard registration and the closing refusal. Names: "Stop and disable EVERY Edge-updater scheduled task again, after the install" and "Stop and disable the updater's services again, after the install". Bodies copied from the early pair (stop before disable; by prefix). Unconditional, not gated on an install having run.
- `src/fleet-layer/edge-updater-before-install.test.ts`: the late pair must sit after the rename and before the closing assertion; controls delete the pair and move it after the refusal, each turning the assertion red.
- `.changeset/edge-updater-stopped-after-install-5027.md` (patch).

## Mutations (`cp` before, `cp` after, `cmp` identical)

- Baseline `origin/main` role file under the new test: 3 red (the late-pair position, the deletion control, the move-after-refusal control).
- Real file with the late pair deleted: the positive assertion fails with `task not found`.
- Real file with the late pair moved after the refusal: 2 red (the closing-order test and the late-pair assertion).
- Unmutated: 14 of 14 across the two files.

## Consequences this change carries

- **`provisionRevision` moves.** The role file is a hashed provisioning input and a capture cache key, so the fleet reads INCONSISTENT until a whole-fleet `fleet:provision --serial=0` runs. That run is the orchestrator's, and it is not run here. Reported on a11ign/a11ign#4405.
- **Revert in one line:** delete the late pair from `edge-version.yml` (the two `again, after the install` tasks) and the test's late-pair assertion with it. The role then reads as it does on `origin/main`.
- **The live proof is not in this row.** A box that installs Edge this run should end with the updater off; that is seen only on a real Windows worker, at the next Edge pin change or a rollback. It is filed as a VERIFY row by the orchestrator.

Closes a11ign/a11ign#5027
