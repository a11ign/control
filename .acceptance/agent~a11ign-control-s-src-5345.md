Row a11ign/a11ign#5345, FIRST pull request (the 14 control-owned files, which wait on no other row). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5345-control && git fetch -q origin && test "$(git diff -M100% --name-status --diff-filter=R origin/main...HEAD | grep -c "^R100.src/fleet-layer/.*src/control-owned/")" -eq 14 && test "$(git diff --name-status origin/main...HEAD | grep -vc "^R100")" -eq 1
```

What it reads: 14 files left `src/fleet-layer/` for `src/control-owned/` as a PURE rename (git's `R100`: not one byte of any of them changed, which is what the row's "change nothing else in them" asks), and the one other path the diff holds is this file. It does not read the tests' own behaviour; that is the next section.

## Before / after (measured, 2026-10-13, this worktree at control `origin/main` f0d4cbb)

`pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include <each of the 14>`, at `src/fleet-layer/` before the move and `src/control-owned/` after:

- Before: `VERDICT fail: 3 of 62 tests failed in 14 files`. After: the same line, and the same set of failing test names (the md5 of the sorted `fullName` lists of the two JSON reports is equal).
- The 3 failures are NOT this change's and are the same before and after: `worker-port.test.ts` and the reads in `lab-job`, `node-pin-parity`, `profile-origin-writer` and `provision-stamp-inputs` go up `../../../../` to the core's root, which only the CI lay (`control/src` copied into the core's `packages/control/`) provides; run from the standalone checkout they read `/home/agent/packages/control/...`. The depth is the property the move keeps: `src/control-owned/` is a sibling of `src/fleet-layer/`.
- `pnpm exec tsc --noEmit`: no output.
- Not determined: the same 14 in a core lay. Two attempts at a hand-made lay under `node --test` failed before reaching the tests (the first on `Cannot find package 'yaml'`, the second not diagnosed); CI's own lay is what decides it.

## Mutation (`cp` the file aside, edit, run, `cp` back, `diff` identical)

- A moved file edited by one byte: the rename reads `R099`, the first count is `13` and the second `2`, the command exits 1 (measured: `13`, `2`).
- A 15th path changed in the same diff: the first count stays `14` and the second is `2`, exit 1 (measured: `14`, `2`).

## What changed

- `git mv` of the 14 group-C files named in the row (`edge-updater-before-install`, `edge-updater-guard`, `node-pin-parity`, `provision-stamp-inputs`, `update-deferral-policy`, `profile-origin-writer`, `playbook-variables`, `lab-job`, `lab-job-lock-two-rows`, `lab-job-params-reach-the-command`, `patch-playbook`, `patch-update-naming`, `patch-feature-stage-5314`, `worker-port`) from `src/fleet-layer/` to `src/control-owned/`.

## Not done here

- The 18 files still in `src/fleet-layer/`, and the control halves of the splits: each waits for its owner row to MERGE (a11ign/a11ign#5350, #5347, #5348), and a half is deleted only after its destination has. The row's Acceptance is still false, so this pull request does not close it.
- Nothing else references `src/fleet-layer/` outside `.acceptance/`, `.changeset/` and `CHANGELOG`: read with `git grep` at this head; no config, workflow or script had to change.
- No `fleet:*`, `lab:*`, `worker:*` or capture command was run.
