---
"@a11ign/control": patch
---

`lab-job.ts` and `lab-watch.ts` resolve `ansible/` from the file itself instead of spelling the core's `packages/control/ansible` (a11ign/a11ign#5426). Both run on the control plane, whose checkout is control's own repository (`/root/control`, a11ign/a11ign#5310) with `ansible/` at the top; there the old `new URL("../../../")` working directory was `/` and every path missed. `lab-job` now runs `ansible-playbook` with `ansible/` as its working directory, like `fleet-playbook.ts`.
