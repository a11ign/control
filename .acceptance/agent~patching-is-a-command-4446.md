Part of a11ign/a11ign#4446 (parent #4405). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-patch.test.ts'
```

The row's Acceptance as written (no `--config`) finds no `node:test` shim, the same fact #4445's acceptance recorded; the toolchain config carries it.

**As run (2026-10-10):** this worktree has no `node_modules`, so `rstest` itself was NOT run here. The same file ran under `tsx --test` against the laid core: `pass 21, fail 0`. The wider `src/` suite: 1174 pass, 13 fail, the same 13 on base (sibling-layer imports of the laid copy).

## Mutations (`cp` before, `cp` after, `diff` identical)

- busy filter -> `() => false`: the busy test fails (1).
- `apply ? "run" : "plan"` -> `"run"`: the dry-default test fails (1).
- `patch.yml` dropped from `LINK_GATED`: the hold test and the cannot-be-asked test fail (2).
- unit's `--apply` removed: the unit test fails (1). `--window-days=28` hardcoded: the window-variable test fails (1).
- Unmutated: 21 pass.

## What changed

- `src/fleet-playbook.ts`: `patch.yml` joins `PLAYBOOKS` and `LINK_GATED`. `enforcePatchGate` refuses a multi-box `--limit` without `--apply`, a box that cannot be asked, and a busy box; dry unless `--apply`; a completed apply writes `runs/fleet-patch-last-run.json`. `--scheduled` (needs `--apply` and the five window flags) decides attempt, wait, retry or last-day refusal (exit 4, `fleet-health: patch-window-missed`).
- `ansible/patch-schedule.yml`: installs `a11y-fleet-patch-window.{service,timer}`; the window is five playbook variables.
- `src/fleet-patch.test.ts`: 21 tests, each behaviour with a positive and a negative control.
- OUTSIDE the Region, each needed by a guard that failed without it: `src/fleet-playbook.test.ts` (allowlist and gate-message pins), `src/deploy-reached-no-hosts.test.ts` (`patch.yml` is now dispatched here), `src/fleet-auto-off.ts` + test (`LAUNCHABLE_PLAYBOOK_NAMES` is pinned equal to `PLAYBOOKS`; idle boxes must stay on during a patch), `ansible/files/a11y-fleet-auto-off.service` (follow-main must not run mid-patch), `.changeset/`.

## Not done here

- core `package.json` `fleet:patch` script: another repository.
- No fleet command was run; the dry run on the host is the row's Done-when 2, posted on the row.

Closes: none -- a11ign/a11ign#4446 is closed by `product-manager` at merge; a PR here cannot close a row there.
