Row a11ign/a11ign#5472. Region is `ansible/roles/worker/tasks/edge-version.yml` and `src/control-owned/edge-updater-guard.test.ts` only. No `fleet:*`, `lab:*` or `worker:*` command was run (resource ban: a live provision is `lane:orchestrator`'s, and it is the #5155 after-reading the row's second done-when point names).

Acceptance: `node --test src/control-owned/edge-updater-guard.test.ts`

**As run (measured, 2026-10-13):** the cause is in the task file's shape, not in the box. `repetition:` was written as a YAML LIST (`- interval:`). `community.windows.win_scheduled_task`'s own docs declare `repetition` as a dict of suboptions (`interval`, `duration`), and its `Compare-PropertyList` only expands a repetition it finds as `-is [Hashtable]`. A list falls through to `Set-PropertyForComObject`, which hands the array to COM as `Repetition`: `failed to set trigger property 'Repetition' to 'System.Collections.Hashtable': Index was outside the bounds of the array`. Before the YAML change, the guard file fails `no repeating trigger` and `repetition is a list, which the module cannot set`, and the mutation control `repetition written as a list FAILS` fails on its precondition. After the change: `node --test src/control-owned/edge-updater-guard.test.ts` gives `ℹ tests 16, pass 16, fail 0`. `pnpm run typecheck` exit 0, `pnpm test` `VERDICT pass: 45 tests in 8 files`, `pnpm run layout-check` ok.

**Not run here:** the live reading (done-when point 2, `fleet:provision -- --serial=0` passing the "Register the guard task" task on a box). That is a fleet write and `lane:orchestrator`'s; it is not claimed by this file.

Closes a11ign/a11ign#5472
