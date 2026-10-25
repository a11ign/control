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

### A box does one capture at a time, and two jobs never share a box

A job claims its boxes when it starts and holds them until it ends; another job waits, `queued`, for boxes it can have. The claim sits behind `src/fleet-jobs/claims.ts`, which A11-244 replaces with fleet-wide leases (so `fleet:deploy`, `fleet:provision` and the drift check take them too).

A capture that fails is a **record** (`status`, and the error in `capture`), as `q3/fleet_capture.mjs` writes it, and the job goes on. A box that fails three captures in a row (no answer, `429` or a `5xx`) is dropped from the job, and its unfinished pages move to the job's other boxes. A job is `failed` only when it cannot finish: no box is left, or its files cannot be read.

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

Fleet-wide leases (A11-244), the board waking an agent when a job ends, moving `capture_fleet.py`, `q3/fleet_capture.mjs` and lab's clients onto the service (A11-246), the recipe in the house notes (A11-247), and retention for the store. `README.md`, `CLAUDE.md` and `ansible/README.md` do not point here yet, because A11-205 holds those files.
