Part of a11ign/a11ign#4405 (row a11ign/a11ign#5308, step 1 of its Change). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5308-control && bash -c 'grep -c "KB\|\.Title\|updates | map" ansible/patch.yml' && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-layer/patch-update-naming.test.ts'
```

The grep is a reading of the file, not the behaviour: baseline at the branch point (`origin/main` `8652976`) is `0`, and it reads `2` here. **The behaviour is the rstest run**: it lifts the naming task out of the real `ansible/patch.yml` and runs it through the real `ansible-playbook` over localhost with an installed feature update, an installed cumulative and an offered-but-not-installed entry. It must name exactly the two installed ones (`localhost: installed <title> (KB <kb>)`).

## Mutation and before/after (`cp` before, `cp` after, `diff` identical)

- Before the change (`origin/main`'s `patch.yml`): `patch-update-naming.test.ts` fails `F01`, the task is absent (`the patch play must carry a task named ...`).
- Filter `selectattr('value.installed')` changed to `selectattr('value.not_installed')` in the real file: `2 of 2 tests failed` (the empty loop names nothing, and the negative control's precondition fails).
- Installed-only filter removed in the real file: `F01` fails (the offered update is named), `F02` fails on its precondition.
- Unmutated: `VERDICT pass: 2 tests in 1 file`.

## What changed

- `ansible/patch.yml`: one `debug` task after "Say what was installed", looping over the entries of `patch_updates.updates` whose `installed` is true, and printing `<host>: installed <title> (KB <kb>)`. Nothing else in the play changes.
- `src/fleet-layer/patch-update-naming.test.ts`: the behavioural test above, with its negative control.
- `.changeset/patch-names-the-installed-update-5308.md` (patch; `ansible/` is releasable).

## Not done here

- No box was patched and no fleet command was run (the resource ban). Whether `win_updates` returns `kb` as a list on this fleet's edition is NOT read; the task falls back to `none` when it does not, so a `none` on a real pass means the field is named differently and is to be read there.
- Steps 2 and 3 of the row (the BCD and setupact.log reading on worker-12, and the feature-update installer) are not in this change.
