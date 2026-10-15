The path half of #5506 is already on main (#5180 patch window, #5504 gate heartbeat both run `/root/control`). What remained: `a11y-fleet-patch-window.service` sets no `A11Y_PVE_KEY`, so `fleet-playbook.ts` throws at its first line.

`patch-schedule.yml` now renders `Environment=A11Y_PVE_KEY={{ patch_plane_key }}`. The variable has no default and no committed value (#85); the first play refuses when it is empty.

NOT DONE HERE: re-laying the units on the live plane is a fleet write needing `fleet:status` => `may proceed` and the key's path on the plane (`/root/.ssh` is unreadable from this session). Run `patch-schedule.yml` with `-e patch_plane_key=<path>` after merge; the heartbeat unit in main already names `/root/control`.

platform: systemd `Environment=`; nothing to reuse.

Closes a11ign/a11ign#5506

Acceptance:
```bash
ssh root@"${CONTROL_PLANE_HOST:?}" 'systemctl cat a11y-gate-heartbeat.service a11y-fleet-patch-window.service | grep -c "a11y-witness/packages/control"'
```
Expected output: `0`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
