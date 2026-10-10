Part of a11ign/a11ign#4519 (step 3 of 5; step 1 is lab#60, step 2 is a11ign/a11ign#4803). Names no workflow of its own beyond `ci.yml`'s `CORE_REF` line, an `Outside-Region: .github/workflows/ci.yml (`CORE_REF` only, as the row names); `ansible/lab-job.yml`, `src/fleet-layer/{capture-body-owner,cli-flags,entry-points,lab-job,no-win32-imports,protocol-guard,worker-code-check,worker-http-client-owner}.test.ts`, `src/lab-reset-removal.test.ts`, `src/layer-checkouts.test.ts`: forced by the `CORE_REF` move, see "What changed" (first CI run at d19fda5 failed `tsc` on the four deleted core modules).

Acceptance:

```bash
cd /home/agent/repos/wt-4786-control && bash -c '! git grep -n "qualification-status[.]mjs" -- src'
```

**As run (measured, 2026-10-10):** exit 0, no output. The row's fence names the primary checkout `/home/agent/repos/control`, which reads the same only after the merge, so it was run in this claimant's worktree of the repository, as the row says.

## What changed

- `src/post-qualification-status.ts` lines 45, 48, 64: `../../lab/src/gates/qualification-status.mjs` -> `.ts` (the import, and the `Outcome` and `StatusPayload` type references).
- `.github/workflows/ci.yml`: `CORE_REF` 83b46f522 -> 393f26a92 (the merge of a11ign/a11ign#4803). Read at that commit: `layers.json` pins `lab` at `v0.1.27`; `git ls-tree` on lab `v0.1.24`, `v0.1.25`, `v0.1.26` and `v0.1.27` shows `src/gates/qualification-status.ts` in `v0.1.27` ONLY, so 393f26a92 is the one core that lays it (no earlier commit on core `main` pins `v0.1.27`).
- `.changeset/control-imports-the-lab-gate-ts.md` (patch).
- **Forced by that move, found by the first CI run (`tsc`, d19fda5):** core 393f26a92 has deleted `packages/evidence/src/source-text.ts`, `packages/guards/src/{tree-wide-guard,local-import-closure}.ts` and `scripts/test-support/git-sandbox.ts` for `@a11ign/toolchain/lib/*` (a11ign/a11ign `.changeset/the-core-*`). Eight imports in six test files now name `@a11ign/toolchain/lib/{source-text,tree-wide-guard,local-import-closure,git-sandbox}` (all four are in the toolchain 0.7.0 the core locks, with the same names).
- **Forced by lab v0.1.27's renames of six files** (`qualification-status`, `assert-action-report`, `capture-check`, `capture-fixtures`, `occurrence-verdict-stability`, `page-identity-rate`, read off `git diff --name-status v0.1.26 v0.1.27` in lab): the `.mjs` left behind THROWS ("`capture-check.mjs` is now `capture-check.ts`"). `ansible/lab-job.yml`'s `capture-check` job passed the `.mjs` to tsx, which is a RUN-TIME break, not a test one; it now names `.ts`. The test lists naming those files follow (`capture-body-owner`, `worker-code-check`, `worker-http-client-owner`, `no-win32-imports`), and `capture-body-owner.test.ts`'s `captureClients()` matched `.mjs` only, so it found 3 clients and tripped its own vacuity guard: it matches `.ts` too (tests and `.d.ts` excluded).
- **Left as is, on purpose:** `src/layer-launchers.test.ts` expects `capture-check.mjs`, because the core's `scripts/test-support/launcher-reach.stand-in.cmd` still declares `CAPTURE_CHECK=packages\lab\src\harnesses\capture-check.mjs` (core file, not this Region). A launcher that runs that declared path would hit the throwing shim; named on the row for the core's owner.

## Evidence (all run here, no fleet and no lab)

- A scratch git worktree of the core at 393f26a92, this tree laid over `packages/control` exactly as `ci.yml`'s step does (`git add -Af`), node_modules and the laid layers taken from the installed core: `rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/**/*.test.ts"` -> 1199 tests, 1 fail before the judge `dist/` was copied in (`doctor.test.ts` LIVE, which needs the build `prepare` makes in CI), and `doctor.test.ts` alone then `VERDICT pass: 19 tests`. Before these edits the same run gave 4 failures, and `tsc` gave the 16 errors CI printed.
- `tsc --noEmit -p tsconfig.control.json` in that tree: 0 errors. `eslint --no-ignore packages/control`: 0 errors (822 warnings, the repository's existing `no-magic-numbers`).
- This repository's own tests (`rstest run --config scripts/rstest/rstest.config.ts`, toolchain config): `VERDICT pass: 32 tests in 6 files`.
- Not run: the `checks` job itself on GitHub (it is the verdict); `layout-check`.

## Mutation (`cp` before, `cp` after, `diff` identical)

- Line 64 restored to `.mjs`: the Acceptance command exits 1 and names `src/post-qualification-status.ts:64`. Unmutated: exit 0.

## Not done here

- The control tag that carries this merge does not exist until the release publishes it; the row's Done-when 2 is read from the release after the merge and named on the row. It is not `v0.3.3` or `v0.3.4`.
- #4796 touches the same `CORE_REF` line and rebases onto this (product-manager's ordering on the row).

Closes: none -- a11ign/a11ign#4786's Done-when 1 is "the Acceptance passes and the PR is merged", and a PR in this repository cannot close a row in `a11ign/a11ign`; `product-manager` closes it at merge.
