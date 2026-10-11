Row a11ign/a11ign#5014 (parent #4405, item 2). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'set -e; C=/home/agent/repos/wt-5014-control; K=/home/agent/repos/wt-5014; rm -rf "${K:?}/packages/control/src"; mkdir -p "$K/packages/control"; cp -R "$C/src" "$C/ansible" "$C/layers.json" "$K/packages/control/"; jq "del(.version, .scripts, .devDependencies, .packageManager, .engines)" "$C/package.json" > "$K/packages/control/package.json"; [ -e "$K/packages/worker-fleet" ] || ln -s /home/agent/repos/a11y-witness/packages/worker-fleet "$K/packages/worker-fleet"; cd "$K"; pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include packages/control/src/fleet-lock.test.ts --include packages/control/src/fleet-auto-off.test.ts --include packages/control/src/fleet-playbook.test.ts'
```

**As run (measured, 2026-10-11):** `VERDICT pass: 255 tests in 3 files` (22 new `a11ign#5014` tests; 233 existed). The row's command as written (`cd /home/agent/repos/control && pnpm exec rstest run src/fleet-lock.test.ts ...`) prints `Command "rstest" not found` and exits non-zero: the primary control checkout has no `node_modules` carrying rstest, it holds `main` and so none of these files, and `fleet-auto-off.test.ts` imports `../../../scripts/lay-layer.ts`, which resolves only when control is laid under a core checkout. The form above is that lay (what `ci.yml`'s `checks` job does: `src/`, `ansible/`, `layers.json` over `packages/control` of a core worktree) and the core's own rstest config.

## What changed

- `src/fleet-lock.ts` (new): `takeFleetLock`, `readFleetLock`, `expireFleetLock`. One file, `runs/fleet-lock.json` on the control plane, reached through `sshToControlPlane` as the wake-proof ledger is, carrying `{operation, holder, takenAt, expiresAt}` and, once the unit has ended, `endedAt`. `readFleetLock(now)` answers `held`, `stale` (`expiresAt <= now`), `none` or `unreadable`; unreadable keeps. Each write is one remote step under `flock`, so two operations starting together have one winner.
- `src/fleet-playbook.ts`: `startPlaybookUnit` takes the lock for `deploy.yml`, `provision-role.yml` and `patch.yml` before `systemd-run`, refusing (exit 2, `REFUSING ...`) when a fresh, not-ended lock belongs to a different operation. The unit's end (`main`, after `followUnit`, before any exit; and a unit that failed to start) shortens `expiresAt` to `now + LOCK_GRACE_MS`.
- `src/fleet-auto-off.ts`: `DecisionInput.fleetLock`; `autoOffDecision` keeps with `fleet-lock-held` / `fleet-lock-unreadable` beside `play-in-flight` and ignores `stale`; `tick` reads it once per tick and `main()` passes the real reader.
- `.changeset/auto-off-keeps-every-5014.md` (`src/` is releasable).

## Decisions the row left open

- **Longest run** is the budget this command itself watches the unit for (`followBudgetMs`): `PLAYBOOK_TIMEOUT_MS[chosen] ?? DEFAULT_PLAYBOOK_TIMEOUT_MS` (4 h for `provision-role.yml` and `patch.yml`, 30 min for `deploy.yml`), and for `patch.yml` with a target the larger per-box `patchFollowBudgetMs`. No number is copied: a lock that expired under a run still being watched would fail at its one job.
- **An ENDED lock does not refuse a different operation** (it still keeps auto-off off for its grace). Read literally, `fleet:deploy` straight after a finished `fleet:provision` would wait up to 30 minutes. A `endedAt` field is the one addition to the row's `{operation, holder, takenAt, expiresAt}`.
- **A lock file that cannot be read is replaced by the next take** (and says so), since it names no operation to protect; auto-off keeps meanwhile.
- **A take that cannot be written stops the command** (exit 1): a run that auto-off may power the boxes out from under is not started. An END that cannot be written never fails a finished run; it says so and the lock expires on its own.

## Not established

- Nothing here ran on the control plane or a worker (resource ban). The remote step is exercised with the real `flock` and `node` against a directory standing in for the control plane's checkout; `node` and `flock` on the control plane are the same ones `fleet-wake.ts`'s proof ledger already needs.
- A wrapper whose terminal died leaves the lock at its full longest run (the unit outlives it and nothing ends the lock); that is the bounded, keep-awake direction, and a shorter end would need a hook inside the unit itself.
- The wider control `src/` suite in the laid layout: 27 of 1111 failed, the same 27 that fail at `origin/main` (1089 tests; sibling-layer imports of the laid copy), no failure moved.

## Mutation

Each applied to a `cp` backup, tests run (3 files), restored from the backup, `cmp` identical. Failing tests named are the only ones that failed:

- auto-off never keeps on `held`: `#5014 1`, `#5014 4`. Keeps on every reading but `undefined` (always fires): 24 fail, `#5014 1` among them.
- stale lock never ignored (always `held`): `#5014 2`, the read-boundary test, the end test.
- `unreadable` not kept: `#5014 3`, `#5014 4`.
- take never refuses: the refusal test and the two-at-once test. Take always refuses a held lock: the ended-lock test and the controls test.
- end clears instead of shortening: the end test and the ended-lock test. End by any holder: the ownership test.
- `sleep.yml` added to the lock plays: three tests. `patch.yml` removed: two.
- `main` never ends the lock after the follow: the wiring test. `main()` without `fleetLock: readFleetLock`: the wiring pin only.

Closes a11ign/a11ign#5014
