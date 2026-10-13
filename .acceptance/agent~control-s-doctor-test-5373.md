Row a11ign/a11ign#5373, prerequisite for a11ign/a11ign#5335 and #5312 (ceo ruling, 2026-10-13): control's tests stop reaching the core's `worker-fleet/src/doctor` and `scripts/test-support` by relative path. Two files are deleted (`src/layer-launchers.test.ts`, and `src/control-owned/doctor.test.ts`, which has nothing left once its LIVE and #2034 tests go); `src/control-owned/provision-stamp-inputs.test.ts` is trimmed to control's own Ansible role and module discovery, with the hashed list restated as a literal. Green at the OLD pin: no `package.json` or lockfile change.

Acceptance:

```bash
! git grep -q -E "(\.\./)+(worker-fleet/src/doctor|scripts/test-support)" HEAD -- src/control-owned/doctor.test.ts src/control-owned/provision-stamp-inputs.test.ts src/layer-launchers.test.ts
```

The grep is the row's own Acceptance, run on this branch's tree (`HEAD`) rather than `origin/main`, as #5346's was on its own: the row's `origin/main` form fails until this PR lands, so a pull request could never pass CI with it. The tree at `HEAD` is the tree the merge carries. The before-state is the `origin/main` row in the table below, where the same pattern prints three hits.

## Before and after (measured in the control worktree on this branch)

| check | origin/main (before) | this branch (after) |
|---|---|---|
| row Acceptance grep (`git grep -E '(\.\./)+(worker-fleet/src/doctor\|scripts/test-support)'`) | 3 hits, one per file; Acceptance exit 1 | no hits; Acceptance passes |
| `node --test src/control-owned/provision-stamp-inputs.test.ts` | `ERR_MODULE_NOT_FOUND` for `scripts/test-support/stamp-files.ts` (the file cannot load) | 4 pass, 0 fail |
| `pnpm run typecheck` (`tsc --noEmit`) | the core-path imports cannot resolve | exit 0 |
| `pnpm test` (rstest) | not measured on origin/main | 44 tests in 8 files, all pass |

`pnpm run lint` does not exist in this package (no `lint` script, no ESLint config), so there is no lint gate to run.

## Mutation (the kept test; each mutated file was restored by `cp` from a saved copy, verified with `diff`)

- Drop the `verify.yml` classification: `every task file, custom module and driver blob is HASHED or EXEMPT with a reason` fails with the `nobody has decided` message.
- Point the role root at a directory that does not exist: `discovers a non-trivial set of files` and the classification test fail. The vacuity guard catches an empty discovery.
- Put `verify.yml` in `HASHED_HERE` while it stays in `EXEMPT`: `no file is both HASHED and EXEMPT` fails.

## What changed

- `src/control-owned/doctor.test.ts`: deleted. Its `MUST_MATCH` import had one consumer left after the two named tests went: none. The LIVE test is core's (a4227ec61, #5364). The #2034 same-words test is restored by a screenreader-fleet row (a11ign/a11ign#5380), not blocking this row.
- `src/layer-launchers.test.ts`: deleted. Its subject is the core's launcher reach.
- `src/control-owned/provision-stamp-inputs.test.ts`: trimmed.
  - The `stampEnvironmentFiles` import and `hashedFiles()` (which read the core's stamp) are gone. `HASHED_HERE` is a literal of the control-owned entries of the fleet's `$ENVIRONMENT_FILES`: `ansible/roles/worker/defaults/main.yml` and `a11y_speech_viewer.ps1`.
  - Paths are re-rooted from `packages/control/` to `ansible/`.
  - The speech-viewer "must be hashed" test is deleted. The fleet's `provision-stamp.test.ts` pins the five-file list, so that assertion belongs there.
  - The header is rewritten to say what the file checks and why it cannot read the stamp; the `display.yml` and `nvda.yml` EXEMPT text is updated to match.
