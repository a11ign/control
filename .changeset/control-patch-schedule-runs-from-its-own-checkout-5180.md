---
"@a11ign/control": patch
---

The patch-window unit runs control's own `src/fleet-playbook.ts` from control's checkout, and no longer runs the core's `scripts/lay-layer.ts` or a laid `packages/control` (a11ign/a11ign#5180, under a11ign#5087, ADR 0045 cut 8 and 9). `ansible/patch-schedule.yml` sets `patch_checkout` to `/root/control`; `ExecStartPre` keeps its `git merge --ff-only origin/main` of that checkout and drops both `lay-layer` calls; `ExecStart` runs `{{ patch_checkout }}/src/fleet-playbook.ts`. Without this, once the core's checkout follows `main` the `lay-layer` step fails quietly and the unit starts a stale copy. Revert: restore the previous `ansible/patch-schedule.yml` and run `fleet:patch-schedule` again; the unit is re-rendered on the next run.
