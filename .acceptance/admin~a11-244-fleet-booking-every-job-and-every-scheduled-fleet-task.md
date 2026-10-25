A11-244 (https://linear.app/a11ign/issue/A11-244/fleet-booking-every-job-and-every-scheduled-fleet-task-leases-its), step 2 of 2: the scheduled fleet work takes leases from the ledger step 1 added (every fleet job already does), so the hourly drift check, the daily freeze re-apply and the idle power-off never land in the middle of a capture.

What step 2 does: `src/fleet-leases/freeze-daily.ts` (the freeze unit's new `ExecStart`: an exclusive `maintain` lease per box, `freeze.yml --limit <free boxes>` in batches, a 6-hour deadline that names any box still leased), `src/fleet-leases/booking.ts`, `fleet-drift.ts --record` taking a shared `read` lease (`bookedReading`), `fleet-auto-off.ts` deciding `lease-pending` per box and `batch-queued` from the ledger and taking a `maintain` lease across each shutdown, and `docs/fleet-jobs.md`.

What the change does: `src/fleet-leases/` (the ledger file and its mutex, the pure booking rules, the estimated-start walk), the job service's claim moved from memory onto the ledger (`src/fleet-jobs/claims.ts`, `runner.ts`, `service.ts`), a queue place and estimated start in `fleet job status`, `fleet lease list`, a box leaving a running job (three failed captures, or the hourly drift record) failing only its own pages, the `a11y-fleet-leases` state directory on `a11y-fleet-jobs.service`, `docs/fleet-jobs.md` and ADR 0003.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# The ledger's rules, file, mutex (separate processes) and estimate; the job service over the ledger (overlapping boxes run one after the other, a stale lease expires, release on done/failed/cancelled, a box leaving mid-job); and the service across real processes.
node --test --test-concurrency=1 src/fleet-leases/*.test.ts src/fleet-jobs/*.test.ts src/fleet-drift.test.ts src/fleet-auto-off.test.ts src/control-runs-under-tsx.test.ts src/control-plane-fleet.test.ts src/control-owned/no-scheduled-install.test.ts
pnpm typecheck
pnpm test
```

**What the block shows:** two jobs that name overlapping boxes, or ask for the whole of a small fleet, run one after the other with no box ever holding two captures (`booking.test.ts`, also across two runners that share only the ledger); a lease that is not renewed lapses at its expiry, the next job then takes the box and the stale entry is gone from the file; concurrent takes from twelve processes grant a box once; a lock left by a dead pid is broken; an unreadable or newer-version ledger reads as every box held and is not written over; a queued job shows `place: 1 of 1`, an estimated start and who it waits on, in text and in `--json`; a box named in the drift record, or failing three captures, takes only its own part of the job down, naming it, and its lease is freed only once its capture in flight has ended.

Step 2 adds: the scheduled re-apply waits for a lease (`freeze-daily.test.ts`: while a `capture` lease holds one box the freeze runs on the others, then freezes it in a later batch once that lease is released, no two plays target one box, and at the deadline the box is named in `leased` and the run exits non-zero); the drift check takes a `read` lease beside a `capture` and skips and names a box under `maintain`, carrying its differences (`fleet-drift.test.ts`); auto-off keeps a leased box and a box a queued job named as `lease-pending`, keeps every box as `batch-queued` while an "any N" job waits, and takes and releases a `maintain` lease across a dispatch (`fleet-auto-off.test.ts`); the freeze unit's wrapper can start only `ansible-playbook freeze.yml` (`no-scheduled-install.test.ts`).

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

**After merge, run by the chairman session:** `pnpm run fleet:jobs-install` (the default ref, `main`) puts the service back on `main`, and `pnpm run fleet:freeze-schedule` installs the freeze unit's new `ExecStart` (read it back with `systemctl cat a11y-fleet-freeze-daily.service`; the next 04:11 run's `runs/fleet-freeze-last-run.json` carries `leased: {}`, or names any box that was leased). The ticket's After-merge line (two tickets' captures queue instead of overlapping) is the block above, run on `main` with the two tickets' real captures.

Closes A11-244
