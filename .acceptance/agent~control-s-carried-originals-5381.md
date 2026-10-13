Row a11ign/a11ign#5381, replacing a11ign#5374: the control Region's test files stop reaching `../../worker-fleet/src/` for the carried originals and for the `.ps1` scripts, and take the originals from `@a11ign/screenreader-fleet` at the 0.9.0 pin. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c '! git grep -q -E "(\.\./)+worker-fleet/src/" -- src/worker-fleet-carried.test.ts src/control-owned/fleet-consistency.test.ts src/control-owned/fleet-env.test.ts src/control-owned/worker-port.test.ts src/control-owned/display-mode.test.ts && ! git grep -q -E "worker-fleet/src/provisioning" -- src/fleet-playbook.test.ts'
```

The Acceptance above is the PR head: the two greps over the working tree, run from the worktree. The open check and CI's acceptance job read this form.

Merge-commit reading (the row's own Acceptance, Done-when 1). It is `Hand-run`: whoever closes the row pastes its run at the merge commit. It cannot pass before the merge, because it reads `origin/main`:

```bash
bash -c 'cd ~/repos/control && git fetch -q origin && ! git grep -q -E "(\\.\\./)+worker-fleet/src/" origin/main -- src/worker-fleet-carried.test.ts src/control-owned/fleet-consistency.test.ts src/control-owned/fleet-env.test.ts src/control-owned/worker-port.test.ts src/control-owned/display-mode.test.ts && ! git grep -q -E "worker-fleet/src/provisioning" origin/main -- src/fleet-playbook.test.ts'
```

Local result of the PR-head form, run in this worktree: both greps exit 0 (`echo $?` prints `0` for each).

## Before and after

- Before (`origin/main` at 2375ca6, per the row's Open-check): the five control-owned files and `worker-fleet-carried.test.ts` reach `../../worker-fleet/src/` (13 matching lines); `fleet-playbook.test.ts` reads `worker-fleet/src/provisioning/stamp-provision-revision.ps1`.
- After (this branch): none of the five reaches `../../worker-fleet/src/`; `fleet-playbook.test.ts` reads no `.ps1` under `worker-fleet/src/provisioning`.

## What changed, and where it departs from the row's Change

- `package.json`: `@a11ign/screenreader-fleet` `0.9.0` is a devDependency (carried from 5374). `dependencies` stays `{}` (ADR 0012).
- `scripts/package-manifest.test.ts`: TOOLING names the devDependency.
- `src/worker-fleet-carried.test.ts` and `src/worker-fleet-carried.ts`: originals from the package subpaths. **Departs from the row's Change:** the `edgeUpdaterGuard.state` re-carry (`valueAt`, its `REPORTED_ONLY` entry, and their tests) is left out. CI resolves `@a11ign/screenreader-fleet` 0.7.3 from core's lock, which has no `edgeUpdaterGuard`, so the re-carry turned three Region files red (control#88, run 38357258613). The row's done-when 1 is green at the old pin; ceo ruled the re-carry rides with the pin bump in a11ign/a11ign#5312.
- `src/control-owned/fleet-env.test.ts`, `fleet-consistency.test.ts`, `worker-port.test.ts`: originals from `@a11ign/screenreader-fleet/*`.
- `src/control-owned/display-mode.test.ts`: **departs from the row.** The row said delete the file. It was diffed against upstream `screenreader-fleet` `src/display-mode.test.ts` (on `main`; the file is absent at v0.9.0): upstream has source-text assertions only. The YAML and `tasks.yml` tests (19) are control-only and are KEPT. The `pwsh` runtime section (`HARNESS`, `pwsh()`, `enumerations()`, the AST helpers) is removed, because `display-mode-harness.ps1` ships in no published tarball. Runtime checks of the script that control's suite ran before this PR are no longer run.
- `src/fleet-playbook.test.ts`: **departs from the row.** The row said drop the stamp test (`stamp-provision-revision.ps1`) because upstream `provision-stamp.test.ts` covers it. It does not: upstream `main` lacks the no-SHA-in-stamp assertion and the `provision-commit.txt` assertion this test makes. The test is KEPT; it now reads the script from the package's `src/provisioning`, so the Acceptance's second grep passes. Its assertions are unchanged.
- `src/fleet-playbook.test.ts:37`: `protocol-guard.ts` by path is deliberately left. It is blocked on a11ign#5312, which carries the pin bump to 0.11.0 (the first version that exports `./protocol-guard`).

## Verification

- `pnpm typecheck`: exit 0.
- `pnpm test`: 44 tests in 8 files pass. This runs `scripts/` only; the `src/` files are not under the rstest config.
- `node --test src/control-owned/display-mode.test.ts`: 19 pass.
- The other four Region files (`worker-fleet-carried`, `fleet-env`, `fleet-consistency`, `worker-port`, `fleet-playbook`) need the layer layout (`packages/control` beside `packages/nvda-worker` and `packages/screenreader-fleet`). Not run here; the 5374 worker ran them at 171/171 in a scratch layout before the `.ps1` drops. Their CI run in a11y-witness core is the check that they still pass after this branch.

## Left on the same grep, outside this row's Acceptance

Not touched here; each is another row's work:

- `src/fleet-playbook.ts:83`, `src/fleet-playbook.test.ts:37` (a11ign#5312).
- `src/control-owned/doctor.test.ts:10-11`, `lab-job-lock-two-rows.test.ts:41`, `lab-job.test.ts:13` (worker-fleet paths, not in the six-file Region).
- `src/control-owned/provision-stamp-inputs.test.ts:75` reads `worker-fleet/src/provisioning/stamp-provision-revision.ps1` (a11ign#5373).

## Closes

Closes a11ign/a11ign#5381
