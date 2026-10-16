Row a11ign/a11ign#5596. A pin bump merges, the plane's HEAD holds the new lockfile, and `node_modules/` still holds the release before it: `fleet:deploy` refused, and a human ran `pnpm install --frozen-lockfile` by hand (a ruling each time). The play now repairs that one state itself.

Acceptance: `git grep -q "the repair is pnpm install --frozen-lockfile in" -- ':!*.test.ts' ':!.acceptance'`

The job cannot run the Region's test files from its acceptance block: the gate refuses a command it cannot honestly run (`needs token` for the `fleet-playbook.ts` import closure, and any command naming `src/layer-checkouts.ts` is refused as reaching the fleet). The controls are measured under Evidence. This line is the job-runnable part: it proves the remedy the repair writes is in the tracked source (non-test files).

## What changed

- `src/fleet-playbook.ts`: `moveControlPlane` judges the installed layers through `installedLayersJudged`. When the judgement is repairable it runs `installLayersAndReread`: it says so on stdout, runs `pnpm install --frozen-lockfile` in the plane's checkout once, reads again, and refuses (naming the install that ran) if the layers still disagree. Nothing is written to the plane on a disagreement.
- `src/layer-checkouts.ts`: `installedLayersJudged` returns `repairable`. Repairable is `locked === declared && held !== declared`, and only when nothing else refuses AND nothing is noted (`notes.length === 0`). A layer behind its own lockfile means an install would lay the OLD lockfile for it too, so a mixed state (one layer lagging its declaration beside another layer behind its own plane) is refused, not repaired. Fixes the NOT CONVINCED verdict on control#115.
- Tests live in the two Region files, as the row requires:
  - `src/layer-checkouts.test.ts` (11 judgement controls): positive control (repairable), read names the importer's release, equal not reported, no release installed with the lockfile declaring it (repairable), no release installed and the lockfile naming none (refused), behind-plane note (not repairable), mixed state (not repairable, the lag still named), clone, no line, unreadable plane, unreadable lockfile.
  - `src/fleet-playbook.test.ts` (9 move controls): dry read is read-only, lag repaired by ONE frozen install then moved, install that does not bring layers into step is refused with no move, unreadable plane not repaired, plane behind its own lockfile not repaired (move proceeds), mixed state refused before any write with no install, positive control in step (read then write), unreadable plane stops the first write.
- `src/layer-installed-lag.test.ts`: deleted; its tests now sit in the Region files. Main's #5556 test "the first write is never asked when the installed layers lag" is replaced by the repair control, because a lockfile that declares the release now gets one frozen install before the move, so "only the read reached the plane" is no longer the rule.
- `.changeset/fleet-deploy-installs-the-layers-5596.md`: patch.

## Decisions

- Only `--frozen-lockfile` is ever run. `--no-frozen-lockfile` is refused by the test that pins the frozen form.
- The dry read (`--apply` off) never reaches `moveControlPlane` for `patch.yml`, and `deploy.yml` has no dry-run path, so the read-only `installedLayersRefusal` is the dry-read control: it names the repair and asks nothing but the read.

## Evidence (measured 2026-10-16, worktree `~/repos/control-wt-5596`)

- `node --import tsx --test src/fleet-playbook.test.ts`: `ℹ tests 163 / ℹ pass 163 / ℹ fail 0`.
- `pnpm run typecheck`: exit 0. `pnpm run layout-check`: ok (410 files).
- `src/layer-checkouts.test.ts` cannot run as a whole in this checkout: its top level needs `packages/nvda-worker` (absent here) and imports `@a11ign/toolchain/lib/git-sandbox`, which the lockfile's `@a11ign/toolchain@0.1.7` does not provide. Pre-existing on main; not changed here. Its 11 judgement controls were run through a temporary harness built from the file's tail (removed afterwards): `ℹ pass 11 / ℹ fail 0`.
- Mutation, `notes.length === 0` removed from line 340: the judgement file fails 1 (the mixed-state control); the move file fails 1 (the mixed-state move control). Restored from a scratchpad copy, `diff`-identical.
- Mutation, `--frozen-lockfile` swapped for `--no-frozen-lockfile` in `installLayersAndReread`: the repair controls fail. Restored, `diff`-identical.
- Not run: `fleet:deploy` against any box (resource ban). The next pin bump's `fleet:deploy` log is the proof of the done-when.

Closes a11ign/a11ign#5596
