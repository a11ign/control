Closes a11ign/a11ign#5066 (a11ign/agent-org#888, #885 class 3). Names a workflow, so it is `lane:any` only because the row is.

Acceptance:

```bash
grep -q "release-dry-run:" /home/agent/repos/wt-5066-control/.github/workflows/ci.yml
grep -q "needs.release-dry-run.result" /home/agent/repos/wt-5066-control/.github/workflows/ci.yml
```

**As run (measured, 2026-10-11, at this head):** both exit 0. The row's own paths name `/home/agent/repos/control`, the primary checkout, which holds `main` and gains the lines only on merge; the same two greps against that checkout exit 1 today, which is the row's Open-check read the other way. The paths above are this worktree's.

## What changed

- `.github/workflows/ci.yml`: the `release-dry-run` job of a11ign/agent-org#967 (re-read from its branch `agent/a-pull-request-touching-agent-org-888` at its head, which is still open and carries the full-depth fix), and `gate` needs it and reads `needs.release-dry-run.result`, `success` only.
- `scripts/ci-composition.test.ts`: OUTSIDE the row's Region, and needed: the existing `gate` test pinned `needs: [changeset, checks, ansible]` exactly and failed at once. It now pins the four, and two tests are added (the job's shape; its toolchain being `release.yml`'s).

## Toolchain, read from THIS repository's `release.yml` call, not agent-org's

`release.yml` passes `kind: tag` and `gate-check: gate` and no `pnpm-version`, `changesets-version` or `node-version`. So: pnpm from `packageManager` (`pnpm@10.34.5`; the action's empty `version` reads it, as the release's does); Node `22` (the shared workflow's default); the repository has a lockfile, so the repository's own `@changesets/cli` runs and `CHANGESETS_VERSION: 3.0.3` (the shared workflow's default) is read only on the no-lockfile branch. A test fails if `release.yml` ever sets one of the three.

## Dropped: the consumer-install step

agent-org#967's second step (`pnpm install --frozen-lockfile --ignore-scripts` on a clone, what a11ign's `agent-org-newest-tag` does to a tag) is NOT here. Nothing installs a tag of this repository: it is published to no registry, has no dependency (ADR 0012), and a11ign's `scripts/lay-layer.ts` lays it by cloning the tag and copying the files `layers.json` names (measured: no `install` or `pnpm` in that script's lay path, `grep -n -E 'pnpm|npm |install' scripts/lay-layer.ts` names only lockfile reading).

## Evidence (run here, no fleet or lab)

- `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include scripts/ci-composition.test.ts`: `VERDICT pass: 11 tests in 1 file`; `pnpm run typecheck` clean. The workflow parses as YAML with jobs `changeset, checks, ansible, release-dry-run, gate`.
- **The job's version step, verbatim, on a scratch clone of this commit: exit 0** (`changeset v3.0.3`, `All files have been updated`).
- **The same step on a clone whose `pnpm-lock.yaml` omits the `@changesets/cli` importer: exit 1**, `specifiers in the lockfile don't match specifiers in package.json: * 1 dependencies were added: @changesets/cli@3.0.3`.
- Not yet measured: the job on GitHub's runner. Done-when 2 and 3 (green on this PR, red on a throwaway PR, a `merge_group` entry) are read from CI, and are reported on the row.

## Mutations (`cp` before, `cp` after, `cmp` byte-identical; each read through the composition test)

- `gate` drops `release-dry-run` from `needs`: 1 fails. `gate` stops reading its result: 1 fails.
- The conditional steps lose their `steps.touched.outputs.touched == 'true'` condition: 2 fail.
- A job-level `if:` is added: 1 fails. `contents: read` becomes `write`: 1 fails.
- Unmutated: 11 pass.
