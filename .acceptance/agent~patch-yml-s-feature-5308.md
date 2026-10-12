Part of a11ign/a11ign#4405 (row a11ign/a11ign#5308, step 1 of its Change). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5308-control && bash -c 'grep -c "KB\|\.Title\|updates | map" ansible/patch.yml'
```

Baseline at the branch point (`origin/main` `8652976`): `0`. The number must rise above it. It is a reading of the file, not a requirement on its value.

**As run here (2026-10-12):** `2` after the change (the new task's name and its message line). The render check below is the behavioural one.

## What changed

- `ansible/patch.yml`: one `debug` task after "Say what was installed", looping over the entries of `patch_updates.updates` whose `installed` is true, and printing `<host>: installed <title> (KB <kb>)`. Nothing else in the play changes; the `win_updates` call, `patch_switch_pending`, the switch commit and the reboot are as they were.
- `.changeset/patch-names-the-installed-update-5308.md` (patch; `ansible/` is releasable).

## Checks run

- `python3 -c "import yaml; yaml.safe_load(open('ansible/patch.yml'))"`: parses, 3 plays.
- `ansible-playbook --syntax-check ansible/patch.yml`: no error (warning only: no `a11y_workers` in an empty inventory).
- Render: the new task was lifted out of the real file and run in a scratch play over `localhost` with a synthetic `patch_updates` (two installed, one not). It printed `installed Windows 11, version 25H2 (KB 5129195)` and `installed Cumulative (KB 5000001)`, and skipped the uninstalled entry. Reaches no box.
- `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/patch-playbook.test.ts'`: `VERDICT pass: 17 tests in 1 file`.

## Not done here

- No box was patched and no fleet command was run (the resource ban). Whether `win_updates` returns a `kb` list on this fleet's edition is NOT read; the task falls back to `none` when it does not, so the print is never an error, but a `none` on a real pass means the field is named differently and is to be read there.
- Steps 2 and 3 of the row (the BCD and setupact.log reading on worker-12, and the feature-update installer) are not in this change; the row says to file them as their own row.
