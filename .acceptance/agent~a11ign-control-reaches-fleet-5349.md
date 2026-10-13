Row a11ign/a11ign#5349, THIRD of three pull requests that split a11ign/a11ign#5344 by module: the `fleet-env` and `fleet-consistency` copies. #5344's first pull request (`cli-flags`, `e25a9d0`) and #5346 (`worker-http` and the `check-worker-code` path, `aae4e18`) are merged, so this carries #5344's whole Acceptance, which holds only once all three have landed. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-5349-control && ! git grep -nE "worker-fleet/src/(cli-flags|fleet-env|worker-http|fleet-consistency|worker-health|worker-code-check|check-worker-code)" -- src scripts ":(exclude)src/fleet-layer" ":(exclude)src/worker-fleet-carried.ts" ":(exclude)src/worker-fleet-carried.test.ts" ":(exclude)src/with-control-plane-fleet.test.ts"'
```

The command is the row's own Acceptance, pointed at this worktree rather than `~/repos/control` at `origin/main`: at `origin/main` `775407e` the same grep names the seven lines this change moves, so it can only pass once this lands. The `src/fleet-layer` tests are excluded by the row's own command, as they are the core's relocated tests and read the layer through `packages/worker-fleet`.

## Before and after

- Before (`origin/main` `775407e`): `git grep` names `fleet-build-incident.test.ts`, `fleet-discover.test.ts`, `fleet-playbook.ts`, `fleet-status.test.ts`, `fleet-switch.test.ts`, `fleet-watch.test.ts`, and the comment in `with-control-plane-fleet.ts` (7 lines; the comment names `packages/worker-fleet/src/fleet-env.ts`, which the row's grep does not match and this change rewords anyway).
- After (this worktree): the row's grep prints nothing.

## What changed

- `src/fleet-playbook.ts`: `WORKER_GROUP` and `groupPerLine` come from `./worker-fleet-carried.ts`, merged into the existing carried import.
- `src/fleet-discover.test.ts`, `src/fleet-switch.test.ts`: `workersFromInventory` from `./worker-fleet-carried.ts`.
- `src/fleet-build-incident.test.ts`, `src/fleet-watch.test.ts`: `fleetConsistency` from `./worker-fleet-carried.ts`.
- `src/fleet-status.test.ts`: `fleetConsistency`, `MUST_MATCH` and `REPORTED_ONLY` from `./worker-fleet-carried.ts`; its `import type { requestJson }` line already came from the carried copy.
- `src/with-control-plane-fleet.ts`: a comment names the module by its package export, `@a11ign/screenreader-fleet/fleet-env`, which `packages/worker-fleet/package.json` exports.
- `src/worker-fleet-carried.test.ts`: a new test that the six importers above import the carried copy and name neither `fleet-env` nor `fleet-consistency` by path, with the positive control (each must import `./worker-fleet-carried.ts`) as the cli-flags test has.
- No carried declaration changed: `WORKER_GROUP`, `groupPerLine`, `workersFromInventory`, `fleetConsistency`, `MUST_MATCH` and `REPORTED_ONLY` were already carried whole, and `worker-fleet-carried.test.ts` already compares each with its original.
- `.changeset/control-carries-fleet-env-5349.md` (patch; `src/` is releasable).

Where the originals are laid: `worker-fleet-carried.test.ts` loads them from `../../worker-fleet/src/` (a checkout beside the core, as CI lays it), so the comparisons read the originals rather than a stale copy of them.

## Closes

Closes a11ign/a11ign#5349
