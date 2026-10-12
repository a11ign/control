Closes a11ign/a11ign#5190's Region: `control-plane-fleet.ts` and `fleet-switch.ts` no longer reach `../../worker-fleet` (`fleet-env`). Follow-on to a11ign/control#73 (a11ign#5184), parent a11ign/a11ign#4425 done-when 3.

Acceptance:

```bash
cd /home/agent/repos/wt-5190-control && bash -c 'test "$(git grep -cE "from \"\.\./\.\./" -- src/control-plane-fleet.ts src/fleet-switch.ts | wc -l)" = 0'
```

**As run (measured, 2026-10-12):** exit 0. Before the change the same command exits 1 (2 matching files, one import line each).

Mutation:

```bash
cd /home/agent/repos/wt-5190-control && bash -c 'f=src/worker-fleet-carried.ts; cp $f "${TMPDIR:-/tmp}/carried.bak" && sed -i "s/^export const DEFAULT_WORKER_PORT = 8765;/export const DEFAULT_WORKER_PORT = 8766;/" $f; node --test src/worker-fleet-carried.test.ts; cp "${TMPDIR:-/tmp}/carried.bak" $f'
```

## What changed

- `src/control-plane-fleet.ts`: its `../../worker-fleet/src/fleet-env.ts` import now reads `./worker-fleet-carried.ts` (`WORKER_GROUP`, `groupPerLine`, `workersFromInventory`, `workerNamesFromInventory`, `portFromGroupVars`).
- `src/fleet-switch.ts`: the same, for `groupPerLine` and `WORKER_GROUP`.
- `src/worker-fleet-carried.ts` (outside the Region, as #5184 did): the declarations copied verbatim from `worker-fleet/src/fleet-env.ts` with their JSDoc, by script and not retyped: `DEFAULT_WORKER_PORT`, `SUSPECT`, the capture declarations (`CAPTURE_KEY`, `CAPTURE_LINE`, `CAPTURE_SUSPECT`), `Host`, `hostsInGroup`, `readCaptureDeclaration`, `applyCaptureDeclarations`, `workersFromInventory`, `workerNamesFromInventory`, `collectHost`, `portFromGroupVars`. `HOST_LINE`, `KEY_LINE`, `WORKER_GROUP`, `groupOf`, `descend`, `groupPerLine` were already there from #5184. The header comment lists the five importers.
- `src/worker-fleet-carried.test.ts` (outside the Region): the no-reach-out test now covers all five modules; a new case compares the three inventory readers and `DEFAULT_WORKER_PORT` with their originals on the same inventory (URLs, names, capture scope, port, and the refusal text when every worker is excluded).
- `.changeset/control-s-fleet-wake-5190.md` (patch; `ci.yml` requires a changeset).

## Measured (2026-10-12)

- `node --test src/worker-fleet-carried.test.ts`: 9 pass, 0 fail.
- Whole control suite, `node --test src/*.test.ts`: 748 tests, 733 pass, 15 fail. The untouched main checkout (`/home/agent/repos/control`, 739 tests) gives 724 pass, 15 fail. The 9 extra tests all pass. The 15 failing test names are identical on both sides (compared sorted).
- `control-plane-fleet.test.ts`, `fleet-switch.test.ts`, `fleet-discover`, `fleet-status`, `with-control-plane-fleet` and `control-has-no-dependencies` tests: all pass except the one pre-existing failure below.
- Pre-existing failure, not caused here: `control-plane-fleet.test.ts:108` (#1683, "the real defaults name the same durable path") asserts the in-tree inventory path ends `packages/control/ansible/inventory.yml`. That holds only when control is laid under the core as `packages/control`. It fails identically on the untouched main checkout.
- `node -e "import('./src/control-plane-fleet.ts')"` and `import('./src/fleet-switch.ts')`: both load.
- Typecheck: `tsc` (control's own binary) over `src/worker-fleet-carried.ts`, its test, `control-plane-fleet.ts` and `fleet-switch.ts`, with a scratch tsconfig outside the repo, `strict`, `NodeNext`: exit 0, no output.
- Mutation, against `worker-fleet-carried.test.ts`, the file restored and `cmp`'d byte-identical after each:
  - `DEFAULT_WORKER_PORT` 8765 to 8766 in the copy: the inventory-readers test fails, 8 of 9 pass.
  - `WORKER_GROUP` `a11y_workers` to `a11y_worker` in the copy: the inventory-group test and the inventory-readers test fail, 7 of 9 pass.
  - After restoring: 9 of 9 pass.

## Not done here

- The other direction of the mutation (drift in the ORIGINAL `worker-fleet/src/fleet-env.ts`) is not run: the original is a shared checkout (`/home/agent/repos/worker-fleet`) and this row does not edit it. The parity test would catch it by the same mechanism.
- Lint is not run in this worktree (no core layout here, so `eslint --no-ignore packages/control` from the core cannot run from this checkout).
- Measured by walking `fleet-wake.ts`'s relative-import closure (11 files) at this head: it reaches nothing in `worker-fleet`, so the fleet-wake closure is clean after this row. On the untouched main checkout (an older head, 10 files) the same walk shows `fleet-wake.ts` reaching `worker-http` and `cli-flags`, which origin/main had already fixed.
- Eight other non-test control modules, outside that closure, still import `../../worker-fleet/`: `fleet-auto-off`, `fleet-converge`, `fleet-playbook`, `lab-failed-units`, `lab-job`, `lab-pipeline`, `post-qualification-status`, `qualification-run`. Not in this Region and not touched here.

Closes a11ign/a11ign#5190
