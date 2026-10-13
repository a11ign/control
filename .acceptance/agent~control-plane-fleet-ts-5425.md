Row a11ign/a11ign#5425 (Boy Scout follow-up to a11ign#5310). `inventorySources` (`src/control-plane-fleet.ts`) resolved a relative `ansible.cfg` inventory entry to `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/<entry>`. The plane's checkout is `/root/control`, whose `ansible/` is at its top, so the in-tree fallback named a path that does not exist there. It now resolves to `${CONTROL_PLANE_CHECKOUT_PATH}/ansible/<entry>`, the directory `ansible.cfg` sits in, which is how the config's own comment says a relative entry is read.

Region is `src/control-plane-fleet.ts` and `src/fleet-playbook.test.ts`. **Outside the row's Region:** `src/control-plane-fleet.test.ts`. Its `IN_TREE_FALLBACK` pins the same wrong path through `inventorySources` (the file the row's own Acceptance runs), and its `#1683` case pins a `packages/control/ansible/inventory.yml` regex on the LOCAL in-tree default, which is `../ansible/inventory.yml` from `src/` in this layout, so it could never match. Both are updated; without them the Acceptance stays red.

Run location: the row's `cd ~/repos/control && ...` reads the PRIMARY checkout, which carries none of this change, so the same command is run here in the branch's working tree.

Acceptance: `pnpm exec node --test src/control-plane-fleet.test.ts src/fleet-playbook.test.ts`

**As run (measured, 2026-10-13):**
- Before the source change, with the tests updated to the corrected path: `tests 145, pass 141, fail 4`. The four are the `inventorySources` pins (`#1343` in `fleet-playbook.test.ts`, `#1356` x2 and `#1683` in the other file, each showing `/root/control/packages/control/ansible/inventory.yml` as the actual value). So the tests fail on the old code and name the path.
- After the source change: `tests 145, pass 145, fail 0`.
- `pnpm run typecheck` (`tsc --noEmit`): exit 0.
- `pnpm test` (rstest): `VERDICT pass: 45 tests in 8 files`.
- The control repo has no `lint` script (only `typecheck` and `test`), so no lint was run.

Other `packages/control/ansible` text in `src/` was not changed here. The lines read were comments, historical notes or message fixtures (e.g. `fleet-playbook.ts:145`, `lab-job.test.ts:280`, `inventory-outlives-a-pull.test.ts:147`). `layer-control-lab.test.ts` and `layer-guests.test.ts` read that path from `REPO` and were not examined.

Closes a11ign/a11ign#5425
