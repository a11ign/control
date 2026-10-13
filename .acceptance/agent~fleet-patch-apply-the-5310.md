Row a11ign/a11ign#5310 (half 2 of a11ign#5307): the control plane's checkout is `/root/control`, so the playbook's directory is `ansible/`, not `packages/control/ansible/`. Region is `src/control-plane-checkout.ts`, `src/fleet-playbook.ts` and `src/fleet-playbook.test.ts`. No `fleet:*`, `lab:*` or `worker:*` command was run (resource ban); the plane was not touched.

Acceptance:

```bash
pnpm exec node --test src/fleet-playbook.test.ts
```

The row's own line `cd ~/repos/control && ...` reads the PRIMARY checkout, which is on `main` and carries none of this change, so it would pass the old tree. The line above runs the same file in the branch's working tree.

**As run (measured, 2026-10-13):** `pnpm exec node --test src/fleet-playbook.test.ts`: `pass 126, fail 0` (125 before, plus the #5310 case). `pnpm run typecheck` clean. `pnpm run layout-check`: ok, 354 files. The control repo has no ESLint or Biome config and no `lint` script, so no lint was run. `pnpm test` (rstest): `VERDICT pass: 45 tests in 8 files`. Full `src/*.test.ts`: no failing test name absent from the branch point's full run. `src/control-owned/*.test.ts`: the same 4 failures with and without this change, so they predate it.

Mutations, each restored from a scratchpad copy and checked byte-identical with `diff`:
- `CONTROL_PLANE_CHECKOUT` back to `"a11y-witness"`: the #5310 case fails (`actual '/root/a11y-witness', expected '/root/control'`).
- `ANSIBLE_ON_THE_PLANE` back to `${CHECKOUT}/packages/control/ansible`: the #5310 case fails (`actual 'control/packages/control/ansible', expected 'control/ansible'`).

## What changed

- `src/control-plane-checkout.ts`: `CONTROL_PLANE_CHECKOUT = "control"`, and its comment now records why (the plane's checkout is the control repository, cloned at `/root/control`, a11ign#5306).
- `src/fleet-playbook.ts`: one exported `ANSIBLE_ON_THE_PLANE = \`${CHECKOUT}/ansible\``, used by the `systemd-run --working-directory=` of the playbook unit and by `patchTargetReadCommand`, which both used `packages/control/ansible`.
- `src/fleet-playbook.test.ts`: the #5310 case. It reads `patch_checkout` from `ansible/patch-schedule.yml` and pins that `CONTROL_PLANE_CHECKOUT_PATH` equals it, that `controlPlaneCheckout("main", sha)` enters that same directory, that `ANSIBLE_ON_THE_PLANE` is `ansible/` under it, that `patchTargetReadCommand` starts there, and that the `--working-directory=` text uses the constant.

## Not done here

- `inventorySources` (`src/control-plane-fleet.ts:78`) still builds `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/<entry>`. It is outside this row's Region, so it is filed as its own row. Until that lands, the in-tree inventory fallback names a path that does not exist on the plane; the installed `/etc/a11ign/inventory.yml` is still read first.
- `src/lab-job.ts` (`:76`, `:186`) and `src/lab-watch.ts` (`:44`, `:47`) keep the `packages/control/ansible` paths. Filed as a row.
- No live `fleet:patch --apply` was run. Done-when 2 is orchestrator's.

Closes: none — a11ign/a11ign#5310's Done-when 2 is a live `fleet:patch --apply` run on the plane, which is orchestrator's; `product-manager` closes the row at merge once that run has passed.
