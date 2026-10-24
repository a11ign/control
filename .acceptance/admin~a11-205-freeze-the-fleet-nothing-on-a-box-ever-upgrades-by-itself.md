A11-205 (https://linear.app/a11ign/issue/A11-205/freeze-the-fleet-nothing-on-a-box-ever-upgrades-by-itself-upgrades-are), step 2 of 5. Windows Update was deferred, not stopped; Edge's updater was held by a 15-minute task that raced it; the 28-day patch window moved the build forward on a clock; nothing re-asserted any of it between provisions.

What the change does: `roles/worker/tasks/freeze.yml` holds every lever that stops a box upgrading itself, runs on every provision, daily (`ansible/freeze.yml`, installed by `fleet:freeze-schedule`) and in `always:` of the Edge install and of `patch.yml`, and installs nothing. The deferral is deleted, the Edge guard only reports, NVDA's update checks are off and read back, and the patch window is removed.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
node --test src/control-owned/freeze-levers.test.ts src/control-owned/no-scheduled-install.test.ts src/control-owned/patch-playbook.test.ts \
  src/control-owned/edge-updater-guard.test.ts src/control-owned/edge-updater-firewall.test.ts src/control-owned/edge-updater-before-install.test.ts \
  src/control-owned/update-deferral-policy.test.ts src/control-owned/provision-stamp-inputs.test.ts src/fleet-patch.test.ts src/fleet-watch.test.ts src/fleet-playbook.test.ts
pnpm typecheck
pnpm test
# The playbooks parse, and the daily play's verdict runs over invented readings.
for play in freeze freeze-proof freeze-schedule patch provision-role; do (cd ansible && ANSIBLE_CONFIG=ansible.cfg ansible-playbook --syntax-check -i inventory.example.yml "$play.yml"); done
# NVDA's update checks: the module's Pester tests.
pwsh -NoProfile -Command 'Import-Module Pester -RequiredVersion 5.7.1; Invoke-Pester -Path ansible/collections/ansible_collections/a11y/worker/tests/unit/plugins/modules/a11y_nvda_updates.Tests.ps1 -Output Minimal'
# The proof on ONE box, read from the box through Ansible (installs nothing; refuses without --limit and refuses a busy box). It moves the control plane to the ref,
# so the ref is a simple branch name on origin (`a11-205-freeze-run`, kept until the pull request merges); about 8 minutes. After a merge, no --ref: it runs main.
pnpm run fleet:freeze-proof -- --limit=a11y-worker-13 --ref=a11-205-freeze-run
# The daily play over the whole fleet: a clean day reads "15 of 15 box(es) frozen. Put back: nothing. Not reached: none." and exits 0; runs/fleet-freeze-last-run.json on the plane is its record.
pnpm run fleet:freeze -- --ref=a11-205-freeze-run
```

**What the block shows:** every lever the ticket lists is in the freeze with its value, and the upgrade's lift drops exactly the five that stop Windows Update being asked; the apply scripts and the read-back take the same data; the deferral is gone from the role and deleted from the box; the Edge updater is frozen in the install block's `always:`; the detector calls no cmdlet that changes anything and keeps the record's shape; one block rule per discovered updater binary; the patch play lifts first and freezes last in `always:` and writes no registry value of its own; no unit control ships can start an installing play, the old patch window's unit is refused, and the freeze files reach no install module; the wrapper refuses the patch window's flags; `fleet-watch` no longer reads a patch window and clears the line it posted.

**What it does not show:** that a lever HOLDS. A value that reads back is a value that is stored. `fleet:freeze-proof` is that, on a box, and its output is in the pull request.

**After merge:** `pnpm run fleet:freeze-schedule` (installs `a11y-fleet-freeze-daily.timer`, removes the patch window's pair, reads both back), then `systemctl list-timers a11y-fleet-freeze-daily.timer` on the control plane (the patch window's timer must be absent), then `pnpm run fleet:provision` one box at a time (lays the Edge detector and the NVDA update settings; the freeze itself is already on all 15 boxes).

Refs A11-205
