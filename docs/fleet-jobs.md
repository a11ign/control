# The fleet job service

Fleet work is a job you submit, not a script you run in your own shell. A job is named by its **job ID**, runs in a service on the control plane, and goes on when you exit, crash or sleep. You follow it by ID: `status`, `wait` (which always ends), `cancel`, and the results by `fetch`. A11-243 built it; [`docs/adr/0002`](adr/0002-fleet-jobs-are-reached-over-the-control-planes-ssh.md) says why it is reached over ssh and not over HTTP.

## Using it, from the agents host

```bash
set -a; . ~/.config/a11ign/fleet.env; set +a      # how this host reaches the control plane (the `fleet` command also reads this file itself)
pnpm run fleet -- capture submit --pages pages.json --boxes 3 --passes 2 --label A11-243 --probe tables,typing,dialog
# fj-20261025T085815Z-315a1b                      <- the job ID, printed at once; write it in your outcome and end your turn
pnpm run fleet -- job status fj-20261025T085815Z-315a1b          # or --json
pnpm run fleet -- job wait   fj-20261025T085815Z-315a1b --timeout 30m
pnpm run fleet -- job fetch  fj-20261025T085815Z-315a1b --to ./captures     # results/ -> ./captures/<id>/
pnpm run fleet -- job cancel fj-20261025T085815Z-315a1b
pnpm run fleet -- job list --label A11-243
```

`--pages` takes a file (a JSON list of URLs or `{ "url" }`, `capture_fleet.py`'s `{ "sample": [{ "url" }] }`, or one URL per line) or URLs, and may be given more than once. `--boxes` is a number of boxes (the least loaded that are ready, woken), `ready` (every ready box), or box names separated by commas. `--passes N` captures every page N times, each pass on a different box. `--steps` and `--probe tables,typing,dialog` are the options the current scripts take; `--body-json <file>` merges any other field of the worker's `/capture` body (the window size, say), so a new worker option needs no change here. `--freeze <freeze.json>` copies a `make_freeze.py` reference into the job; its commit and `namedAt` go in the manifest, and a freeze named in the future is refused. `--label` is required: the ticket key.

### `wait` always ends

`--timeout` is required (`90s`, `30m`, `2h`; at most 24h). There is no default and no unbounded form.

| Exit | Meaning |
| --- | --- |
| 0 | the job is done (failed captures are records; their number is printed) |
| 1 | the job failed; the reason is printed |
| 3 | the job was cancelled |
| 124 | the timeout ran out: the progress per box, what is left and when the service was last reached are printed, and the job goes on |
| 2 | usage, an unknown job, or a service that could not be reached at the start |

`wait` polls every 15 s, one ssh round trip each, and holds no stream open. A poll that fails is tried again until the deadline; a poll is given no more time than the deadline leaves.

### Booking: every job leases its boxes, so jobs queue and never collide (A11-244)

A box does one capture at a time (the worker refuses a second with `429`), so a job **leases** its boxes before it starts and lets them go when it ends. The leases are one ledger on the control plane, `/var/lib/a11y-fleet-leases/ledger.json` (a versioned JSON file under a pid-checked mutex, [`docs/adr/0003`](adr/0003-fleet-leases-are-a-control-plane-ledger.md)), which every taker of a box reads and writes: this service, and (in the second step of A11-244) the hourly drift check, the daily freeze and the idle power-off. The code is `src/fleet-leases/`. A *lease* is not screenreader-fleet's `leaseWorker`, which starts a local VM and puts it back.

```bash
pnpm run fleet -- job status fj-20261025T085815Z-315a1b
# fj-20261025T085815Z-315a1b  queued  label A11-244
# place: 1 of 2
# estimated start: 2026-10-25T09:47:00.000Z        <- or: unknown (fleet-jobs:fj-... has no expected end)
# waiting on: fleet-jobs:fj-20261025T084412Z-9c0d11
pnpm run fleet -- lease list [--json]              # who holds which boxes, and the queue in the order it is served
```

- **A job that cannot get its boxes waits in the queue**, `queued`, and `job status` shows its **place**, its **estimated start** and who it **waits on** (`--json` carries `queue: { place, of, estimatedStart, estimateReason, waitingOn }`). The estimate is worked out from the leases' expected ends and the service's last 20 completed captures (⌈pages × passes ÷ boxes⌉ × the mean capture). Where an input is missing it says `unknown` and why; it never guesses.
- **Fair use.** Jobs are served in the order they were submitted. A job that names boxes reserves only those boxes against the jobs behind it; a job that asks for "any N boxes" or `ready` holds the head of the line while it waits, so a large job is never starved by a stream of small ones. The queue keeps its order across a restart, because a job queues at its own submission time.
- **A job holds no box longer than its own work, plus a grace period.** A box whose pages are all done is released at once, while the job goes on with the others; the job's lease is released when it ends, whether done, failed or cancelled (a graceful stop is not an end: the next start takes the same lease again). While a job runs, the service renews its lease (and a queued job's place) every 30 s. A lease that is not renewed lapses **5 minutes** after the last renewal, so a holder that dies frees its boxes within the grace and never later. A normal restart is back well inside it.
- **A box leaving the fleet mid-job fails only that box's part.** A box leaves when three captures in a row fail on it, or when the hourly drift record (`runs/fleet-drift.json`) lists a current, not-carried difference for it. Each page it had not yet sent is a failed record, `<box> left the fleet: <why>`, the box is in the manifest's `dropped`, and its lease is released once the capture still on it, if any, has ended. The pages are **not** moved to the other boxes, and the job goes on. A job whose every box has left fails, naming each. A box the drift record lists is not offered to a new job, and a job that names one fails at start, naming the box and the difference (a drift can last for days, so waiting would be for ever).
- **A ledger nobody can read holds every box.** A file that is not JSON, or of a version this code does not know (the ledger is written from `/root/fleet-jobs` and `/root/control`, which can be on different refs), is read as every box held: nothing is taken, nothing is written over it, and the reason is logged. A missing file is a first run and reads as empty.

