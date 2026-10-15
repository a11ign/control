The path half of #5506 is already on main (#5180 patch window, #5504 gate heartbeat both run `/root/control`). What remained: `a11y-fleet-patch-window.service` sets no `A11Y_PVE_KEY`, so `fleet-playbook.ts` throws at its first line.

`patch-schedule.yml` now renders `Environment=A11Y_PVE_KEY={{ patch_plane_key }}`. The variable has no default and no committed value (#85); the first play refuses when it is empty.

NOT DONE HERE: re-laying the units on the live plane is a fleet write needing `fleet:status` => `may proceed` and the key's path on the plane (`/root/.ssh` is unreadable from this session). Run `patch-schedule.yml` with `-e patch_plane_key=<path>` after merge; the heartbeat unit in main already names `/root/control`.

platform: systemd `Environment=`; nothing to reuse.

Closes a11ign/a11ign#5506

Acceptance:
```bash
grep -c "a11y-witness/packages/control" ansible/patch-schedule.yml
```
Expected output: `0`.

Mutation: none -- the test is a text pin of one rendered line; removing the line turns it red by construction.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Outside-Region: ansible/patch-schedule.yml — the row's Region names the live units, but the patch-window unit is laid by this playbook, which is where the missing env belongs
Outside-Region: src/fleet-patch.test.ts — pins the new Environment line beside the existing patch-schedule.yml text assertions
