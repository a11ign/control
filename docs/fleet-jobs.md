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

A box does one capture at a time (the worker refuses a second with `429`), so a job **leases** its boxes before it starts and lets them go when it ends. The leases are one ledger on the control plane, `/var/lib/a11y-fleet-leases/ledger.json` (a versioned JSON file under a pid-checked mutex, [`docs/adr/0003`](adr/0003-fleet-leases-are-a-control-plane-ledger.md)), which every taker of a box reads and writes: this service, the hourly drift check, the daily freeze and the idle power-off (see "Scheduled work" below). The code is `src/fleet-leases/`. A *lease* is not screenreader-fleet's `leaseWorker`, which starts a local VM and puts it back.

```bash
pnpm run fleet -- job status fj-20261025T085815Z-315a1b
# fj-20261025T085815Z-315a1b  queued  label A11-244
# place: 1 of 2
# estimated start: 2026-10-25T09:47:00.000Z        <- or: unknown (fleet-jobs:fj-... has no expected end)
# waiting on: fleet-jobs:fj-20261025T084412Z-9c0d11
pnpm run fleet -- lease list [--json]              # who holds which boxes, and the queue in the order it is served
```

- **A job that cannot get its boxes waits in the queue**, `queued`, and `job status` shows its **place**, its **estimated start** and who it **waits on** (`--json` carries `queue: { place, of, estimatedStart, estimateReason, waitingOn }`). The estimate is worked out from the leases' expected ends and the service's last 20 completed captures (⌈captures ÷ boxes⌉ × the mean capture, where a page job's captures are its pages × passes and a case job's are its cases). Where an input is missing it says `unknown` and why; it never guesses.
- **Fair use.** Jobs are served in the order they were submitted. A job that names boxes reserves only those boxes against the jobs behind it; a job that asks for "any N boxes" or `ready` holds the head of the line while it waits, so a large job is never starved by a stream of small ones. The queue keeps its order across a restart, because a job queues at its own submission time.
- **A job holds no box longer than its own work, plus a grace period.** A box whose pages are all done is released at once, while the job goes on with the others; the job's lease is released when it ends, whether done, failed or cancelled (a graceful stop is not an end: the next start takes the same lease again). While a job runs, the service renews its lease (and a queued job's place) every 30 s. A lease that is not renewed lapses **5 minutes** after the last renewal, so a holder that dies frees its boxes within the grace and never later. A normal restart is back well inside it.
- **A box leaving the fleet mid-job fails only that box's part.** A box leaves when three captures in a row fail on it, or when the hourly drift record (`runs/fleet-drift.json`) lists a current, not-carried difference for it. Each page it had not yet sent is a failed record, `<box> left the fleet: <why>`, the box is in the manifest's `dropped`, and its lease is released once the capture still on it, if any, has ended. The pages are **not** moved to the other boxes, and the job goes on. A job whose every box has left fails, naming each. A drift record that exists but cannot be read (not JSON, no list of differences) is not read as "no box differs": a job that has not started stays queued until it can be read, and a running job loses no box on a guess. A record that does not exist (the hourly check has not run yet) reads as no difference known. A box the drift record lists is not offered to a new job, and a job that names one fails at start, naming the box and the difference (a drift can last for days, so waiting would be for ever).
- **A ledger nobody can read holds every box.** A file that is not JSON, or of a version this code does not know (the ledger is written from `/root/fleet-jobs` and `/root/control`, which can be on different refs), is read as every box held: nothing is taken, nothing is written over it, and the reason is logged. A missing file is a first run and reads as empty.

A capture that fails is a **record** (`status`, and the error in `capture`), as `q3/fleet_capture.mjs` writes it, and the job goes on. A job is `failed` only when it cannot finish: no box is left, or its files cannot be read.

### Scheduled work takes leases too (A11-244)

Three things act on boxes on a timer, from the control plane. Each takes the same ledger, so none lands in the middle of a capture and none reboots or reconfigures a leased box.

| Task | Lease | What it does when a box is booked |
| --- | --- | --- |
| The hourly drift check (`a11y-fleet-drift.service`, `fleet-drift.ts --record`) | a shared **`read`** on every box | Reads beside a capture. A box under a `maintain` lease is **not asked** that hour: it is recorded as unread with `under maintenance by <holder>` (`skipped` in `runs/fleet-drift.json`), and its last differences are carried, as for any box that did not answer. It never queues. |
| The daily freeze re-apply (`a11y-fleet-freeze-daily.service`, `src/fleet-leases/freeze-daily.ts`) | an exclusive **`maintain`** per box | Queues one waiter per inventory box at the run's start, freezes the boxes it can have as a batch (`freeze.yml --limit <boxes>`), lets each go as its batch ends, and takes the rest later. It stops waiting after **6 hours**: a box it never got is named in `leased` in `runs/fleet-freeze-last-run.json` (and in the hourly record's `freeze`), is not frozen that day, and the unit fails (`systemctl --failed`). |
| The idle power-off (`fleet-auto-off.ts --apply`) | a non-queueing exclusive **`maintain`** across each `sleep.yml` dispatch | A box under a `capture` or `maintain` lease, or named by a queued job, is kept `lease-pending`; every box is kept `batch-queued` while a job waits for "any N" or `ready` boxes. If the shutdown lease cannot be taken, the box is kept. |

