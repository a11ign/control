---
"@a11ign/control": patch
---

Control's last twenty-one `.mjs` are TypeScript (a11ign/a11ign#4341, following #4268): converted by `@a11ign/toolchain`'s `js-to-ts` script, its residue (`@typedef`s, casts, untyped parameters) typed by hand, and the `.mjs` baseline lowered from 21 to 0. Every unit, task and argv that runs one now names the loader that resolves on its box: the two control-plane units (`a11y-fleet-auto-off`, `a11y-gate-heartbeat`) and `deploy.yml` and the worker `bespoke.yml` run `/usr/bin/node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs`, the lab's argvs (`lab-status.yml`, `lab_laid_copy_check`) run `lab_tsx`, and `inventory-install.yml` (the operator's machine) runs the core checkout's `tsx`. `control-host-install.yml` now asserts `/opt/a11y-tsx` is installed (it does not install it: ADR 0012, `orchestrator` owns the install, #4292), and `control-runs-under-tsx.test.ts` pins each spelling.
