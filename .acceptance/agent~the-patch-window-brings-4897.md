Row a11ign/a11ign#4897 (under #4405; reading a11ign#4894, chairman amendment a11ign#4795). The patch window can now bring a box below the fleet's target build up to it, a feature update included: with `patch_target_release` and `patch_target_build` set it lifts the feature deferral, sets `TargetReleaseVersion`/`TargetReleaseVersionInfo` (and `ProductVersion`) for the window, adds `Upgrades` to the categories, and removes the target and restores the role's deferral in the `always`, read back. Each box's last task fails it, by worker number, when its build is below the target or unreadable. With no target the play is unchanged.

Closes: none -- a11ign/a11ign#4897 cannot be closed from this repository; `product-manager` closes it at merge.

Acceptance:

```bash
cd /home/agent/repos/wt-4897-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "src/fleet-layer/patch-playbook.test.ts" --include "src/fleet-patch.test.ts"
```

**As run (measured, 2026-10-10):** `VERDICT pass: 35 tests in 2 files`, 0 skipped, at this branch's head (`ansible-playbook` is installed on this machine, so the behavioural tests ran rather than skipped). **The row's command as written does not run these files:** `pnpm exec rstest run src/fleet-layer/patch-playbook.test.ts src/fleet-patch.test.ts` finds "No test suites found" in BOTH files, including `fleet-patch.test.ts`, which this change does not touch, because control's rstest config (`scripts/rstest/rstest.config.ts`) carries the `node:test` shim and without `--config` the files are not suites. `ci.yml` uses the form above (`--include`). `product-manager` owns the row's Acceptance and should amend it to this form.

## What changed

- `ansible/patch.yml`: the target variables (empty by default), the lifted names and values, the categories, the typed `win_regedit` write and a string-safe read-back, the reboot timeout (7200 s with a target, 1800 s as before without), the removal of the target values in the `always` on every run with its read-back, and the closing task tagged `patch_target_verdict`. The input check is folded into the existing first assert (tagged `patch_target_inputs`) so the busy check stays where `refusesOnBusyBeforeChanging` reads it.
- `src/fleet-layer/patch-playbook.test.ts`: six tests (the no-target negative control, the target set, the removal in `always`, the closing task below/at/above/unreadable/no-target, the input shapes), and the "plays declares no deferral values of its own" regex now permits only the NAME `DeferFeatureUpdatesPeriodInDays` beside the quality one.
- `.changeset/control-patch-window-brings-a-box-up-to-the-target.md` (minor).
- Not touched, with the reason: `ansible/roles/worker/defaults/main.yml` (in the Region, but hashed into `provisionRevision`, which is a MUST_MATCH cache key, so any edit there re-provisions the fleet; the target values belong to the window and are not provisioned) and `src/fleet-patch.test.ts` (it tests the wrapper, which this row does not change).

## Evidence (all run here: no fleet, no lab, no worker)

- **Behavioural, through the real `ansible-playbook`:** the play's own `vars` templated over the role's real defaults (`evaluatedVars`) for the categories and the lifted and written values with and without a target; the closing task and the input check run alone over invented local hosts via their tags.
- **Also run:** `update-deferral-policy.test.ts` and `fleet-playbook.test.ts` pass (they read the role's deferral list and the wrapper's playbooks). `provision-stamp-inputs.test.ts` and `layer-guests.test.ts` could not run here (`Cannot find module '../../../guards/src/walk-scope.ts'`, a checkout of a11ign/a11ign that only `ci.yml` lays over this repository), so the `checks` job is their verdict. `tsc --noEmit` printed nothing.

## Mutation (each against `ansible/patch.yml`, original restored from a copy and `cmp`ed identical; each broke exactly one test and no other)

- `Upgrades` never added: fails "with a target ... Upgrades is a category". `Upgrades` always added: fails the no-target negative control.
- Feature deferral never lifted: fails "with a target ...". Always lifted: fails the no-target negative control.
- Closing task never fires (`when: false`): fails "the closing task fails a box whose build is below the target". Fires with no target (guard removed): fails "passes a box at or above ... inert without one" -- **this one passed the first version of the control** (a below-target reading compares against an empty build as 0), and the unreadable box was added to make the control discriminate.
- Components compared as text instead of numbers: fails the same test (`26200.10000` against `26200.9457`).
- Removal of the target in the `always` deleted: fails "the target is REMOVED in the `always` ...".
- The reboot rule made conditional on the target: fails the no-target negative control.

## Not read, and not done here

- **That `Upgrades` installs through `win_updates` on this fleet's Windows edition, that `ProductVersion` is honoured beside the two values the row names, and how long a feature update's reboot takes**: nothing was run on a box (the resource ban). The live window on one box is the VERIFY row `product-manager` files at the merge. The 7200 s timeout is a guess, above the cumulative's 1800 s.
- **The caller.** Nothing passes `-e patch_target_release=... -e patch_target_build=...` yet: neither `fleet:patch` nor the timer's unit reads the target from the fleet. Without it the scheduled window runs exactly as before. That belongs to `src/fleet-playbook.ts` and the schedule, outside this row's Region, so it is filed as its own row.
- **Two variables where the row names one.** The row names `patch_target_release`; the closing check needs the build number and the registry needs a release name, and the fleet's `/health` reports only `windowsVersion` (a build), so a name cannot be derived without a build-to-release table written into the play. The caller supplies both.
- `ProductVersion` is a third registry name beyond the row's two (the policy writes it with them; Microsoft's CSP reference says it is set together with the target); it is removed with them.
