Row a11ign/a11ign#5314: the feature update is downloaded before the install on a target pass. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5314-control && bash -c 'test "$(grep -c "PreDownload\|pre-download\|stage" ansible/patch.yml)" -gt 11' && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/patch-feature-stage-5314.test.ts'
```

The grep is a reading of the file, not the behaviour: baseline at the branch point (`origin/main` `7408bcc`) is `11`, and it reads `15` here. **The behaviour is the rstest run**: the verdict task is lifted out of the real `ansible/patch.yml` and run through the real `ansible-playbook` over localhost with an invented pre-download result. A failed pre-download must fail the box by name; a clean one must be skipped. The pre-download's own shape (the Upgrades category, `state: downloaded`, `ignore_errors`, the block that holds the deferral's restore) is read off the parsed playbook, because it is a Windows module that reaches no box here.

## Mutation and before/after (`cp` the file aside, edit, run, `cp` back, `diff` identical)

- Unmutated: `passedTests: 5`, `failedTests: 0`, exit 0.
- Before the change (`origin/main`'s `patch.yml`): `5` fail (`failedTests: 5`): the tasks are absent.
- The verdict's `failed` condition removed (the verdict fires on a clean pre-download): `2` fail, tests 2 (a clean pre-download is not refused) and 3 (the negative control's condition check).
- The verdict's condition replaced by `false` (the verdict never fires): `2` fail, tests 1 (a failed pre-download fails the box) and 3.
- Test 3 asserts the condition text is still in the verdict, so it fails under both mutations. It guards the mutation's shape more than it tests the behaviour; tests 1 and 2 carry the behaviour.

## What changed

- `ansible/patch.yml`: inside the deferral block, before the install: a `win_updates` pre-download of the Upgrades category (target passes only, never under `--check`), then a verdict that fails the box when that pre-download failed, printing the module's message, the per-update record and the last `Download result` lines WUA logged. The `always` still puts the deferral back.
- `src/fleet-layer/patch-feature-stage-5314.test.ts`: the behavioural test above, with its negative control.
- `.changeset/wua-stages-the-feature-update-5314.md` (patch; `ansible/` is releasable).

## Not done here

- No box was patched and no fleet command was run (the resource ban). Whether `state: downloaded` stages the feature update's media under `$WINDOWS.~BT` on this fleet is NOT read: the row's Done-when 1 is a live pass, for `orchestrator`.
- The `Download result` lines are read from the module's log, whose format is read from `win_updates.ps1` in the installed `ansible.windows` 3.3.0, not from a box.
