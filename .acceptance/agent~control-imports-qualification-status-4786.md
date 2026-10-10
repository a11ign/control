Part of a11ign/a11ign#4519 (step 3 of 5; step 1 is lab#60, step 2 is a11ign/a11ign#4803). Names no workflow of its own beyond `ci.yml`'s `CORE_REF` line, an `Outside-Region:` the row names.

Outside-Region: .github/workflows/ci.yml (`CORE_REF` moves from 83b46f52 to 393f26a9, the merge of a11ign/a11ign#4803, whose `layers.json` pins lab v0.1.27)

Acceptance:

```bash
cd /home/agent/repos/wt-4786-control && bash -c '! git grep -n "qualification-status[.]mjs" -- src'
```

**As run (measured, 2026-10-10):** exit 0, no output. The row's fence names the primary checkout `/home/agent/repos/control`, which reads the same only after the merge, so it was run in this claimant's worktree of the repository, as the row says.

## What changed

- `src/post-qualification-status.ts` lines 45, 48, 64: `../../lab/src/gates/qualification-status.mjs` -> `.ts` (the import, and the `Outcome` and `StatusPayload` type references).
- `.github/workflows/ci.yml`: `CORE_REF` 83b46f522 -> 393f26a92 (the merge of a11ign/a11ign#4803). Read at that commit: `layers.json` pins `lab` at `v0.1.27`, and lab `v0.1.27` holds `src/gates/qualification-status.ts` beside the `.mjs` shim (`git ls-tree v0.1.27 src/gates/`). The old pin laid `v0.1.24`, which holds only the `.mjs`.
- `.changeset/control-imports-the-lab-gate-ts.md` (patch), so the per-merge release carries the import.

## Evidence (all run here, no fleet and no lab)

- Smoke import of the edited module against a scratch core laid with lab v0.1.27: loads and exports `postQualificationStatus`, `EXIT`, `renderResult`.
- `node --test packages/control/src/lab-job.test.ts` in that scratch tree (the one test file importing the poster): 80 tests, 80 pass, 0 fail.
- `tsc --noEmit -p tsconfig.control.json` over the scratch tree reports 32 errors, none naming `post-qualification-status.ts`; the scratch tree lacks the other laid layers, so CI's own typecheck is the verdict for the rest, not this.

## Mutation (`cp` before, `cp` after, `diff` identical)

- Line 64 restored to `.mjs`: the Acceptance command exits 1 and names `src/post-qualification-status.ts:64`. Unmutated: exit 0.

## Not done here

- The control tag that carries this merge does not exist until the release publishes it; the row's Done-when 2 is read from the release after the merge and named on the row. It is not `v0.3.3` or `v0.3.4`.
- #4796 touches the same `CORE_REF` line and rebases onto this (product-manager's ordering on the row).

Closes: none -- a11ign/a11ign#4786's Done-when 1 is "the Acceptance passes and the PR is merged", and a PR in this repository cannot close a row in `a11ign/a11ign`; `product-manager` closes it at merge.
