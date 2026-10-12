Row a11ign/a11ign#5312 (control's fleet auto-off runs from control's own checkout). Region is `src/fleet-auto-off.ts`, its test, `src/control-has-no-dependencies.test.ts`, `scripts/control-commands.test.ts`, `scripts/package-manifest.test.ts`, `package.json`, `pnpm-lock.yaml`, `deploy-pins.json`. The ceo ruling (a11ign/a11ign#5312, 2026-10-12 22:20Z) is the scope: the two published layers declared at their pins, the guard amended, `tsx` as a devDependency, the layer-test failures moved or deleted with reasons.

Acceptance: `bash -c '! grep -rn "\.\./\.\./worker-fleet" src/fleet-auto-off.ts && pnpm exec node --test src/fleet-auto-off.test.ts'`

**As run (measured, 2026-10-13):**
- Acceptance command: `tests 113, pass 112, fail 0, todo 1` (exit 0).
- `src/control-has-no-dependencies.test.ts`: `tests 5, pass 4, fail 0, todo 1` (exit 0).
- `pnpm test` (rstest): `VERDICT pass: 40 tests in 7 files` (exit 0).
- `pnpm run typecheck`: clean. `pnpm run layout-check`: `ok (344 files read)`.
- `pnpm install --frozen-lockfile --ignore-scripts --prod`: exit 0 (the install the orchestrator's plane runs, confirmed here only).
- `pnpm run lint`: NOT RUN. This checkout has no `lint` script; it is the core's ESLint gate and does not reach here.

**Mutations**, each reverted and the file re-checked: an undeclared module `src/zz-mutation-undeclared.ts` importing `left-pad` fails the walk (`zz-mutation-undeclared.ts imports "left-pad"`); changing the declared `@a11ign/screenreader-worker` from 0.13.0 to 0.12.0 fails the declared-versions test.

**The seven layer-test failures, with dispositions:**
- `fleet-auto-off.test.ts` #3275 closure test: amended to the closure the new imports reach (`THIS`, `fleet-watch.ts`, `fleet-wake.ts`), and asserts the source imports `@a11ign/screenreader-fleet/worker-http`.
- #4571 (unit names `packages/control/src`): `todo`. The unit file moves with the plane install, which belongs to the orchestrator (`ansible/files/a11y-fleet-auto-off.service`).
- Five layer-judgment tests deleted: #3845 layer files to pin, #4363, another tag refuses, cannot be read / no pin, and the REAL checkout one. Each reaches machinery the closure no longer reaches (the laid tree, `.layer-ref`, `packages/worker-fleet`), and the REAL-checkout one reads `../../../`, which does not exist in a raw checkout. Deleting them does not weaken a guarantee the control plane now relies on.

**Known gap, named not hidden:** the walk skips a relative target it cannot read (`catch { unresolved.push(key); return; }`). Seven modules outside this Region import `../../worker-fleet/` (13 statements: `fleet-playbook`, `lab-pipeline`, `lab-job`, `fleet-converge`, `qualification-run`, `post-qualification-status`, `lab-failed-units`). That path resolves here only beside a sibling checkout (`/home/agent/repos/worker-fleet`). The `todo` test records this, and it stays a todo because the fix belongs to the next row.

**Ruling-required pins:** `deploy-pins.json` screenreader-fleet 0.10.2 with its integrity; `package.json` dependencies exactly `@a11ign/screenreader-fleet` 0.10.2 and `@a11ign/screenreader-worker` 0.13.0, `tsx` in devDependencies; the production closure of the two layers is 61 packages and is pinned by name and version in the guard.

Closes a11ign/a11ign#5312
