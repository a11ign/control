Part of a11ign/a11ign#4445 (parent #4405, part a). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-4445-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/patch-playbook.test.ts'
```

**As run (measured, 2026-10-09):** `VERDICT pass: 8 tests in 1 file`. The row's Acceptance as written (`pnpm exec rstest run src/fleet-layer/patch-playbook.test.ts`, no `--config`) prints `No test suites found in file`, the same fact PR #28 recorded: control's default rstest run has no `node:test` shim, which only the toolchain config carries.

## What changed

- `ansible/patch.yml`: three plays. (1) a localhost guard, `require-inventory-group.yml`, so a run matching no worker fails instead of exiting 0 (checked: an empty inventory exits 2 with its refusal). (2) `a11y_workers`, `serial: 1`, `any_errors_fatal`: refuse on `/health` `busy` (unanswered counts as busy); in a block, set `DeferQualityUpdatesPeriodInDays` to 0 (derived from the role's list; asserted to match exactly one entry) and read it back; `win_updates` with `reboot: false`; a separate `win_reboot` only when `installed_update_count > 0` and `reboot_required`, then wait for `/health` `ready`; in `always`, restore `worker_update_deferral_policy` itself (`vars_files` loads the role defaults, no copy) and read it back, so a failed install or reboot cannot leave the deferral lifted; then read `CurrentBuild.UBR` (`unreadable` if it cannot be asked) and print `<host>: <build>.<ubr>`. (3) a verdict play tagged `patch_verdict` that fails when the readable boxes are on more than one build, naming the odd ones; unreadable boxes are listed, never counted as a mismatch.
- `src/fleet-layer/patch-playbook.test.ts`: 8 tests. Structure is read off the PyYAML-parsed playbook, each predicate run on the real playbook and on a mutated copy. The verdict is run through the real `ansible-playbook` over a synthetic local-connection inventory carrying invented readings (reaches no worker); where Ansible is absent those three tests skip BY NAME.
- `src/deploy-reached-no-hosts.test.ts` (one `DISPATCHED_ELSEWHERE` entry for `patch.yml`) and `.changeset/there-is-a-playbook-4445.md` (minor; `ansible/` is releasable): both OUTSIDE the row's Region, needed because that guard fails without the entry (it did, then passed) and `ci.yml` requires a changeset. The row named these guard lists and told the claimant to fix them.

## Mutations (`cp` before, `cp` after, `diff` identical; each file read through the Acceptance command)

- `reboot: false` -> `true`: 1 fails (the reboot test only).
- `serial: 1` -> `2`: 1 fails (the serial test only).
- busy check `default(true)` -> `default(false)`: 1 fails (the busy test only).
- restore `loop` -> a literal list: 1 fails (the restore test only).
- verdict `when` never fires (`> 9`): 2 fail (two-builds and unreadable-plus-mismatch). Always fires (`> 0`): 2 fail (one-build and unreadable). Unmutated: 8 pass.

## Not done here

- **`win_updates` on this fleet's edition is NOT read.** The row asks for `--check --limit <one idle box>`, which reaches the fleet; the engineer ban forbids it. Routed to `orchestrator` on the row. Nothing in `ansible-playbook --syntax-check` / `check-modules.py` (0 problems, 454 invocations, run here, no fleet) says the module works there, and whether the Windows Update agent honours a deferral lifted by policy mid-session is also unread.
- The wider `src/` suite ran in a core worktree with this tree overlaid on the laid `control`: 9 of 898 failed, all present without these files (the sibling-layer imports of the laid copy, `cli-flags`, `layer-checkouts`); `deploy-reached-no-hosts` was the one this change moved, fixed above. `busy-worker-guard` and `bootstrap-playbooks-are-declared` pass.
- Part (a)'s first live run is row E's.

Closes: none -- a11ign/a11ign#4445's Done-when 1 is "the Acceptance passes and the PR is merged", and a PR in this repository cannot close a row in `a11ign/a11ign`; `product-manager` closes it at merge.
