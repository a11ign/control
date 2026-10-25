A11-244 (https://linear.app/a11ign/issue/A11-244/fleet-booking-every-job-and-every-scheduled-fleet-task-leases-its), step 1 of 2: every fleet job leases its boxes through a lease ledger on the control plane, so jobs queue and never collide. Step 2 (the scheduled drift check, the daily freeze re-apply and auto-off taking leases) is the next pull request.

What the change does: `src/fleet-leases/` (the ledger file and its mutex, the pure booking rules, the estimated-start walk), the job service's claim moved from memory onto the ledger (`src/fleet-jobs/claims.ts`, `runner.ts`, `service.ts`), a queue place and estimated start in `fleet job status`, `fleet lease list`, a box leaving a running job (three failed captures, or the hourly drift record) failing only its own pages, the `a11y-fleet-leases` state directory on `a11y-fleet-jobs.service`, `docs/fleet-jobs.md` and ADR 0003.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# The ledger's rules, file, mutex (separate processes) and estimate; the job service over the ledger (overlapping boxes run one after the other, a stale lease expires, release on done/failed/cancelled, a box leaving mid-job); and the service across real processes.
node --test --test-concurrency=1 src/fleet-leases/*.test.ts src/fleet-jobs/*.test.ts src/control-runs-under-tsx.test.ts src/control-plane-fleet.test.ts src/control-owned/no-scheduled-install.test.ts
pnpm typecheck
pnpm test
```

**What the block shows:** two jobs that name overlapping boxes, or ask for the whole of a small fleet, run one after the other with no box ever holding two captures (`booking.test.ts`, also across two runners that share only the ledger); a lease that is not renewed lapses at its expiry, the next job then takes the box and the stale entry is gone from the file; concurrent takes from twelve processes grant a box once; a lock left by a dead pid is broken; an unreadable or newer-version ledger reads as every box held and is not written over; a queued job shows `place: 1 of 1`, an estimated start and who it waits on, in text and in `--json`; a box named in the drift record, or failing three captures, takes only its own part of the job down, naming it, and its lease is freed only once its capture in flight has ended.

**Live check before merge** (the chairman session, from the agents host; the standing approval of 2026-10-17 covers the Ansible play): put the branch on the plane, submit two jobs with overlapping boxes, and watch the second queue behind the first. A pass is `fleet job status` of the second showing `queued` with `place: 1 of 1` and an estimated start while the first runs, `fleet lease list` showing the first's lease and the second in the queue, both `fleet job wait` calls exiting 0, and the second's `startedAt` at or after the first's last capture on a11y-worker-15.

```bash
set -euo pipefail
set -a; . ~/.config/a11ign/fleet.env; set +a
BRANCH=admin/a11-244-fleet-booking-every-job-and-every-scheduled-fleet-task
pnpm run fleet:jobs-install -- -e fleet_jobs_ref="$BRANCH"
printf 'https://example.com/\nhttps://example.org/\n' > "${TMPDIR:-/tmp}/a11-244-pages.txt"
A=$(pnpm run --silent fleet -- capture submit --pages "${TMPDIR:-/tmp}/a11-244-pages.txt" --boxes a11y-worker-14,a11y-worker-15 --label A11-244-a)
B=$(pnpm run --silent fleet -- capture submit --pages "${TMPDIR:-/tmp}/a11-244-pages.txt" --boxes a11y-worker-15,a11y-worker-16 --label A11-244-b)
pnpm run --silent fleet -- job status "$B"
pnpm run --silent fleet -- lease list
pnpm run --silent fleet -- job wait "$A" --timeout 30m
pnpm run --silent fleet -- job wait "$B" --timeout 30m
pnpm run --silent fleet -- job status "$B" --json
```

**After merge, run by the chairman session:** `pnpm run fleet:jobs-install` (the default ref, `main`) puts the service back on `main`. The ticket's After-merge line (two tickets' captures queue instead of overlapping) is the block above, run on `main` with the two tickets' real captures.

Refs A11-244
