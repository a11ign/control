---
"@a11ign/control": minor
---

A lab job can ask for all ready workers or the N least loaded (a11ign/a11ign#5017, #4405 item 4): with the inventory var `lab_dispatch_balance: true`, `-e workers=ready` takes every ready box and `-e workers=<N>` the N with the fewest captures in the last 24 h, confirmed awake with `fleet-wake` before the job starts (`src/fleet-dispatch.ts`, wired in `ansible/lab-job.yml`). The option is `false` by default: `workers=ready` is then refused naming it, and `workers=<N>` keeps its meaning of the first N capturing hosts, so nothing changes until the inventory says `true`. `capture-check` is not dispatched through `lab-job.yml` and is not covered. Not reachable through `pnpm run lab:job` until `src/lab-job.ts`'s `neededWorkers` learns `ready` (outside this row's Region, named on the row); `ansible-playbook lab-job.yml` takes it directly.