A capture that fails is a **record** (`status`, and the error in `capture`), as `q3/fleet_capture.mjs` writes it, and the job goes on. A job is `failed` only when it cannot finish: no box is left, or its files cannot be read.

### Cancel

`cancel` stops the service sending the job pages. A capture already on a box ends, because the worker has no abort route, and its record is kept. Cancelling a job that has ended is refused, naming its state.

## Where the results are

`control:/var/lib/a11y-fleet-jobs/<job ID>/results/`, one record per page and pass (`<page>-<hash>.p<pass>.json`, the shape `fleet_capture.mjs` writes: `{ capturedAt, worker, status, capture }`, naming the worker and never its address) and `manifest.json`: the pages, the label, the capture body, the freeze, the pinned versions from `deploy-pins.json`, each box with its worker code, Windows build, Edge and NVDA as its `/health` reported them when the job began, whether the boxes agree on the fields that must match (recorded; it does not refuse the job), the boxes dropped and why, and every capture with its file, box, pass, status and times. `fleet job fetch` copies the directory to the agents host.

The store is files, and each has one writer: `request.json` (`submit`, once), `state.json` and `results/` (the service), `cancel` (a marker). Each carries `"version": 1`; a file of a version the service does not know fails that job and names the version.

## A restart

The service resumes every job it finds `running`. The records already written are kept. A capture the dead service had sent is taken again once its box says it is no longer busy (bounded), and its record carries `note: "re-captured after a service restart"`. A graceful stop (`SIGTERM`) lets the captures in flight end and be recorded first, so a stop re-captures nothing. A job whose files cannot be read is marked `failed` with the reason; nothing is dropped silently.

## Putting it on the control plane (Ansible only)

```bash
pnpm run fleet:jobs-install                                   # the service on main
pnpm run fleet:jobs-install -- -e fleet_jobs_ref=<branch>     # a branch, to prove it before it merges
```

The service runs from its own checkout, `/root/fleet-jobs`, moved only by this play, so `/root/control`'s follow-`main` step cannot move a tree under a running process, and a branch can be proven without putting `/root/control` off `main`. The play reads the service back: `SubState=running`, then a heartbeat in `service.json` that is fresh and names the commit it just checked out. After a merge, `pnpm run fleet:jobs-install` with the default ref puts the service back on `main`.

The service sends the workers' own `/capture` and changes nothing on any box. The fleet stays frozen (A11-205).

## Not here yet

Leases for the person-run plays (`fleet:deploy`, `fleet:provision`, `fleet:patch`, `fleet:recover`: they keep the whole-fleet `fleet-lock.ts` for now), scheduled work taking leases (A11-244, step 2), the board waking an agent when a job ends, moving `capture_fleet.py`, `q3/fleet_capture.mjs` and lab's clients onto the service (A11-246), the recipe in the house notes (A11-247), and retention for the store. `README.md`, `CLAUDE.md` and `ansible/README.md` do not point here yet, because A11-205 holds those files.
