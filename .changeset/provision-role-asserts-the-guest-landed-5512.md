---
"@a11ign/control": patch
---

`fleet:provision` no longer hands the guests a commit of the control repository they cannot hold: the role fast-forwards each guest's core checkout to its own `origin/main`, checks every git call, and fails the box by name when the guest is not on the commit it resolved (a11ign/a11ign#5512).
