Row a11ign/a11ign#5504: the gate heartbeat unit still runs `gate-heartbeat.ts` from the laid copy `/root/a11y-witness/packages/control`, which a11ign#5440 removes. This change points the unit at control's own checkout (`/root/control`, the path `a11y-fleet-auto-off.service` already names, a11ign#5312) and moves the one test that pins the literal with it. **Nothing deploys from this change:** it is a pull request to control and no host moves. The install on the plane (the row's Change 2) is `orchestrator`'s, and the patch window's 02:00 failure is not fixed here.

Acceptance:

```bash
cd /home/agent/repos/wt-5504-control && grep -q '^ExecStart=.*/root/control/src/gate-heartbeat.ts$' ansible/files/a11y-gate-heartbeat.service && node --test src/gate-heartbeat.test.ts
```

The first two clauses prove the unit names control's own program and no longer names the laid copy. The `node --test` line runs the file that pins the literal (27 tests, plain `node:test`, no loader).

**As run (measured, 2026-10-15, at this head):** before the unit edit, with the test's literal changed to `/root/control`, `src/gate-heartbeat.test.ts` fails 1 of 27 (the unit still named the laid path). After the unit edit it passes 27 of 27. The stale-path count in the unit was `1` before the change and is `0` after. `pnpm run typecheck` exits `0`. `pnpm test` (rstest, the scripts suite) passes 45 tests in 8 files. `pnpm run layout-check` is ok. The control repo has no `lint` script, so no lint was run.

## What changed

- `ansible/files/a11y-gate-heartbeat.service`: `ExecStart` runs `/root/control/src/gate-heartbeat.ts` through the `/opt/a11y-tsx` loader. The comment beside it now names the `/root/control` checkout and says `gate-heartbeat.test.ts` holds the line to that literal.
- `src/gate-heartbeat.test.ts`: the `ExecStart` pin names `/root/control`.
- `.changeset/gate-heartbeat-runs-own-checkout-5504.md`: patch.

## Open, not in this Region

1. The row names `src/control-plane-checkout-is-one-fact.test.ts` as the test that held the literal. **That file is not in the tree** (no tracked file has that name on `main`); several comments refer to it. The literal is held here by `src/gate-heartbeat.test.ts`, and the auto-off unit by `src/fleet-auto-off.test.ts` (#4571 and #5312). The stale comments are left for the row that owns them.
2. The plane's installed units still name the laid path until `orchestrator` runs the install (row Change 2). `fleet:control-host-install` is a fleet command and was not run here (resource ban).

Closes a11ign/a11ign#5504
