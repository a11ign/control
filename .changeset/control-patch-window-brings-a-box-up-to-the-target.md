---
"@a11ign/control": minor
---

The patch window brings a box below the fleet's target build up to it, a feature update included (a11ign/a11ign#4897, under #4405, chairman amendment a11ign#4795: "a box below the target is patched, never excluded"). `ansible/patch.yml` takes `patch_target_release` (a release name such as `25H2`) and `patch_target_build` (`<CurrentBuild>.<UBR>`), both read from the fleet by the caller and both empty by default. With a target the window lifts the feature deferral, writes `TargetReleaseVersion`, `TargetReleaseVersionInfo` and `ProductVersion`, adds `Upgrades` to the categories and gives the reboot a longer timeout; every one of those is restored or removed in the `always`, and the removal is read back. Each box's last task fails it, by worker number, when its build is below the target or cannot be read. With no target the play is what it was.

Two things the caller does not do yet: no wrapper (`fleet:patch`, the patch-window timer) reads the target from the fleet and passes `-e`, so the window as scheduled still runs without one; and nothing has run the `Upgrades` path on a box (the live window is its own VERIFY row). `ansible/roles/worker/defaults/main.yml` is deliberately untouched: it is hashed into `provisionRevision`, and these values belong to the window, not to what is provisioned.
