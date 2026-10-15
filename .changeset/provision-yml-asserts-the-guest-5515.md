---
"@a11ign/control": patch
---

`ansible/provision.yml` (the manual path, not `fleet:provision`) checks every git call in its guest fast-forward and asserts the guest's HEAD is the commit it resolved, as `provision-role.yml` does since a11ign/a11ign#5512 (a11ign/a11ign#5515). Before, the step was three bare commands, so its exit status was `rev-parse`'s and a merge that could not run printed `changed` on a box that never moved. The commit is resolved on the guest (`rev-parse --verify`), so a commit the guest does not hold fails the box and is named; the report line reads the last line of the output rather than the whole of it. The short sha the step printed is gone: a short sha cannot be compared with the full one the assertion checks.
