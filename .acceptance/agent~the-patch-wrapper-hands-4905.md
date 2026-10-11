Row a11ign/a11ign#4905 (follow-up of #4897, under #4405; chairman amendment a11ign#4795, "a box below the target is patched, never excluded"). `fleet-playbook.ts --playbook=patch.yml` now hands the play the fleet's target, so the scheduled window brings a box below it up to it. The target is read at run time and never written into a file.

Closes a11ign/a11ign#4905

Acceptance:

```bash
cd /home/agent/repos/wt-4905-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "src/fleet-playbook.test.ts" --include "src/fleet-patch.test.ts"
```

**As run (measured, 2026-10-11):** `VERDICT pass: 146 tests in 2 files` at this branch's head. The row's command as written is `cd /home/agent/repos/control`, the primary checkout, which is 121 commits behind `origin/main` and does not hold this change, so the path above is this worktree's. `pnpm run typecheck`: no output. The core's eslint (`--no-ignore`, run over copies laid at `packages/control/src/` in a scratch core tree): 0 errors, 98 warnings, all `no-magic-numbers` and the same kind as the file already carried.

## The first decision (written on the row before code: a11ign#4905, comment 6103785735)

**`/health`'s `windowsVersion` does not carry what `patch.yml` needs.** It is `Win32_OperatingSystem.Version`, `<major>.<minor>.<CurrentBuild>` (`screenreader-worker/src/server.mjs`, `WINDOWS_VERSION_SCRIPT`): no UBR and no release name. So `/health` says WHICH boxes are on the fleet's highest build and nothing more. Those boxes are asked for the registry's `CurrentBuild.UBR` and `DisplayVersion` in ONE read of ONE key (the one `patch.yml`'s closing task reads), so the build and the release cannot disagree. A build-to-release table was refused: it needs a row added before each feature release, and a build the table lacks would silently pass nothing.

## What changed

- `src/fleet-playbook.ts`: `fleetTopBuild`, `patchTargetReadCommand`, `parsePatchTargetRead`, `patchTargetOf` (the read injected, a throw is "could not ask"), `patchTargetExtraVars`, `patchTargetLine`, `patchFollowBudgetMs`. `patchPlan` takes the reading and prints it. `enforcePatchGate` returns `{ dryRun, target, followBudgetMs }`; `startPlaybookUnit` appends the extra vars; `followUnit` is given the budget. A dry run reads the target too (a read), so the plan names what the run would pass.
- Tests: ten in `src/fleet-patch.test.ts` (section 6), and the two existing `patchPlan` calls pass a reading.
- `.changeset/control-the-patch-wrapper-hands-the-target.md` (minor).

## Mutation (each against `src/fleet-playbook.ts`, original restored from a copy and `cmp`ed identical)

- Extra vars never emitted: fails "guests reporting builds yield a target, and BOTH -e reach the argv". Emitted with no target: fails the negative control "no readable build passes NEITHER -e".
- UBR compared as text: fails "the highest UBR wins as a NUMBER". Highest build picked as lowest: fails four (target, patch.yml's shapes, the plan, the budget), as expected of a wrong top build.
- Budget never scales: fails "the follow budget grows ...". Scales with no target: fails the same test's negative control.
- `+ patchTargetExtraVars(patchTarget)` dropped from the dispatch: fails "the dispatch CALLS the target's extra vars", while every pure-function test stays green, which is why that test exists.

## Not measured, and not done here

- **The follow budget is derived, not measured.** No feature-update run has been timed (a11ign#4897 records 7200 s as "a guess"; the resource ban stops this row from running one). The per-box 2.5 h is the play's 7200 s `win_reboot` ceiling plus 1800 s, and the VERIFY row of #4897 is where a reading replaces it. Why it matters: `followUnit` giving up does not stop the play, and the next scheduled attempt `systemctl stop`s the unit before starting one, so a budget below the run is a run killed in flight.
- **The ad hoc read has not run against a box** (the resource ban). Its output shape is parsed from ansible's `minimal` callback and pinned by tests over that shape; the first live window is the VERIFY row.
- **A target read from a subset** (a top-build box that did not answer) is used and says so in the plan: the install is whatever Windows Update offers, so a target one UBR low weakens the closing verdict and never the install, and passing none would be the window as it was, silently.
