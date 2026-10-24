A11-204 (https://linear.app/a11ign/issue/A11-204/a11y-worker-11-serves-old-worker-code-nvda-worker-v090-that). `fleet:deploy` could not replace the worker code on `a11y-worker-11`, and `fleet:status` did not flag a box serving other worker code.

What the change does: `fleet:deploy` runs the role's `worker-task.yml` (the `a11ysrv` registration, moved out of `tasks.yml` and imported back there) after the install and before the restart, reads the registered action back from the scheduler and asserts it is the published launcher. `fleet:status` reads `/health.code` from every reachable box as the fourth field of the build split, names the boxes under each hash, and exits 3 on a split or on a reachable box that reports none.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
node --test src/fleet-status.test.ts src/control-owned/deploy-converges-worker-task.test.ts src/control-owned/worker-task-launcher.test.ts src/control-owned/provision-stamp-inputs.test.ts src/control-owned/display-mode.test.ts
pnpm typecheck
# The live reading, read-only, from any host that reaches the fleet: exits 3 and names the boxes while the worker code is split, 0 once one code remains.
pnpm run fleet:status | grep -E 'fleet (BUILD SPLIT — Worker code|builds AGREE)'
```

**What the block shows:** one worker code is clean and named per box; two codes name each box under its hash and exit 3; a code split with Edge, NVDA, Windows and the updater all agreeing still fails; an unreported code fails; an unreachable box is no reading; `--json` keeps `codes`. `deploy.yml` runs `worker-task.yml` after the layer assertion and before `tasks/restart-worker.yml`, hands it the repo path and task name `provision-role.yml` hands the role, reads the action back and judges it against the published launcher; `tasks.yml` no longer defines the registration; each reader has a negative control. The `fleet:status` line is the live proof (on a box other than the fleet's, set `A11Y_INVENTORY` as `fleet:status` documents).

**After merge:** Chairman session: `pnpm run fleet:status` shows one `Worker code:` value across all boxes in its `fleet builds AGREE` line.

Closes A11-204
