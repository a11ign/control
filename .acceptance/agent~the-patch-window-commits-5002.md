Row a11ign/a11ign#5002 (parent #4405, serves #4979's reading). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5002-control && pnpm exec rstest run src/fleet-layer/patch-playbook.test.ts src/fleet-patch.test.ts
```

**As run (measured, 2026-10-11):** every test in both files passes, including the three new `a11ign#4979` tests; `pnpm run typecheck` is clean. The row's command was run with `cd` pointed at this worktree, the control repository's checkout for this branch.

## What changed

- `ansible/patch.yml`: in the install block, before `win_reboot`, three tasks gated on `patch_switch_pending` (an installed item whose categories include `Upgrades`, AND `reboot_required`). (1) `UsoClient.exe StartInstall` through `win_shell`. (2) `bcdedit /enum all`, retried up to 18 x 10 s until a SafeOS-shaped entry appears. (3) `fail`, `<host>: staged but not switched`, printing the BCD entries. The restart is still the play's own conditional `win_reboot`; the restore and target removal in `always` are untouched, and a refusal runs through them.
- `src/fleet-layer/patch-playbook.test.ts`: three tests. Structure: commit, read and refusal precede the restart and are gated (each removed or ungated in a mutated copy). POSITIVE (real `ansible-playbook`, invented install result and BCD): Upgrades item staged, no SafeOS entry, fails naming `a11y-worker-6`; with an entry, passes. NEGATIVE: a cumulative-only pass, an empty pass, and an Upgrades item with no restart asked are not refused whatever the BCD reads, and the no-target categories are unchanged.
- `.changeset/the-patch-window-commits-5002.md` (`ansible/` is releasable).

## Invocation, and its documentation

`UsoClient.exe StartInstall`: **not Microsoft-documented.** Microsoft publishes no reference for `usoclient`; the command set (`StartScan`, `StartDownload`, `StartInstall`, `RestartDevice`, `ResumeUpdate`, `ScanInstallWait`) is taken from third-party guides (found by one web search, not independently confirmed), which describe `StartInstall` as installing downloaded updates and `RestartDevice` as the orchestrator's own restart. `StartInstall` was chosen because the row keeps the restart as `win_reboot`. It is asynchronous and silent, which is why the BCD read, not the command, is the verdict. **That it commits the switch is the row's hypothesis, not a reading**: the live window decides. If no entry appears, the next row is the installer from the staged media.

## Not established

- The SafeOS pattern (`$WINDOWS.~BT|SafeOS|winpe\s+Yes`) comes from Setup's log text in #4979 and the usual shape of a WinPE entry; no box was read here (resource ban).
- The `win_updates` result's `updates.<id>.categories` / `.installed` shape is as the module documents it, not read off a worker.

## Mutation

Fail task's refusal `when` replaced by `false` (the SafeOS check removed): exactly one test fails, `a11ign#4979 POSITIVE`. Restored from a `cp` backup, `diff` identical.

Closes a11ign/a11ign#5002
