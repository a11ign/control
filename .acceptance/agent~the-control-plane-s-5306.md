Row a11ign/a11ign#5306: the control plane's fleet auto-off unit still lays control with `scripts/lay-layer.ts`, which a11ign#5087 deleted, so every tick refused `cannot-tell`. This change points the unit at control's own checkout (`/root/control`, a11ign#5312 / control#89) and removes the laying steps. **Nothing deploys from this change:** it is a pull request to control and no host moves. Done-when 2, 3 and 4 are `orchestrator`'s (the install, the timer restart, the read-back), not this pull request's.

Acceptance:

```bash
test "$(grep -c "lay-layer.ts" ansible/files/a11y-fleet-auto-off.service)" = 0 && node --test src/control-runs-under-tsx.test.ts src/fleet-auto-off.test.ts src/fleet-watch.test.ts
```

The grep counts the old script name in the unit and must print `0`; the second command runs the three `src/` files this change touches (207 tests, all `node:test`). The scripts suite (`pnpm test`, 45 tests) is run as a further check, not declared as acceptance.

**As run (measured, 2026-10-13, at this head):** the grep exits `0`. `pnpm test` (the scripts suite) passes 45 tests in 8 files. `src/control-runs-under-tsx.test.ts`, `src/fleet-auto-off.test.ts` and `src/fleet-watch.test.ts` pass 207 tests in 3 files, run through a scratch rstest config that includes `src/**` (the repo's `pnpm test` config covers `scripts/**` only). `pnpm run typecheck` exits `0`. There is no `lint` script in this repository, so no lint was run.

The full `src/` run is 1107 of 1117 passing in 70 files. The 10 failures are path-layout failures in files this change does not touch (a standalone checkout has no `packages/nvda-worker`, `packages/lab`, or `packages/control/ansible/inventory.yml`). None of those files reads the unit or `fleet-auto-off.ts`.

## What changed

- `ansible/files/a11y-fleet-auto-off.service`:
  - `WorkingDirectory=/root/control`, and `ExecStart` runs `/root/control/src/fleet-auto-off.ts --apply` through the `/opt/a11y-tsx` loader.
  - `ExecStartPre` keeps the follow-`main` step: skip while a play runs, fetch at most once a minute, then `git merge --ff-only`. Both `node scripts/lay-layer.ts` lines are removed, and steps 4 and 5 are replaced by a note that nothing else is laid, since `@a11ign/worker-fleet` comes from `pnpm install` in control's checkout (Done-when 2).
- `src/fleet-auto-off.test.ts`: the `ExecStart` and `WorkingDirectory` pins now name `/root/control`. The `#3852` test asserts the checkout fast-forwards and that no `node` command runs (positive control: a `systemctl` call). The `#4571` test is no longer a TODO: every script the unit runs must exist in control's own checkout, and the old `.mjs` spelling is still caught.
- `src/control-runs-under-tsx.test.ts`: its patterns accept `control/src` as well as `packages/control/src`. This file is outside the Region, but it broke on the new path.
- `src/fleet-auto-off.ts`: a comment only, in the header, saying where the timer runs from.

## Judgment calls

- Used `WorkingDirectory=/root/control`, not `/root/a11y-witness`. The CEO's ruling A (control#89, merged at `ae28ddb`) makes control's checkout the program's root.
- Kept the follow step, because `fleet-auto-off.ts` refuses `stale-checkout` on any difference from `origin/main`, and nothing else moves control's checkout between deploys.

## Open, not in this Region

1. **`src/fleet-watch.ts:744` reads the auto-off state from `CONTROL_PLANE_CHECKOUT` (`/root/a11y-witness/runs/fleet-auto-off-state.json`).** After this merges, the timer writes its state under `/root/control/runs/...`, so fleet-watch goes blind on auto-off state. Not changed here. It needs a row that decides where the state lives, since `CONTROL_PLANE_CHECKOUT` names a machine fact.
2. Leftover `/root/a11y-witness` references: `ansible/files/a11y-gate-heartbeat.service` (lines 26, 32), `src/control-plane-checkout.ts:8` (comment), `src/fleet-converge.test.ts:304-305`, and `src/deploy-reached-no-hosts.test.ts:35`. `fleet-playbook.ts` still `cd`s into `CONTROL_PLANE_CHECKOUT`.
3. The `judgeLaidLayer` remedy text in `src/fleet-auto-off.ts` (about line 562) still names `scripts/lay-layer.ts`. The header's second sentence still refers to `controlPlaneCheckout()`.
4. The 10 path-layout failures above were not confirmed on a clean `main` run. The reasoning is that none of those files reads the changed code.

Closes a11ign/a11ign#5306
