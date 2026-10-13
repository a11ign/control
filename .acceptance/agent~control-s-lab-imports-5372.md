Row a11ign/a11ign#5372 (ceo's ruling on a11ign#5335). Control's lab imports are control's own: `post-qualification-status.ts` reads its verdict types from a carried copy, `src/lab-carried.ts` (exported as `./lab-carried`), and the three tests that reached the lab's scripts and corpus stop reaching it. Those three assertions move to a11ign/lab in follow-up a11ign#5379, which lands before this PR merges. Region is the control files named on the row. GREEN AT THE OLD `CORE_REF` PIN.

Acceptance: `bash -c '! git grep -q -E "(\.\./)+lab/" HEAD -- src/ && git cat-file -e HEAD:src/lab-carried.ts'`

**As run (measured, 2026-10-13):** control `pnpm run typecheck` exit 0; control `pnpm test` `VERDICT pass: 44 tests in 8 files`; `pnpm run layout-check` ok. The control package is laid into a detached core checkout at `CORE_REF` (b6d3cbd7) with the CI steps from `ci.yml`: `eslint --no-ignore packages/control` 0 errors (1020 pre-existing warnings), `tsc --noEmit -p tsconfig.control.json` exit 0, `rstest run --include "packages/control/**/*.test.ts"` `VERDICT pass: 1272 tests in 72 files`. The row grep over the working tree matches nothing. Mutation: a `../../lab/` import appended to `post-qualification-status.ts` is caught by the grep; the file restored from a scratchpad copy, byte-identical.

Closes a11ign/a11ign#5372
