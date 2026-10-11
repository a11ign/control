Row a11ign/a11ign#5028 (parent #4405). Names no workflow and no fleet change in its Region, so it is not `lane:ceo`. Not run live: no `fleet:*`, `lab:*`, `training:capture*`, `worker:*`, `evidence:check`, `gate:stability` or `capture:check` was run (resource ban), and no test reaches `fleet-playbook.ts` or `ansible-playbook` (the patch seam never spawns).

Acceptance:

```bash
cd /home/agent/repos/wt-5028-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include src/fleet-build-incident.test.ts
```

**As run (measured, 2026-10-11, control worktree, at commit 4b470af):** `VERDICT pass: 36 tests in 1 file`. `src/fleet-watch.test.ts` (the module's importer, a cycle check): `VERDICT pass: 76 tests in 1 file`. `pnpm run typecheck` (`tsc --noEmit`) is clean. Control has NO `lint` script, and its ESLint is not configured; the a11y-witness config (`eslint.config.js`) refuses files outside its tree, so the two files were copied into a11y-witness, linted, and the copy removed: `0 errors, 69 warnings`, all 69 `no-magic-numbers` in the test file (issue numbers in fixtures), and 0 problems in `fleet-build-incident.ts`.

## What changed

- `src/fleet-build-incident.ts`. `reconcileIncident` now starts the forward patch for the laggards once per incident. A NEW mixed incident is filed, then its number is read from the URL `gh issue create` prints, then the patch is started. A STANDING mixed incident with no start recorded for its number is started. The start is refused for a busy reading (`busyReasonAt`: any fleet play running, a held lock, or an unreadable lock; a stale lock is not busy), and a busy reading records nothing. The record is `runs/fleet-build-incident-state.json`, written `running` before the spawn and with the outcome after; one comment on the incident gives the outcome. The spawn is `fleet-playbook.ts --playbook=patch.yml --apply`, the same argv as `runApplyChild`.
- `src/fleet-build-incident.test.ts`: the three expectations the start changes now include `patch: null, patchHeld: null` and the fresh line count is 2. New controls: once per incident (positive and next-reading negative), a start on a filed number, a busy reading that starts on the next idle one, a held and an unreadable lock, `busyReasonAt` over each reader state, a refused and a failed start that are not retried, a dry run that says `WOULD START` and writes nothing, an unparseable filed URL held for a reading, and the not-mixed negative. The patch seam records effects in order (`record`, `patch`, `comment`) and never spawns.
- `.changeset/fleet-watch-starts-the-5028.md` (minor).

## The one-line revert, and what a refused start leaves

**Revert: make `startPatchFor` return `NO_START`** (in `src/fleet-build-incident.ts`). The incident still files, the #928 line is still posted, the line is still stopped, and dispatch still holds; only the start is gone. Nothing else in this change is needed to revert.

**What a refused start leaves behind:** a record in `runs/fleet-build-incident-state.json` with `outcome: "refused: <the REFUSING line>"` for that incident number, one comment on the incident saying so, and no retry on any later reading. The line stays stopped until the orchestrator moves the boxes or closes the incident. A failed start (non-zero, no REFUSING line) is recorded as `failed: exit <n>` and is not retried either. A watch that dies mid-run leaves `running`, which is also never retried.

## Decisions the row left open (assumptions)

- **(a)** The spawn is synchronous, so the reading that starts the patch waits for it. This is the precedent of `runApplyChild`.
- **(b)** Busy means ANY fleet play running, not only the patch's own unit. The row says "a patch unit running"; two plays on the fleet at once is what the gate forbids, so the stricter reading is taken.
- **(c)** A new incident whose URL carries no issue number is held for one reading (`patchHeld`) and tried on the next. It is not started under a guessed number.
- **(d)** A `stale` lock is not busy; a `held` lock is; an `unreadable` lock is busy (unknown is not "idle").
- **(e)** The record is written `running` BEFORE the spawn, so a watch that dies mid-run never starts a second patch. The cost: a crashed start needs the orchestrator to look at the record.
- **(f)** A dry run (no `--post`) reads the record and the busy state, writes nothing, and says `WOULD START` with its target.

## Not established

- The real `readPlaysInFlight` and `readFleetLock` are not run against a live fleet (their readers are resource-banned here). The busy paths are tested through `busyReasonAt`'s injected readers, and the readers' own shapes are pinned by type.
- The real spawn is not run. The patch entry runs only in production through `ghPatchStartDeps`; no test reaches it.
- Lint: see above. The control repo has no lint gate of its own.

## Mutation (measured, each restored from a `cp` backup, `diff` byte-identical)

| Mutation | Tests that fail |
| --- | --- |
| start guard never fires (`startPatchFor` returns `NO_START` at once) | 8, every one expecting a start: the once-per-incident positive, the filed-number start, the busy-then-idle start, the refused and failed starts, the dry run's `WOULD START`, the fresh-line count |
| once-per-incident guard always fires (record check removed) | 4, every one expecting NO second start: recorded-start-silent, next-reading, refused-not-retried, failed-not-retried |

Before/after: the pre-change source has no start at all, so mutation (a) is the pre-change behaviour for every start test, and those 8 are the tests that fail before. The new test file cannot import against the pre-change source (it names `busyReasonAt`), so it is not run against that file directly.

Closes a11ign/a11ign#5028
