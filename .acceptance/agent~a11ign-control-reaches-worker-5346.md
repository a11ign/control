Row a11ign/a11ign#5346, step 1b of ruling B (a11ign/a11ign#5335, split from #5344): `fleet-auto-off` and `fleet-status`'s test take `requestJson` from `worker-fleet-carried.ts` instead of `worker-fleet/src/worker-http.ts` by sibling path, and the `check-worker-code` reader in `layer-checkouts.test.ts` goes through the layer resolver rather than naming `packages/worker-fleet/src/check-worker-code.ts` as a literal. The row's Region is those five files; the `fleet-env` and `fleet-consistency` imports are the third row, a11ign/a11ign#5349, which is blocked by this one.

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-5346-control && ! git grep -nE "worker-fleet/src/(worker-http|check-worker-code)" -- src scripts ":(exclude)src/fleet-layer" ":(exclude)src/worker-fleet-carried.ts" ":(exclude)src/worker-fleet-carried.test.ts" ":(exclude)src/with-control-plane-fleet.test.ts"'
```

The grep is the row's own Acceptance, run on this branch's tree (as #5344's was on its own), so it reads what this PR leaves behind. At `origin/main` `f0d4cbb` the same pattern prints 5 lines, all of them in this change; on this branch it prints nothing. Once this lands, `origin/main` reads the same way. `src/*.test.ts` run only laid over the core (`ci.yml`), so they were run in a lay, below.

## Mutation and before/after (measured in a scratch lay; the lay's copy was mutated, never the worktree, and restored by `cp` from a saved copy, verified with `diff`)

The lay is the control worktree's `src`, `ansible`, `layers.json`, `deploy-pins.json`, `CLAUDE.md`, `README.md` and `package.json` over the core checkout's `packages/worker-fleet`, `packages/nvda-worker`, `packages/guards`, `packages/lab` and `scripts/`. `origin/main` is the baseline, laid the same way.

| file (`node --test`) | origin/main baseline | this branch |
|---|---|---|
| `fleet-auto-off.test.ts` | 116 pass, 1 fail | 116 pass, 1 fail |
| `fleet-status.test.ts` | 82 pass, 0 fail | 82 pass, 0 fail |
| `layer-checkouts.test.ts` | 24 pass, 0 fail, 1 skipped | 24 pass, 0 fail, 1 skipped |
| `worker-fleet-carried.test.ts` | 10 pass, 0 fail | 11 pass, 0 fail (the new test) |
| `control-has-no-dependencies.test.ts` | 3 pass, 0 fail | 3 pass, 0 fail |

- The one failure in `fleet-auto-off` is `#4571 every script the unit runs exists in the core it is laid into`: it wants `scripts/lay-layer.ts`, which neither the core checkout's HEAD (`08199153f`) nor its `origin/main` holds. It fails identically at baseline, so it is not this change. The skip in `layer-checkouts` is `#4363` (`BARE_TAGS_FROM`, which needs `scripts/lay-layer.ts` too). CI's own lay is the verdict for both.
- Mutation, the reviewer's (#82, "not convinced"): the `requestJson` binding removed from `src/fleet-auto-off.ts:131`, with `refuseUnknownFlags` still imported from the carried copy. The new test fails: `fleet-auto-off.ts: requestJson is not imported from the carried copy`. Before the rework this stayed green. Restored byte-identical.
- Mutation, by path: `src/fleet-auto-off.ts:131` put back to `../../worker-fleet/src/worker-http.ts`. The new test fails with the same message. Restored byte-identical.
- Mutation, the scan made to read nothing (its regex replaced with one that matches no import): the new test fails on its positive control, `fleet-auto-off.ts: no named import found, so the scan read nothing`. Restored byte-identical.
- The new test reads the named bindings of each import, so it pins `requestJson` itself, not the module's presence; the file's 11 tests pass unmutated.
- `eslint --no-ignore` over the five touched files: 0 errors, 127 warnings, the same count as at `origin/main`.
- `tsc --noEmit -p tsconfig.control.json`: 5 errors, the same set at `origin/main`, none in a touched file. They are `layer-launchers.test.ts` and `provision-stamp*.test.ts` needing `scripts/test-support/stamp-files.ts`, which the core checkout lacks.

## What changed

- `src/fleet-auto-off.ts:131`: `requestJson` imported from `./worker-fleet-carried.ts`. Line 130 still imports `sandboxGitEnv` from `worker-fleet/src/git-safe-env.ts`; the row does not name it, so it is left as is.
- `src/fleet-status.test.ts:11`: the type import of `requestJson` from `./worker-fleet-carried.ts`. Line 12 (`fleet-consistency`) is the third row's and is untouched.
- `src/fleet-auto-off.test.ts`: the closure expectation now names `packages/control/src/worker-fleet-carried.ts` and `packages/worker-fleet/src/git-safe-env.ts` where it named `worker-http.ts`; the `FLEET_FILE` fixture and the `sourceWithLayer` fixture follow.
- `src/layer-checkouts.test.ts`: `FIVE_READERS` takes the `check-worker-code.ts` path from `layerSourceDir("screenreader-fleet")` through the module-level resolver (aliased as `realLayerSourceDir`, because the local `layerSourceDir` binds to the nvda-worker checkout). The count stays five.
- `src/worker-fleet-carried.test.ts`: the new test. It reads the named bindings of every import in `fleet-auto-off.ts` and `fleet-status.test.ts`, requires `requestJson` among those imported from `./worker-fleet-carried.ts`, and requires that no other path supplies `requestJson` (the positive control is that at least one named import is found).
- `.changeset/control-carries-request-json-5346.md` (patch).
- Not changed: `src/code-drift.ts`'s literal in `FIVE_READERS` (the row does not name it).

Closes a11ign/a11ign#5346
