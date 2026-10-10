---
"@a11ign/control": patch
---

Control follows the lab's `.ts` renames (a11ign/a11ign#4786, step 3 of #4519). `src/post-qualification-status.ts` names `../../lab/src/gates/qualification-status.ts` in its import and its two `Outcome` / `StatusPayload` type references, where it named `.mjs`; and `ansible/lab-job.yml`'s `capture-check` job runs `packages/lab/src/harnesses/capture-check.ts` (lab v0.1.27 keeps the `.mjs` as a one-release shim that THROWS, so a job still naming it would have failed at run time). The tests that read the five other renamed lab files (`assert-action-report`, `capture-check`, `capture-fixtures`, `occurrence-verdict-stability`, `page-identity-rate`) name `.ts` too, and `capture-body-owner.test.ts`'s discovery of capture clients matches `.ts` as well as `.mjs`.

A control tree is now only as good as the core laid beside it: `ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4803, whose `layers.json` pins `lab` at v0.1.27 (it named a core that lays v0.1.24, which holds only the `.mjs`). That core has deleted its own `evidence/src/source-text`, `guards/src/{tree-wide-guard,local-import-closure}` and `scripts/test-support/git-sandbox` in favour of `@a11ign/toolchain/lib/*`, so the six test files that imported them by relative path import the toolchain's copies. The tag this change makes is the one a11ign/a11ign#4787 pins.
