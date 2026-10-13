Row a11ign/a11ign#5345, the final pull request: control keeps nothing under `src/fleet-layer/`. It closes the row. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5345-control && git fetch -q origin && ! git ls-files | grep -q "^src/fleet-layer/" && test "$(git ls-files | grep -c "^src/control-owned/")" -eq 22
```

What it reads: the head's tracked files hold no path under `src/fleet-layer/`, hold exactly 22 under `src/control-owned/` (the 14 pure renames of the first step and the 8 split files). The row's own command (`git ls-tree -r --name-only origin/main | grep -q "^src/fleet-layer/"`) reads `origin/main`, so it turns true at the merge of this pull request and not before; this one reads the head so it can be checked now.

## Where every test went (measured, 2026-10-13, by exact title against each destination's `origin/main`)

The 18 files that were not pure renames held 209 test titles at control `origin/main` 34c6695 (`git show origin/main:src/fleet-layer/<file>`, counting `test(`/`it(`/`describe(` lines with a string title). Matched against the files each destination holds today (fleet 50 files under `src/`, lab 270 under `src/packaging/`, core 92 under `packages/guards/src/`):

- 42 stay in `src/control-owned/`, same title; 135 are in screenreader-fleet, 13 in lab, 2 in core, same title.
- 17 had no same-title match. Read by hand against the destination's body: 16 are the same test retitled (`cli-flags` x2, `doctor`'s three `missingExportTargets` tests in fleet's `dist-exports.test.ts`, six `entry-points` tests in core's, `git-safe-env`, `worker-code-check`, `worker-fleet-does-not-read-control` x2) or one half of a split test: fleet carries `#2211 ... hardware reading ... exemption text` and control keeps the worker-comment half as a new test (`src/control-owned/fleet-consistency.test.ts`), because that half reads worker source.
- 1 has NO destination and is deleted here: `#1086: the two populations are counted SEPARATELY and must not overlap or lose a file` (`entry-points.test.ts` at 34c6695, lines 430-453). It asserts a property of the core's whole tracked tree (`plain + realpath'd == declared`), so it cannot be kept in control without re-creating the cross-repository read #5335 removes; core's port (#5357) has its ratchet and form tests but not this one. Filed as a row for core's owner rather than dropped silently; recoverable at 34c6695.

## Before / after (measured, this worktree, `pnpm exec rstest run --config scripts/rstest/rstest.config.ts`)

- The 8 split files, before (copies of the originals at `src/fleet-layer/` depth): `VERDICT fail: 5 of 116 tests failed in 8 files`, with `entry-points` and `no-win32-imports` failing to LOAD, so their tests did not run. After: `VERDICT fail: 6 of 39 tests failed in 8 files`. `entry-points` now loads and its 5 tests pass; the 6 failures are all environmental, below.
- Failing names, before against after: nothing fails after that did not fail before, except `no-win32-imports`' "the poison really is reachable from a real file" (it could not load before, so it could not be seen failing) and the one new worker-comment test, which fails for the same reason as the three worker-text tests around it.
- The reasons, each read from the report: the worker-text tests, `edge-pin-parity` and `doctor`'s LIVE test go up `../../../../` to the core's root and `layerSourceDir("nvda-worker")` to a layer checkout, which only the CI lay provides (`/home/agent/packages/...` does not exist standalone); `protocol-guard` imports `@a11ign/toolchain/lib/tree-wide-guard`, which the installed 0.1.7 does not export; the poison test reads `packages/lab/src/harnesses/run-spike.ts`, which is no longer under the core. All six reproduce on `origin/main`'s own files.
- The restored worker-comment test's logic was also run directly against `screenreader-worker`'s `src/server.mjs` (anchors found, `REPORTED, NEVER GATED` present, 0 undated readings, the date matcher's control reads 1). That is not the test passing in the lay.
- `pnpm exec tsc --noEmit`: no output; `pnpm run layout-check`: ok. `tsconfig.json` includes only `scripts/**/*.ts`, so neither reads `src/` tests; a one-off `tsc` with `--noUnusedLocals` over the 8 files reported no unused or undefined identifier (only the two unresolvable imports above).
- Not determined: the 8 files in a core lay. CI's own lay decides that.

## Mutation (`git add` an untracked file / `git rm --cached`, run, undo, `git status` identical)

- A file at `src/fleet-layer/x.test.ts`: first test fails, exit 1.
- One `src/control-owned/` file removed from the index: the count is 21, exit 1.

## What changed

- `src/fleet-layer/` is gone: 10 whole files deleted (`capture-body-owner`, `cli-flags`, `fleet-scripts`, `git-safe-env`, `npm-cli-executable`, `provision-stamp`, `worker-code-check`, `worker-fleet-does-not-read-control`, `worker-http-client-owner`, `worker-url`), each with every test in a merged destination; 8 files carved to their control halves in `src/control-owned/`.
- `src/control-owned/entry-points.test.ts` is a new control slice: every `src/*.ts` a `package.json` script runs does nothing when imported. Measured 11 entry points, floor 9, with a predicate positive control and a "control declares no bin" test.
- A `.changeset` entry.

## Not done here

- Nothing here widens into #5344 (control files that still import fleet modules by sibling path) or touches `with-control-plane-fleet.test.ts` / `worker-fleet-carried*`.
- No `fleet:*`, `lab:*`, `worker:*` or capture command was run.
