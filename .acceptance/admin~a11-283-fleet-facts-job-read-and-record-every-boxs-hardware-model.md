A11-283 (https://linear.app/a11ign/issue/A11-283/fleet-facts-job-read-and-record-every-boxs-hardware-model-cpu-ram): `fleet facts submit --boxes <n|all|names> --label <key>` is a new kind of job in the fleet job service. It books its boxes like a capture's, wakes each, runs the read-only play `ansible/facts.yml` and records each box's make, model and machine type, serial, BIOS, CPU, RAM, disks, free space on the system drive, Windows build, TPM and Secure Boot state in `/etc/a11ign/fleet-facts.json`. `fleet facts show` prints the table; a box that did not answer keeps its last facts, marked stale.

What the change does: `src/fleet-facts/` (the parser, the facts file, the play-result reader, the real reader, the remote and local halves of `fleet facts`, the table), `ansible/facts.yml`, a `facts` kind in `src/fleet-jobs/` (`types.ts` store version 3, `runner.ts`, `plan.ts`, `manifest.ts`, `queue-view.ts`, `service.ts`, `cli.ts`), `docs/fleet-facts.md` and ADR 0005.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# The facts parser; the facts file (stale, never read, unreadable file); the play's read-only assertion; the play's result and the real reader; the table; the remote and local halves; and a facts job in the service loop (booking, per-box release, a box that fails, changed > 0, drift, store version 3), plus the job service's own suites, unchanged.
node --test --test-concurrency=1 src/fleet-facts/*.test.ts src/fleet-jobs/*.test.ts src/fleet-leases/*.test.ts
pnpm typecheck
pnpm test
# On a machine with ansible-core (CI's `ansible` job runs these):
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook -i ansible/inventory.example.yml --syntax-check ansible/facts.yml
(cd ansible && python3 check-modules.py)
```

**What the block shows:** every task of `ansible/facts.yml` is on the read-only allowlist with `changed_when: false`, and the script uses only read cmdlets and sets `$Ansible.Changed = $false` (`facts-play.test.ts`); a play result with `changed` above 0 fails that box's entry with `the facts play changed <n> things on <box>; it must change nothing` and leaves its facts as they were (`runner-facts.test.ts`); the Lenovo M720q (`10T8`), M710q (`10MR`) and HP ProDesk 600 G4 DM parse, and a missing CPU, a non-numeric capacity and an empty output are each refused by name (`parse.test.ts`); a box that does not answer keeps its last facts and `readAt` with `stale: true`, `lastAttemptAt` and `lastError`, while the job ends `done` (`facts-file.test.ts`, `runner-facts.test.ts`); each box's lease is let go as its own read ends; a drift record does not drop a facts box; a service that reads only store versions 1 and 2 fails a facts job by name; `--boxes all` is named from the inventory at submit; and `fleet facts show` prints one row per box with a STALE row and a never-read row, exiting 2 when no facts job has run (`remote.test.ts`, `show.test.ts`).

**Live check before merge** (the chairman session, or the worker under the standing approval of 2026-10-17, from the agents host): put the branch on the plane, read one box, then all of them. A pass is `fleet job wait` exiting 0 for each job, `fleet facts show` listing the box with its make, model, machine type, CPU, RAM, disks and Windows build and `read at` a time (not STALE), the job's `results/<box>.facts.json` holding `"changed": 0`, and `fleet lease list` showing the job's lease gone once it ends.

```bash
set -euo pipefail
set -a; . ~/.config/a11ign/fleet.env; set +a
BRANCH=admin/a11-283-fleet-facts-job-read-and-record-every-boxs-hardware-model
pnpm run fleet:jobs-install -- -e fleet_jobs_ref="$BRANCH"
ONE=$(pnpm run --silent fleet -- facts submit --boxes a11y-worker-2 --label A11-283)
pnpm run --silent fleet -- job wait "$ONE" --timeout 30m
pnpm run --silent fleet -- facts show --boxes a11y-worker-2
ALL=$(pnpm run --silent fleet -- facts submit --boxes all --label A11-283)
pnpm run --silent fleet -- job wait "$ALL" --timeout 2h
pnpm run --silent fleet -- facts show
pnpm run --silent fleet -- lease list
pnpm run fleet:jobs-install      # puts the service back on main
```

**After merge, run by the chairman session:** `pnpm run fleet:jobs-install` (the default ref, `main`) puts the service on the merged code, then `fleet facts submit --boxes all --label A11-283` and `fleet facts show`; the table for all fifteen boxes goes on the ticket as a comment, with the job ID.
