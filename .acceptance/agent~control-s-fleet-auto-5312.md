Row a11ign/a11ign#5312 (control's fleet auto-off runs from control's own checkout), with a11ign/a11ign#5335 done-when 3 and #5381 done-when 5 folded in (ceo). Scope is the rulings of 2026-10-12: the two published layers declared at their pins and the four helpers imported from them, the guard amended, `tsx` as a devDependency, `CORE_REF` moved to `c5dddb33d622e547945289b690510fa223ebcb79`, and the `valueAt` / `edgeUpdaterGuard.state` re-carry (#5021) restored.

Acceptance: `bash -c 'cd ~/repos/control && ! grep -rn "\.\./\.\./worker-fleet" src/fleet-auto-off.ts && pnpm exec node --test src/fleet-auto-off.test.ts'`

Acceptance: `bash -c 'cd ~/repos/control && git grep -q "CORE_REF: c5dddb33d622e547945289b690510fa223ebcb79" HEAD -- .github/workflows/ci.yml'`

**As run at this head (2026-10-13):**
- First command: `tests 113, pass 112, fail 0, todo 1` (the todo is the existing #4571 unit-file test), exit 0.
- `src/control-has-no-dependencies.test.ts`: `tests 5, pass 5, fail 0, todo 0`.
- `pnpm test` (rstest, control alone): `VERDICT pass: 45 tests in 8 files`. `pnpm run typecheck`: clean. `pnpm run layout-check`: `ok (352 files read)`.
- `pnpm install --frozen-lockfile --ignore-scripts`: exit 0.
- **The core's own gates over this package, at the new pin**, replicated locally (core at `c5dddb33`, this package laid at `packages/control`, the layers laid by the new `ci.yml` step): `eslint` 0 errors (1019 warnings, as on main), `tsc` clean, rstest `4 of 1250 tests failed`. Those four are NOT this change: origin/main at the same pin with the same lay fails the same four, plus five this PR fixes (see below).

**The four that stay red (outside this row's Region; reported, not patched):** all in `src/control-owned/lab-job.test.ts` (#1041 population, #1511 `--update` exit codes, "every `job=<name>`..." and "every job whose resolved script adopts gateVerdict..."). `ansible/lab-job.yml` runs `corepack pnpm run --silent rules:real-pages` (and the other lab script names), and those names were deleted from the core's root `package.json` by `23a179418` (cut 9, #5087, "the 77 lab script names"); the lab's `package.json` at `v0.1.28` carries only `layout-check`, `test`, `changeset`. The test resolves `npm run` names through `../../../../package.json`, so it can find no script. Owner: lab/orchestrator (where the job catalogue's script names live now). This PR does not edit `ansible/lab-job.yml`.

**What the five fixed ones were:** the layers are no longer laid by the core's `prepare`, so `ci.yml` now clones the three `deploy-pins.json` names (`v<version>` / `lab.tag`) beside the core's own; the #2063/#2211 reads of the worker's source then resolve. `BOOTSTRAP_LAG` in `edge-pin-parity.test.ts` is deleted (the bootstrap now carries the role's whole pin, and the test said so). `fleet-status.test.ts`'s fixture nests dotted paths so the restored `valueAt` reads them.

**Mutations**, each reverted and the file re-checked (`cp` backup/restore): an undeclared `src/zz-mutation-undeclared.ts` importing `left-pad` fails the walk; `@a11ign/screenreader-worker` 0.13.0 -> 0.12.0 in `package.json` fails the declared-versions test; a relative import to `../../worker-fleet/src/nope.ts` fails the resolve test; restored, all five pass.

**Third-party closure the lockfile installs on the plane** (`--frozen-lockfile --ignore-scripts`): the production closure of the two layers, pinned by name and version in `control-has-no-dependencies.test.ts` (`PRODUCTION_CLOSURE`, 61 packages, `@guidepup/guidepup@0.31.0` among them). `tsx` and the toolchain are `devDependencies` and are not in it.

**Files outside the named Region that had to move:** `src/git-safe-env.ts` (new: a one-line re-export of the package's `sandboxGitEnv`; the core's `git-spawn-scrubbed` guard matches the tail `git-safe-env.ts`, so the package specifier alone would escape it), `src/fleet-playbook.ts`, `src/fleet-converge.ts`, `src/lab-job.ts`, `src/lab-pipeline.ts`, `src/qualification-run.ts` (the four helper imports, ruling B), `src/worker-fleet-carried.ts` and its test (re-carry), `src/control-owned/{fleet-consistency,edge-pin-parity,lab-job,lab-job-lock-two-rows}.test.ts`, `src/{layer-checkouts,layer-control-lab,layer-pins,qualification-layer-refs,qualification-pin-skew,fleet-status,fleet-playbook}.test.ts`, `.github/workflows/ci.yml`. Those tests read `worker-fleet/src/...` by path or imported the helpers relatively.

**Five laid-layer judgement tests deleted from `fleet-auto-off.test.ts`** (#3845 layer files to pin, #4363, another tag refuses, cannot be read / no pin, the REAL checkout one): each reached the laid tree, `.layer-ref` or `packages/worker-fleet`, which the closure no longer reaches, and the REAL-checkout one read `../../../`, which a raw checkout does not have.

**ADR 0012's amendment note** lives in the core repo (`docs/adr/0012-control-plane-split.md`), so it is a separate docs PR there, linked on the row. **Plane path (done-when 4):** not changed by this PR; the plane install is the orchestrator's.

Closes a11ign/a11ign#5312
Closes a11ign/a11ign#5335
