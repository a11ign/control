Closes a11ign/a11ign#5029 (chairman ruling, a11ign/a11ign#4405). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5029-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/lab-job.test.ts' && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-build-incident.test.ts'
```

**As run here (2026-10-11):** `src/lab-job.test.ts` `VERDICT pass: 89 tests in 1 file`; `src/fleet-build-incident.test.ts` `VERDICT pass: 23 tests in 1 file`. The row's bare form (`pnpm exec rstest run src/lab-job.test.ts ...`, no `--config`) prints `No test suites found in file` for `fleet-build-incident.test.ts` and exits 1 although its 23 tests pass; the `--config ... --include` form is the one that runs. In THIS worktree the tests do not load as written: `src/lab-job.ts` imports `../../lab/src/gates/qualification-status.ts`, which the sibling `/home/agent/repos/lab` (at `main`) does not have (only the `.mjs`; `v0.1.27` has the `.ts`). The runs above were made in a scratch copy of this tree with `lab` laid from the composed core's `packages/lab` (`.layer-ref` v0.1.28), which is the layout the import expects. Run from this standalone worktree, the Acceptance command fails with `Cannot find module '../../lab/src/gates/qualification-status.ts'`. `pnpm run typecheck` is clean in the worktree. `pnpm run lint` does not exist in this package (its scripts are `typecheck`, `test`, `layout-check`, `changeset`), so no lint was run.

## What changed

- `src/lab-job.ts`:
  - `fleetDispatchingJobs(catalogueText)`: every catalogue job whose `workerDemand` is non-null, i.e. every job that wakes a box.
  - `fleetBuildRefusal(job, openIncident)`: a pure function returning the refusal text, or `null` to proceed. A thrown read, or a missing reader, returns the could-not-ask refusal (fail closed).
  - `runOnce` takes an `openIncident` dependency with no default, and calls the guard inside the fleet-demand branch, before the pool is resolved or any box is woken. A refusal writes stderr and `process.exit(3)`.
  - The entry point wires `openFleetBuildIncident` from `src/fleet-build-incident.ts`.
- `src/lab-job.test.ts`: a `#4405` section (positive control that the derived set is non-empty and holds `captureBearingJobs`; a refusal loop over every derived job; exact wording for capture, no-laggards, null-target, no-incident, unreadable and no-reader cases; an unreadable read through `run()`; `describe=1` and `train` not refused). Every existing `run()` call site passes `openIncident: NO_OPEN_INCIDENT`.
- `.changeset/lab-job-refuses-during-fleet-build-incident-5029.md` (`@a11ign/control` minor).

## Mutations (scratch copy, `lab-job.test.ts` against each)

- Guard call removed (`const buildRefusal = null`): 2 of 89 red.
- `fleetBuildRefusal` forced to refuse every job: 32 of 89 red.
- Unmutated: 89 of 89 green. The scratch copy was restored from the worktree and checked with `diff`.

## Refused: the catalogue jobs `workerDemand` derives as fleet-dispatching

From `ansible/lab-job.yml` via `fleetDispatchingJobs`, all refused through `lab:job` while the incident is open:

`capture-real-pages capture-only capture retrain capture-acceptance capture-acceptance-2 stability everything gate-stability capture-check evidence-check`

Not refused: `describe=1`, `train`, and every job with no fleet demand. `fleet:deploy`, `fleet:provision` and `fleet:patch` are not refused, as the row says.

## Paths that reach boxes WITHOUT `lab:job` (not covered by this guard)

- `ansible-playbook ansible/lab-job.yml` run directly: the guard is in the TypeScript entry point, not in the playbook.
- `capture-check`: a scheduled task on one box (`worker_check_task_name`, `ansible/lab-job.yml` ~line 1644), not dispatched through the playbook.
- `fleet:deploy`, `fleet:provision`, `fleet:patch`: outside the row's Region and not refused by the row.

## Revert in one line

Delete the `const buildRefusal = fleetBuildRefusal(job, openIncident);` guard block in `runOnce` (`src/lab-job.ts`). The incident module and the tests then stand without a caller; the `openIncident` wiring at the entry point is inert without the guard.
