Closes a11ign/a11ign#5184's Region: `fleet-discover.ts`, `fleet-status.ts` and `with-control-plane-fleet.ts` no longer reach `../../worker-fleet`. Parent a11ign/a11ign#4425, follow-on to #5183.

Acceptance:

```bash
cd /home/agent/repos/wt-5184-control && bash -c 'test "$(git grep -cE "from \"\.\./\.\./" -- src/fleet-discover.ts src/fleet-status.ts src/with-control-plane-fleet.ts | wc -l)" = 0'
```

**As run (measured, 2026-10-12):** exit 0. Before the change the same command exits 1 (3 matching files, 9 import lines).

Mutation:

```bash
cd /home/agent/repos/wt-5184-control && bash -c 'f=src/worker-fleet-carried.ts; cp $f "${TMPDIR:-/tmp}/carried.bak" && sed -i "s/^const DEGRADED_RECOVERY_SHARE = 0.5;/const DEGRADED_RECOVERY_SHARE = 0.9;/" $f; node --test src/worker-fleet-carried.test.ts; cp "${TMPDIR:-/tmp}/carried.bak" $f'
```

## What changed

- `src/fleet-discover.ts`, `src/fleet-status.ts`, `src/with-control-plane-fleet.ts`: their nine `../../worker-fleet/src/` imports (five modules: `worker-http`, `fleet-env`, `cli-flags`, `worker-health`, `fleet-consistency`) now read one local module.
- `src/worker-fleet-carried.ts` (new, outside the Region, declared in the PR body): the declarations those imports named, copied verbatim from the originals (`cli-flags`, `worker-health` and `fleet-consistency` whole; `worker-http` and `fleet-env` by declaration). Route chosen: a copy, because a package-name import is refused by `control-has-no-dependencies.test.ts` (ADR 0012) and `worker-fleet` publishes no target the control plane's raw checkout can resolve. One module rather than inline copies, so the next files that need these (below) import them instead of carrying a third and fourth copy.
- `src/worker-fleet-carried.test.ts` (new, outside the Region): each copy against its original on the same inputs, wherever the original is laid.
- `.changeset/control-s-fleet-wake-5184.md` (outside the Region; `ci.yml` requires a changeset).

## Measured (2026-10-12)

- `node --test src/worker-fleet-carried.test.ts`: 8 pass, 0 fail.
- Whole control suite, `node --test src/*.test.ts`: 747 tests, 732 pass, 15 fail. The unmodified main checkout (23ba805) gives 739 / 724 / 15 with the SAME 15 files failing (compared by name), so the 8 new tests are the only difference and none of the 15 is one of the three modules' own tests.
- `fleet-discover.ts`, `fleet-status.ts`, `with-control-plane-fleet.ts` each load (`node -e "import('./src/<file>.ts')"`).
- Typecheck: `tsc` over the three modules, the new module and its test, with the core's `tsconfig.base.json`: no errors. Run from the main control checkout's `node_modules`; `pnpm run typecheck` here covers `scripts/` only (see `tsconfig.json`). Lint not run: this worktree has no `node_modules` and the repository has no lint script of its own.
- Mutation, each against `worker-fleet-carried.test.ts`, the file restored and `cmp`'d byte-identical after each:
  - `DEGRADED_RECOVERY_SHARE` 0.5 to 0.9 in the copy: the worker-health test fails, 7 of 8 pass.
  - `error.code = "ETIMEDOUT"` to `"ETIMEOUT"` in the copy: the `requestJson` test fails, 7 of 8 pass.
  - `WORKER_GROUP` `a11y_workers` to `a11y_worker` in the copy: the inventory-group test fails, 7 of 8 pass.
  - a `../../worker-fleet` import put back in `fleet-status.ts`: the no-reach-out test fails, 7 of 8 pass.

## Not done here (done-when 3 of #5183 is still not true after this row)

Measured by walking `fleet-wake.ts`'s relative imports at this head: three files still reach `../../worker-fleet/`.

- `src/fleet-wake.ts` (`worker-http`, `cli-flags`): a11ign/control#72, open.
- `src/control-plane-fleet.ts` and `src/fleet-switch.ts` (`fleet-env`): `fleet-switch.ts` needs only `groupPerLine` and `WORKER_GROUP`, which this PR now carries. `control-plane-fleet.ts` also needs `workersFromInventory`, `workerNamesFromInventory` and `portFromGroupVars`, the inventory reader proper, which this PR does not carry. Outside this row's Region; filed as its own row.

Closes a11ign/a11ign#5184
