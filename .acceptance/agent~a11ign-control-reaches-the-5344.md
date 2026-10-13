Row a11ign/a11ign#5344, FIRST of three pull requests: the `cli-flags` module. The row's Region is 17 files and its text says to split by module above 8, so this one carries the 8 Region files that name `cli-flags`; the other modules are the two rows named under "Not done here". Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-5344-control && ! git grep -nE "worker-fleet/src/cli-flags" -- src scripts ":(exclude)src/fleet-layer" ":(exclude)src/worker-fleet-carried.ts" ":(exclude)src/worker-fleet-carried.test.ts" ":(exclude)src/with-control-plane-fleet.test.ts" && pnpm test'
```

The grep is the row's own Acceptance narrowed to the one module: at `origin/main` `8ab6a70` it prints 7 lines (the row's 19 less the 12 that name another module), and nothing here. `pnpm test` is this repository's own suite (`scripts/**`); `src/*.test.ts` run only laid over the core (`ci.yml`), so they were run in a lay, below.

## Mutation and before/after (the lay's copy was mutated, never the worktree; the lay is re-cut from the worktree after each)

- Unmutated, in a lay of this worktree over the primary core's checkout with `packages/worker-fleet` laid (measured, `node --test`): `worker-fleet-carried` 10 pass 0 fail (was 9: the new test), `control-has-no-dependencies` 3/0, `fleet-playbook` 125/0, `fleet-converge` 21/0, `lab-pipeline` 18/0, `lab-failed-units` 11/0, `fleet-status` 82/0, `fleet-discover` 35/0.
- `fleet-auto-off` 116 pass 1 fail and `layer-checkouts` 23 pass 1 fail: the SAME single failure at `origin/main` before this change (`#4571 every script the unit runs exists in the core it is laid into`; `layerSourceDir("nvda-worker") is the directory workerSourceDir() names`), both about this scratch lay's nvda-worker and not about `cli-flags`. CI's own lay is the verdict for those two.
- One of the six imports pointed back at `../../worker-fleet/src/cli-flags.ts` (`lab-failed-units.ts`): the new test fails (1 fail), `control-has-no-dependencies` still passes, since a relative import is allowed there.
- The scan made to read nothing (`specifiers` empty): both scans fail, the new one and the five-module one it is modelled on.
- `eslint --no-ignore` over the 8 files: 0 errors (68 warnings, all `no-magic-numbers` in lines this change did not touch). `tsc --noEmit -p tsconfig.control.json` in the lay: no error in a file this change touches (the lay reports others, in `layer-launchers.test.ts`, which needs `scripts/test-support/` the primary core's checkout lacks).

## What changed

- `src/fleet-auto-off.ts`, `fleet-converge.ts`, `fleet-playbook.ts`, `lab-failed-units.ts`, `lab-pipeline.ts`, `post-qualification-status.ts`: the `cli-flags` import names `./worker-fleet-carried.ts`. No carried declaration changed: `refuseUnknownFlags`, `flagValue` and the rest were already carried whole.
- `src/worker-fleet-carried.test.ts`: the new scan above.
- `src/control-has-no-dependencies.test.ts`: a comment named the sibling path as the example of what resolves from a raw checkout; it names the carried file now.
- `.changeset/control-carries-cli-flags-5344.md` (patch; `src/` is releasable).

## Not done here

- `worker-http`, `fleet-env`, `fleet-consistency` and the `check-worker-code` path string in `layer-checkouts.test.ts` (12 more lines, 10 files) are the next two rows, filed from this one: a11ign/a11ign#5346 (`worker-http` and the `check-worker-code` path) and a11ign/a11ign#5349 (`fleet-env` and `fleet-consistency`, blocked by #5346, carrying this row's whole Acceptance). The row's Acceptance as written holds when the last of them lands. No `fleet:*`, `lab:*`, `worker:*` or capture command was run (resource ban).

Closes a11ign/a11ign#5344
