---
"@a11ign/control": patch
---

The patch-window unit carries its control-plane key (a11ign/a11ign#5506): `ansible/patch-schedule.yml` renders `Environment=A11Y_PVE_KEY={{ patch_plane_key }}` into `a11y-fleet-patch-window.service`, so the 02:00 run no longer dies on `A11Y_PVE_KEY is required`. `patch_plane_key` has no default and is not committed; the playbook refuses when it is empty. Re-laying the unit on the plane is a fleet write (a11ign/a11ign#5511).