**Why a shared `read` lease is safe for the drift check.** It sends only `GET /health` and `GET /progress` to each worker (`probeWorker` in `fleet-status.ts`). Those are the reads that already run *during* every capture: the job runner's health check, auto-off's idle probe on every tick, and `sleep.yml`'s busy re-check. The worker's `busy` flag exists to answer them mid-capture. Waiting behind captures instead would push the "at least hourly" check (A11-205) past an hour whenever the fleet is busy. The lease records that the reading is happening, and it is refused only beside a `maintain`.

A batch whose play writes **no record** (it refused before it froze anything, as its `patch`-running guard does, or it died) is not counted as frozen or as failed: its boxes go back, and are tried again 10 minutes later until the deadline, where a box that never got a record is `failed`. A play is killed after 90 minutes. A box a capture holds for more than 6 hours is therefore skipped that day (`leased`); a freeze that must not wait is `pnpm run fleet:freeze`, which runs `freeze.yml` at once as it always did.

The freeze is not affected by the job's queue: a job queued **before** the run keeps its turn on a box, and a job queued after it waits behind the freeze's turn on that box, so neither side is starved. If the ledger cannot be read, the freeze takes nothing and names every box `leased` at the deadline, and the drift check reads without a lease (a reading grants nothing exclusive) and says so on stderr.

After merge, `pnpm run fleet:freeze-schedule` re-installs the freeze unit with its new `ExecStart`; read it back with `systemctl cat a11y-fleet-freeze-daily.service`. The next 04:11 run's `runs/fleet-freeze-last-run.json` carries `leased: {}`, or names any box that was leased.

### Cases and groups: a body of its own for each capture, and cases held to one box (A11-263)

A page job sends every page the same body and spreads a page's passes across boxes. Work that needs a different body per capture, or captures that must come from one box (a good/bad pair, a page's repeats, an A1/B/A2 order), is a **job of cases**:

```bash
pnpm run fleet -- capture submit --cases cases.json --boxes 2 --label A11-263
```

```json
{ "cases": [
    { "id": "form-error-silent.good", "url": "http://…/good.html", "body": { "task": "…", "probeForms": true }, "group": "form-error-silent" },
    { "id": "form-error-silent.bad",  "url": "http://…/bad.html",  "body": { "task": "…", "probeForms": true }, "group": "form-error-silent" } ],
  "groups": { "form-error-silent": { "skipWhen": { "environment": { "screenReaderVersion": "2026.1", "guidepupVersion": null } } } } }
```

- **`id`** is unique in the job, matches `^[A-Za-z0-9][A-Za-z0-9._+-]{0,160}$` and is not `manifest`. **`url`** is http(s). **`body`** is the worker's own `/capture` body for that case and is sent **exactly**, with `url` added: the page job's defaults (`DEFAULT_BODY`) are not merged in, because a client may use that body as its cache key. A body that sets `url`, `captureId` or `async` is refused, since the service sets them.
- **`group`** is optional; a case with none is a group of its own. **Every case of a group is captured on one box, in file order, one after another**, and a group is never split across boxes. Whole groups are placed largest first, each on the box with the fewest cases so far, and a box is sent one group before the next, so the lease keeps every other job off the box in between. A box left with no group is let go at once.
- `--cases` is refused beside `--pages`, `--passes`, `--steps`, `--probe`, `--body-json` and page URLs, naming the one: a job's bodies come from one place. `--boxes`, `--label` and `--freeze` are as for a page job.
- **A box that leaves mid-job** fails the cases it had not sent, as for pages. **A restart that finds a box gone from the inventory** moves a group only whole and only when none of its cases had ended on the old box. Otherwise its pending cases fail with `<box> left the fleet; group <g> was already partly captured there, and a group is never split across boxes`.
- **Records** are `results/<case id>.a<attempt>.json` in the same shape as a page's (`{ capturedAt, worker, status, capture }`). The manifest (`"version": 2` for a case job) gains `cases` (each with `id`, `url`, `group`, `body`, `attempt`), `recaptureOf`, for each capture its `case`, `group` and `attempt`, and for each box its whole `/health` `environment` beside the fields it names today.
- **Store version.** A job of cases, or a re-capture, is written as store version 2 (`request.json` and `state.json`). The service reads versions 1 and 2. A page job is still written as version 1. A service that reads only version 1 (`fleet:jobs-install -e fleet_jobs_ref=<older>`) fails a case job naming the version, and never captures its URLs as plain pages.

