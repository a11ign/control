Row a11ign/control#5596. A pin bump merges, the plane's HEAD holds the new lockfile, and `node_modules/` still holds the release before it: `fleet:deploy` refused, and a human ran `pnpm install --frozen-lockfile` by hand (a ruling each time). The play now repairs that one state itself.

Acceptance: `cd ~/repos/control && ! git grep -q "that this command does not make" -- src/layer-checkouts.ts && node --test src/layer-installed-lag.test.ts`

## What changed

- `src/fleet-playbook.ts`: `moveControlPlane` judges the installed layers through `installedLayersReading`. When the judgement is repairable it runs `installLayersAndReread`: it says so on stdout, runs `pnpm install --frozen-lockfile` in the plane's checkout once, reads again, and refuses (naming the install that ran) if the layers still disagree. Nothing is written to the plane on a disagreement.
- `src/layer-checkouts.ts`: `installedLayersJudged` returns `repairable`. Repairable is exactly `locked === declared && held !== declared`, and only when nothing else refuses. No release installed, a lockfile naming none, and a plane whose own lockfile is behind the declaration are unchanged (refusal, refusal, note).
- `src/layer-installed-lag.test.ts`: the #5155 controls beside the #5556 ones. (a) lagging then in-step: one `--frozen-lockfile` install, then the move; (b) lag that the install does not repair: one install, a refusal, no move; (c) unreadable plane: no install, refused; (d) plane behind its own lockfile: no install, the move proceeds with its note; (e) dry read `installedLayersRefusal`: read-only, installs nothing.
- `.changeset/fleet-deploy-installs-the-layers-5596.md`: patch.

## Decisions

- The dry read (`--apply` off) never reaches `moveControlPlane` for `patch.yml` (it returns first), and `deploy.yml` has no dry-run path, so control (d) of the row is the read-only `installedLayersRefusal`: it names the repair and asks nothing but the read.
- Only `--frozen-lockfile` is ever run. `--no-frozen-lockfile` is refused by the test that pins the frozen form (mutation below).
- The controls are in `src/layer-installed-lag.test.ts`, beside the existing `installedLayersRefusal` tests, not in the two files the Region names.

## Evidence (measured 2026-10-16, worktree `~/repos/control-wt-5596`, commit 2b10684)

- Acceptance chain above, run from the worktree: `ℹ tests 17 / ℹ pass 17 / ℹ fail 0`.
- `pnpm exec tsc --noEmit`: exit 0.
- Full `node --import tsx --test "src/*.test.ts"`: 969 tests, 957 pass, 11 files fail. The same 11 files fail on untouched `origin/main` in a scratch worktree, with the same error set: the core's `packages/control` layout and a toolchain subpath (`@a11ign/toolchain/lib/git-sandbox`) this checkout does not provide. No failure is new.
- `src/layer-checkouts.test.ts` cannot run in this checkout (the toolchain subpath above, on main too), so its assertions are not re-run here. No test pins the phrase this change removed.
- Fails before the change (positive control (a) and the dry-run and install-does-not-repair controls, run against `origin/main` with the new test file): `ℹ pass 12 / ℹ fail 5`. Two of those five (`equal … not reported`, `unreadable lockfile`) fail only because their `deepEqual` now carries `repairable`.
- Mutation: `--frozen-lockfile` swapped for `--no-frozen-lockfile` in `installLayersAndReread`: the repair controls fail (2 of 17); restored from a scratchpad copy, `diff`-identical, 17 of 17 again.
- Not run: `fleet:deploy` against any box (resource ban). The next pin bump's `fleet:deploy` log is the proof of the done-when.

Closes a11ign/control#5596

🤖 Generated with [Claude Code](https://claude.com/claude-code)
