---
"@a11ign/control": patch
---

`ansible/lab-job.yml` names the lab's scripts by their `.ts` paths (a11ign/a11ign#4796, step 3 of #4551): `build-realism-tier`, `calibrate-abstention`, `gate-probe-order`, `axe-calibration`, `lab-inventory`, `stability-gate` (the `stability` and `gate-stability` jobs), `corpus-prune-orphans`, `fleet-hours` and `evidence-check`. The seven that ran under `/usr/bin/node` now run under `lab_tsx`, the runner five other jobs on the same lab host already use, so no job depends on a Node the lab host may not have: the lab's `.mjs` names are one-release shims that stop on the `.ts` import under the distro's Node 22, and are deleted by a11ign/a11ign#4798.

`ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4820 (#4797), whose `layers.json` pins lab v0.1.28, the first tag that holds those nine `.ts` entries. `lab-job.test.ts` discovers the dispatching gates among the `.ts` files (importing `gates/dispatch.ts`) and reads `axe-calibration.ts`'s exit codes from the `.ts`; both read the `.mjs` shims before, which would have made the `--local` guard match nothing.