### `skipWhen`: leave a group alone when the box has not changed

A group may carry `skipWhen: { "environment": { <field>: <value>, … } }`. Before the group's first capture the service compares each named field with the `/health` `environment` it read from that box when the job started; an absent field reads as `null`. If every field matches, the group's cases are marked `skipped` (`note: "environment matches skipWhen"`): nothing is sent and no record is written. A box whose health was not read never skips. It is for a client whose cache key includes the box's environment, which only the service knows before the box is chosen: the client sends `skipWhen` for a group whose stored result already matches on everything except the environment. An empty `environment` is refused, since it would skip on every box.

### Re-capture: the same cases again, on the same boxes

```bash
pnpm run fleet -- job recapture fj-20261025T085815Z-315a1b --cases form-error-silent.bad --label A11-263
# fj-20261025T091500Z-4d5e6f     <- a NEW job ID, printed at once; wait on this one
```

- Accepted only for a **case job in state `done`**; any other state is refused, naming it. Every named case must exist in that job.
- The new job copies those cases (their URLs and bodies) and names the source in `recaptureOf`. Each case's `attempt` is one more than its last attempt in the source, so its record is `<case id>.a2.json`, and a fetch of both jobs into one directory never overwrites a record. A re-capture of a re-capture works the same way, from that job. The service sets no attempt limit: the client keeps its own.
- **Each case is pinned to the box its group was captured on in the source job**, so a re-captured bad variant is taken on the same box as the good variant it is compared with. Cases of one group named together stay a group. The new job asks for those boxes **by name**, so it queues, leases, renews, releases and drift-fails like any named job (A11-244). If a pinned box is not in the inventory, the re-capture is refused, naming the box and the group, and saying to submit the whole group as a new job. A restart does not move a pinned group to another box; its pending cases fail naming the pin.
- A skipped case can be re-captured like any other: a re-capture never carries `skipWhen`.

### Cancel

`cancel` stops the service sending the job pages. A capture already on a box ends, because the worker has no abort route, and its record is kept. Cancelling a job that has ended is refused, naming its state.

## Where the results are

`control:/var/lib/a11y-fleet-jobs/<job ID>/results/`, one record per page and pass (`<page>-<hash>.p<pass>.json`; for a job of cases, `<case id>.a<attempt>.json`, the shape `fleet_capture.mjs` writes: `{ capturedAt, worker, status, capture }`, naming the worker and never its address) and `manifest.json`: the pages, the label, the capture body, the freeze, the pinned versions from `deploy-pins.json`, each box with its worker code, Windows build, Edge and NVDA as its `/health` reported them when the job began, whether the boxes agree on the fields that must match (recorded; it does not refuse the job), the boxes dropped and why, and every capture with its file, box, pass, status and times. `fleet job fetch` copies the directory to the agents host.

The store is files, and each has one writer: `request.json` (`submit`, once), `state.json` and `results/` (the service), `cancel` (a marker). Each carries `"version"`: 1 for a job of pages, 2 for a job of cases or a re-capture. A file of a version the service does not know fails that job and names the version.

## A restart

The service resumes every job it finds `running`. The records already written are kept. A capture the dead service had sent is taken again once its box says it is no longer busy (bounded), and its record carries `note: "re-captured after a service restart"`. A graceful stop (`SIGTERM`) lets the captures in flight end and be recorded first, so a stop re-captures nothing. A job whose files cannot be read is marked `failed` with the reason; nothing is dropped silently.

## Putting it on the control plane (Ansible only)

```bash
pnpm run fleet:jobs-install                                   # the service on main
pnpm run fleet:jobs-install -- -e fleet_jobs_ref=<branch>     # a branch, to prove it before it merges
```

The service runs from its own checkout, `/root/fleet-jobs`, moved only by this play, so `/root/control`'s follow-`main` step cannot move a tree under a running process, and a branch can be proven without putting `/root/control` off `main`. The play reads the service back: `SubState=running`, then a heartbeat in `service.json` that is fresh and names the commit it just checked out. After a merge, `pnpm run fleet:jobs-install` with the default ref puts the service back on `main`.

The service sends the workers' own `/capture` and changes nothing on any box. The fleet stays frozen (A11-205).

## From the lab (A11-263)

