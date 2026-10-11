---
"@a11ign/control": minor
---

A lab job that dispatches to the fleet is refused while a fleet build incident is open (a11ign/a11ign#5029, chairman ruling #4405). `lab:job` asks `openFleetBuildIncident` before it resolves a pool or wakes a box; while an `incident:fleet-build-mixed` issue is open, every catalogue job that `workerDemand` derives as fleet-dispatching exits 3 with stderr naming the incident, the laggard boxes and the target build. A read that cannot be made refuses too, saying it could not ask, so an unreadable GitHub is never read as "no incident". There is no override flag. `describe=1` and jobs with no fleet demand are not refused, and `fleet:deploy`, `fleet:provision` and `fleet:patch` are unchanged. Paths that reach boxes without `lab:job` (direct `ansible-playbook ansible/lab-job.yml`, the scheduled `capture-check` task) are not covered. Revert: delete the `buildRefusal` guard block in `runOnce` (`src/lab-job.ts`).
