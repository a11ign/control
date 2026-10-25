A11-205 (https://linear.app/a11ign/issue/A11-205/freeze-the-fleet-nothing-on-a-box-ever-upgrades-by-itself-upgrades-are), step 3 of 5. The fleet is frozen between upgrades (steps 1 and 2); this step makes the upgrade one deliberate run from the manifest and watches the fleet against it.

What the change does: `fleet:patch` is a chain (`deploy.yml`, `patch.yml` one box at a time, a read of every box against `deploy-pins.json`) that stops at the first failure and names the box; `patch.yml` takes its target only from the manifest (the KB is `win_updates`' `accept_list`), refuses a box above the manifest, installs the manifest's Node, NVDA and Edge, freezes again in `always:` and ends by reading every box. `fleet:drift` is the same read on a clock (hourly, read-only, `a11y-fleet-drift.timer`) with a record that `fleet:watch` mirrors for the announcement channel; `lab:job` leaves a drifting box out of the capture pool; the ADR and the README sections are added.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
node --test src/fleet-drift.test.ts src/fleet-patch.test.ts src/fleet-watch.test.ts src/fleet-playbook.test.ts src/wake-on-demand.test.ts src/fleet-build-incident.test.ts \
  src/control-owned/patch-playbook.test.ts src/control-owned/no-scheduled-install.test.ts src/fleet-pins.test.ts src/fleet-status.test.ts
# lab-job.test.ts reads the playbook with the `yaml` package, which this repository does not install (it runs laid in the core): run it where `yaml` resolves.
pnpm typecheck
pnpm test
# The playbooks parse, and the units are well formed.
for play in patch freeze-schedule lab-job; do (cd ansible && ANSIBLE_CONFIG=ansible.cfg ansible-playbook --syntax-check -i inventory.example.yml "$play.yml"); done
systemd-analyze verify ansible/files/a11y-fleet-drift.service ansible/files/a11y-fleet-drift.timer
# Read-only, against the live fleet (fleet.env supplies the control-plane host and key; nothing is changed, no record is written, no box is woken):
set -a; . ~/.config/a11ign/fleet.env; set +a
pnpm run fleet:drift                     # exit 3 while any box differs; names the box, the field, what it has and what the manifest wants
pnpm run fleet:patch -- --ref=main       # the plan for the whole fleet; no --apply, so nothing runs
```

**What the block shows:** the manifest is the only source of the upgrade's target; each kind of difference fails the drift read; the re-freeze is the last thing in the upgrade's `always:`; no unit control ships can start an installing play; the chain stops at the first failing play and names the box; a drifting box is absent from the pool `lab:job` dispatches.

**What it does not show:** an `--apply` run (nothing moves until a person edits the manifest), or the drift timer firing on the control plane (it runs `/root/control/src/fleet-drift.ts`, which follows `main`).

**After merge, run by the chairman session** (the ticket's Done-when names it, and the standing approval of 2026-10-17 covers running these plays from the control plane). Each step passes when its read-back says so; a pass for the whole is the timer list showing `a11y-fleet-drift.timer` and `a11y-fleet-freeze-daily.timer` with no `a11y-fleet-patch-window.timer`, and two journal firings of `a11y-fleet-drift.service` that read the manifest (exit 0, or exit 3 naming only the worker-code and a11y-worker-5 differences below). `pnpm run fleet:freeze-schedule` (installs `a11y-fleet-drift.timer` beside the daily freeze, reads both back), then `systemctl list-timers 'a11y-fleet-*'` and `journalctl -u a11y-fleet-drift.service` on the control plane for the first two firings, then `pnpm run fleet:deploy` across the fleet (the worker-code differences above are the rollout A11-204 left).

Refs A11-205
