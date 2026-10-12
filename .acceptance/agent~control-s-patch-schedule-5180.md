Part of a11ign/a11ign#5180 (under a11ign#5087, ADR 0045 cut 8 and 9). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/control && bash -c '! git grep -q "lay-layer" -- ansible/patch-schedule.yml && ! git grep -q "packages/control" -- ansible/patch-schedule.yml'
```

**Before (control `origin/main` blob, `git show origin/main:ansible/patch-schedule.yml`):** 3 lines match `lay-layer|packages/control`, so the Acceptance fails. **After (this branch):** the Acceptance exits 0, and `git grep` finds no match in the playbook.

**As run:** `src/fleet-patch.test.ts` via `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-patch.test.ts'`: 30 pass, 0 fail (the `--include` is needed: the config's own `include` is `scripts/**` only). The `scripts/` suite (`pnpm test`): 40 pass in 7 files. `pnpm run typecheck`: exit 0. The playbook parses as YAML with 0 errors.

**Mutation (`cp` before, `cp` after, `diff` identical):** the unit's `--apply` removed from `ExecStart`: `src/fleet-patch.test.ts` fails 1 of 30 (the unit test). Restored: identical.

## What changed

- `ansible/patch-schedule.yml`: `patch_checkout` is `/root/control` (control's own checkout, the a11ign#5086 pattern); `ExecStartPre` drops both `lay-layer` calls and keeps the `--ff-only` merge of that checkout; `ExecStart` runs `{{ patch_checkout }}/src/fleet-playbook.ts`.
- `.changeset/control-patch-schedule-runs-from-its-own-checkout-5180.md`: `ansible/` is in CI's `releasable-paths`, so the changeset check needs an entry.

## Not done here

- `/root/control` is an ASSUMED path on the control plane. Nothing in this repository provisions a checkout there; a VERIFY row must read the installed unit after `fleet:patch-schedule` re-renders it (the row's Done-when 2).
- `fleet-playbook.ts`'s ssh side still runs ansible from `/root/a11y-witness/packages/control/ansible` (its `CHECKOUT` const). That is outside this Region; it still depends on the core's laid tree.
- The CI `ansible` job (`check-modules.py`, `ansible-galaxy`) was not run here.
- No fleet command was run.

Closes: none -- a11ign/a11ign#5180 is closed by `product-manager` at merge; a PR here cannot close a row there.
