---
"@a11ign/control": minor
---

`ansible/patch.yml` is the patch window (a11ign/a11ign#4445, under #4405): for each worker, one at a time, it refuses a busy box, lifts the quality-update deferral, installs the pending quality updates with `win_updates` (`reboot: false`), reboots only a box that installed something and Windows asked, restores `worker_update_deferral_policy` from the role in an `always` and reads it back, then reads `CurrentBuild.UBR`. A closing play fails when the readable boxes are on more than one build and names the odd ones; a box that cannot be read is `unreadable`, not a mismatch. Not run live: the first run is row E's.
