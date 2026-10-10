Step 3 of a11ign/a11ign#4551, row a11ign/a11ign#4796. `ansible/lab-job.yml` names the lab's scripts by their `.ts` paths and runs them under `lab_tsx`, and `ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4820 (#4797), whose `layers.json` pins lab v0.1.28, so the lab laid beside this package holds the `.ts`.

Outside-Region: src/fleet-layer/cli-flags.test.ts — forced by the `CORE_REF` move: at lab v0.1.28 the 35 renamed `scripts/*.mjs` are one-release shims that read `process.argv` to forward it, so `commandLineModules` counts them and "a new CLI cannot quietly join the unguarded ones" failed naming all 35 (measured: 1 of 1199 tests in the control suite laid over the core at b6d3cbd76, before the edit); the test now asks the guard question of the shim's `.ts`.

Host-install: `ansible/lab-job.yml` -- the control host's laid copy (`/root/a11y-witness/packages/control/ansible/lab-job.yml`) still names the `.mjs` shims under `/usr/bin/node`. Putting this file there is a host-run lay and is `orchestrator`'s, never this claimant's; until it runs, the lab jobs keep dispatching the shims, which lab v0.1.28 still ships.

Closes: none -- a11ign/a11ign#4796 cannot be closed from this repository; `product-manager` closes it at merge.

Acceptance:

```bash
cd /home/agent/repos/wt-4796-control && bash -c '! git grep -nE "lab/scripts/[a-z-]+[.]mjs" -- ansible/lab-job.yml'
```

**As run (measured, 2026-10-10):** exit 0, no output. The row's fence names the primary checkout `/home/agent/repos/control`, which reads the same only after the merge, so it was run in this claimant's worktree of the repository, as the row says. At `origin/main` (6a3d38c) the same command prints 10 lines and exits 1.

## What changed

- `ansible/lab-job.yml`, ten lines: `build-realism-tier`, `calibrate-abstention`, `gate-probe-order`, `axe-calibration`, `lab-inventory`, `corpus-prune-orphans` and `fleet-hours` ran `/usr/bin/node <name>.mjs` and now run `{{ lab_tsx }} <name>.ts`; `stability-gate` (two jobs) and `evidence-check` already ran under `lab_tsx` and name the `.ts`. **Two of the seven (`corpus-prune-orphans`, `fleet-hours`) are not in the row's list of five**; they match the Acceptance's pattern, so the Acceptance needs them moved.
- **The runner is `lab_tsx`, not `%h/.local/bin/node`, and that is a choice, not a measurement of the lab host.** The row allows either. `%h/.local/bin/node` is the engineer host's Node 24 (#4388); these argvs run by `systemd-run` on the `a11y_lab` host as `root`, where nothing in this repository or the row establishes that `/root/.local/bin/node` exists, and the resource ban forbids looking. `lab_tsx` is the runner the same host already uses for `stability-gate`, `score-rules`, `capture-check` and `evidence-check`. If `orchestrator` finds Node 24 on the lab host and wants the stripped-types path, it is a one-token change per line.
- `.github/workflows/ci.yml`: `CORE_REF` 393f26a92 -> b6d3cbd7616dd68d52726a5c63201f453d0ead62 (the merge of #4820). Read at that commit: `layers.json` pins `lab` at `v0.1.28`; `git ls-tree v0.1.27 scripts/` holds none of the nine `.ts` and `v0.1.28` holds all nine, so a pin before #4797 lays a lab with no `.ts` for the test to read.
- `src/fleet-layer/lab-job.test.ts`: the dispatching-gate discovery reads `.ts` files importing `gates/dispatch.ts` (it read `.mjs` files containing `gates/dispatch.mjs`, which the shims do not contain), and the axe-calibration exit-code test reads `axe-calibration.ts`.
- `src/fleet-layer/cli-flags.test.ts`: `programOf` sends a shim (marked `TRANSITIONAL (a11ign/a11ign#4551)`) to its `.ts` before `callsTheGuard`.
- `.changeset/control-runs-the-lab-scripts-as-ts.md` (patch).

## Evidence (all run here, no fleet and no lab)

- A scratch worktree of the core at b6d3cbd76 with its laid layers taken from the installed core (lab at `.layer-ref` v0.1.28), this tree laid over `packages/control` as `ci.yml`'s step does (`git add -Af`): `rstest run --config scripts/rstest/rstest.config.ts --include "packages/control/**/*.test.ts"` before the `cli-flags.test.ts` edit gave 2 failures of 1199: `cli-flags.test.ts` (35 shims, fixed here) and `doctor.test.ts` LIVE (judge `dist/` is not built in the scratch; CI's `prepare` builds it, and the previous control PR recorded the same). After the edit, `cli-flags.test.ts` and `lab-job.test.ts`: `VERDICT pass: 60 tests in 2 files`.
- `tsc --noEmit -p tsconfig.control.json` in that tree: 0 errors. `eslint --no-ignore` on the two edited test files: 0 errors (15 warnings, the repository's `no-magic-numbers`).
- This repository's own tests: `VERDICT pass: 32 tests in 6 files`.
- Not run: the `checks` job on GitHub (it is the verdict); no lab job was dispatched, so that the `.ts` entries RUN under `lab_tsx` on the lab host is not exercised here (`score-rules.ts` and `evidence-check` already do).

## Mutation (`cp` before, `cp` after, `diff` identical each time)

- `lab-inventory.ts` put back to `.mjs` in `ansible/lab-job.yml`: the Acceptance exits 1 naming line 809; restored, exit 0.
- `--local` removed from the `gate-probe-order` argv (scratch copy): `lab-job.test.ts` fails with `gate-probe-order runs gate-probe-order.ts without --local`. Measured at lab v0.1.28: 0 of the `.mjs` files contain `gates/dispatch.mjs` and 2 `.ts` files contain `gates/dispatch.ts`, so the unedited discovery would have stopped at its own `>= 2` guard ("the discovery is broken") once the pin moved, and the edited one finds exactly the two.
- `refuseUnknownFlags(` renamed in the scratch lab's `axe-calibration.ts`: `cli-flags.test.ts` fails naming `packages/lab/scripts/axe-calibration.mjs`; restored, passes.

## Not done here

- The control tag that carries this merge does not exist until the release publishes it; the row's Done-when 2 is read from the release after the merge and named on the row.
- `commandLineModules` (`worker-fleet/src/command-line-census.ts`, a layer, not this Region) walks `.mjs` only, so the lab's `.ts` programs enter the census only through their shims, and stop entering it when #4798 deletes them. A census that reads `.ts` is the owner's change.