The lab's capture clients run on the lab (CT 121, under `lab:job`), beside the corpus and the page server they lease, and they submit to this service like any other client. The lab holds no fleet key (ADR 0012). It holds its own key to the control plane, made on the lab and never copied off it, which the control plane accepts only as `restrict,command="… src/fleet-jobs/gate.ts"`. [`docs/adr/0004`](adr/0004-the-lab-submits-fleet-jobs-through-a-forced-command-key.md) gives the reasons.

```bash
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/fleet-jobs-lab-access.yml                          # the key, the gate's line, the lab's `fleet` command, and the read-back
ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/fleet-jobs-lab-access.yml -e fleet_jobs_ref=<branch>  # the lab's CLI on another ref, to prove a branch before it merges
```

Run it from the agents host, which reaches both machines, after `fleet:jobs-install` has put the service on a ref that holds `gate.ts` (the play refuses otherwise). It:

1. makes `/root/.ssh/a11y-fleet-jobs` (ed25519) on the lab if it is absent, and reads only the public half;
2. puts that key in root's `authorized_keys` on the control plane as `restrict,command="/usr/bin/node --import <loader> /root/fleet-jobs/src/fleet-jobs/gate.ts" <key> a11y-lab-fleet-jobs`, replacing any earlier line with that comment (to rotate, remove the two key files on the lab and run it again);
3. checks out control at the ref (default `main`) into `/opt/a11y-fleet-cli`, installs its lockfile alone (`--frozen-lockfile --ignore-scripts`), writes `/etc/a11ign/fleet.env` (`A11Y_PVE_KEY`, `A11Y_CONTROL_HOST`) and `/usr/local/bin/fleet`;
4. reads back from the lab: `fleet lease list --json` answers the ledger's JSON, and `ssh -i /root/.ssh/a11y-fleet-jobs root@<control plane> id` is refused by the gate (exit 2).

**The gate** (`src/fleet-jobs/gate.ts`) reads `SSH_ORIGINAL_COMMAND` and accepts exactly what `controlPlaneTransport` sends: `cd /root/fleet-jobs && /usr/bin/node --import <loader> src/fleet-jobs/remote.ts` followed by single-quoted arguments. It unquotes them and runs `remote.ts` with them as an argument list (no shell, stdin and stdout passed through, the exit code returned), so `submit`, `recapture`, `status`, `cancel`, `list`, `lease-list` and `tar` work and nothing else does. Any other request (a second command, another path or loader, an unquoted argument, an empty command) is refused on stderr with the command it was given, exit 2. The lab's key therefore submits, re-captures, follows, cancels, lists and fetches capture jobs, and provisions, deploys, sleeps and reconfigures nothing.

**What a capture job needs from `lab:job`.** Every job that captures through the service (`capture`, `capture-only`, `capture-acceptance` and `-2`, `capture-real-pages`, `retrain`, `everything`, `evidence-check`, `stability`, `gate-stability`, `gate-probe-order`, `capture-check`) requires `-e label=<ticket key>` (shape `^[A-Za-z0-9._-]{1,64}$`; a launch without it is refused naming the parameter, before anything is dispatched) and gives the lab's client three environment variables:

| Variable | Value |
| --- | --- |
| `A11Y_FLEET_BOXES` | `-e workers=` (`capture-only`: names, a count or `ready`), or `-e worker=` (the stability gates and `capture-check`: one name; `evidence-check`: one name, optional), else `ready` |
| `A11Y_FLEET_LABEL` | the `label` |
| `A11Y_FLEET_WAIT` | the job's own `timeout` as `<seconds>s`, so the client's one bounded `fleet job wait` ends inside the unit's `RuntimeMaxSec` |

`lab:pipeline` takes `--label=<ticket key>` and gives it to the stages that take one; a pipeline that captures is refused without it. A qualified `gate-stability` run (`--qualify-sha`) that names no label is booked as `qualify-<row>`.

The old `A11Y_WORKERS`, `A11Y_WORKER`, `--worker=` and positional addresses stay on these jobs while the lab on the lab host is older than the clients that read the new variables; a later change removes them.

## Not here yet

Leases for the person-run plays (`fleet:deploy`, `fleet:provision`, `fleet:patch`, `fleet:recover`: they keep the whole-fleet `fleet-lock.ts` and the freeze's own `patch`-running guard for now), the board waking an agent when a job ends, moving `capture_fleet.py` and `q3/fleet_capture.mjs` onto the service (A11-246) and lab's clients (A11-263 steps 3 and 4: the service side and the lab's route to it are above; the clients themselves follow), the recipe in the house notes (A11-247), and retention for the store. `README.md`, `CLAUDE.md` and `ansible/README.md` do not point here yet, because A11-205 holds those files.
