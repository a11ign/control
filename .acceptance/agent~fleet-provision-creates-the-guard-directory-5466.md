Row a11ign/a11ign#5466. Region is `ansible/roles/worker/tasks/edge-version.yml` and `src/control-owned/edge-updater-guard.test.ts` only. No `fleet:*`, `lab:*` or `worker:*` command was run (resource ban: a live provision is `lane:orchestrator`'s, and it is the #5155 after-reading the row's second done-when point names).

Acceptance: `node --test src/control-owned/edge-updater-guard.test.ts`

**As run (measured, 2026-10-13):** before the YAML change, the new test fails on the file with no directory task: `the guard directory is not created before the script is laid, so the copy fails where it is absent (#5466)`. After it: `ℹ tests 15, pass 15, fail 0` for the guard file (12 existing and 3 new). Full control suite `pnpm test`: `VERDICT pass: 45 tests in 8 files`. `pnpm run typecheck` exit 0. `pnpm run layout-check`: ok (366 files). The task file parses as YAML, and the guard block now runs, in order: create the directory, stop it inheriting, grant SYSTEM and Administrators FullControl and Users ReadAndExecute, lay the script, register the task. `grep -c 'state: directory'` on the task file goes from 0 to 1.

Closes a11ign/a11ign#5466
