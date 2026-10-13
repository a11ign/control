Row a11ign/a11ign#5374, the first control step of the carried-original work: six Region test files stop reaching `../../worker-fleet/src/` for the carried originals and take them from `@a11ign/screenreader-fleet`'s package subpaths instead. PARTLY DONE: two lines in the Region still match the row's grep, and they are stated blockers, not oversights. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-5374-control && ! git grep -nE "(\.\./)+worker-fleet/src/" -- src/worker-fleet-carried.test.ts src/control-owned/display-mode.test.ts src/control-owned/fleet-consistency.test.ts src/control-owned/fleet-env.test.ts src/control-owned/worker-port.test.ts src/fleet-playbook.test.ts'
```

The row's own Acceptance is `git grep -q -E "(\.\./)+worker-fleet/src/"` over `origin/main` for the six Region files. This command is that grep, pointed at this worktree rather than `origin/main`. It is NOT yet satisfied: it prints two lines, so it fails.

- `src/control-owned/display-mode.test.ts:367`: `HARNESS` reads `display-mode-harness.ps1` by path. The harness is at the `v0.9.0` tag of screenreader-fleet but is not in any published tarball, so there is no package export to import. Needs `answer:orchestrator` for the destination (see Blockers).
- `src/fleet-playbook.test.ts:37`: `protocolVerdict` is imported from `protocol-guard.ts` by path. `./protocol-guard` is not exported at the 0.9.0 pin; it is in 0.11.0. The pin is not bumped without a ruling.

## Before and after

- Before (`origin/main`): the six Region files reach `../../worker-fleet/src/` for the carried originals, the protocol guard, the display-mode harness, and the fleet-env / fleet-consistency copies.
- After (this worktree): four of the six reach nothing by path. The two lines above remain, and both are blocked on a ruling.

## What changed

- `package.json`: `@a11ign/screenreader-fleet` `0.9.0` added as the first devDependency. `pnpm-lock.yaml` is updated by `pnpm install` from the lockfile. `dependencies` stays `{}` (ADR 0012).
- `scripts/package-manifest.test.ts`: `TOOLING` names the six devDependencies, the new one included.
- `src/worker-fleet-carried.test.ts`: the originals come from the `@a11ign/screenreader-fleet/*` subpath imports (`http`, `env`, `flags`, `health`, `consistency`) rather than `../../worker-fleet/src/`. The consistency fixture is restored, including the `edgeUpdaterGuard` cases.
- `src/worker-fleet-carried.ts`: `readField` reads dotted paths through `valueAt`. `edgeUpdaterGuard.state` is added to `REPORTED_ONLY` (#5021, #4405), matching the 0.9.0 text.
- `src/control-owned/fleet-env.test.ts`: imports from `@a11ign/screenreader-fleet/fleet-env`. `namedInventoryWorkers` is given `groupVarsPath` explicitly. The package default points into the monorepo's `ansible/`, and its `catch` returns `[]` silently.
- `src/control-owned/fleet-consistency.test.ts`: imports from `@a11ign/screenreader-fleet/fleet-consistency`. The `REPORTED_ONLY` check accepts a dotted path (`reportsPath`), with positive controls for a leaf the guard does not produce and a root the worker does not report.
- `src/control-owned/worker-port.test.ts`: `DEFAULT_WORKER_PORT` from `@a11ign/screenreader-fleet/fleet-env`.
- `src/control-owned/display-mode.test.ts`: `SCRIPT_PATH` resolves `set-display-mode.ps1` from the package's `src/provisioning` (in the 0.9.0 tarball). The `SET_DISPLAY_MODE_SCRIPT` text assertions are removed; they are owned upstream by screenreader-fleet's `display-mode.test.ts` (#5350).
- `src/fleet-playbook.test.ts`: the stamp test reads `stamp-provision-revision.ps1` from the package's `src/provisioning`. Its assertions are unchanged.

## Verification

- `pnpm typecheck` (`tsc --noEmit`): exit 0.
- `pnpm test`: 44 tests in 8 files, pass, exit 0, run in this worktree. Earlier, the six Region files were also run against a scratch layout (`nvda-worker` v0.13.0, screenreader-fleet `v0.9.0`, `packages/` beside the control copy) at 171/171, because the layer resolver refuses an absent layer.
- `pnpm run lint`: control has no `lint` script, so it was not run.

## Blockers

Stated on row #5374 and not worked around:

1. `display-mode.test.ts:367` (the harness). Needs an answer from `orchestrator` on the destination: (a) keep reading it from a laid checkout at the pin under a path control names; (b) control keeps a copy; or (c) screenreader-fleet publishes the harness as an export. Recommendation: (c), or (a) with the destination named.
2. `fleet-playbook.test.ts:37` (`protocol-guard`). Needs a ruling on bumping the screenreader-fleet pin to 0.11.0, which exports `./protocol-guard`.

Also out of the Region but on the same grep (the row's Acceptance is scoped to the six, so these do not block it): `src/fleet-playbook.ts:83`, plus reaches in `doctor.test.ts`, `lab-job.ts`, `fleet-auto-off.ts` and others. These are the #5312 leftovers.

## Closes

Closes: none -- the row is partly finished; its Acceptance fails on the two blocked lines above, and it is not closed until both are ruled.
