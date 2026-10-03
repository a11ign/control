## Working on a Mac (the usual case)

> **THE LOCAL UTM WORKER VMs ARE DEPRECATED. Capture on the bare-metal fleet.** Every box
> `inventory.yml` lists (`a11y-worker-2` upward; `-1` is retired and its number is never reused.
> [`-10` rejoined 2026-09-09 →](docs/operational-lessons.md#a11y-worker-10-withdrawn-2026-09-07-rejoined-2026-09-09)) serves
> `/health` without a laptop in the path, and `pnpm run fleet:status` is the one command that says
> so. Deploy with **`pnpm run fleet:deploy`**, never `worker:deploy` — that one is `utmctl file push` to a
> VM UUID and cannot reach a physical box.
>
> [Why this note exists, and what "kept" means below →](docs/operational-lessons.md#why-the-deprecation-note-exists-and-what-kept-means)

Everything except capture runs natively. Capture needs a Windows worker. The fleet is the answer;
`docs/getting-started.md` and `docs/local-worker-vm.md` describe the deprecated local VM.

```bash
pnpm run worker:ctl -- up        # start/resume the VM, wait for /health
pnpm run worker:ctl -- status    # state, host cost, health
pnpm run worker:ctl -- pause     # see below: UTM cannot actually suspend these guests
pnpm run witness -- https://example.com --task "..."   # no A11Y_WORKER needed
```

With no `A11Y_WORKER` set the run finds the local VM, starts it, and **puts it back as it
found it** — so a VM you started yourself is left running. `--after stop|pause|leave`
overrides. `--no-axe` skips the optional rule layer; `--axe-results file.json` imports one you
already ran.

**Changing any worker file means deploying to the guests. One command — but WHICH command depends on
what the worker is.**

```bash
pnpm run worker:deploy                     # UTM VMs on this Mac only — utmctl file push, keyed on a VM UUID
pnpm run worker:deploy -- --vm=a11y-worker-2
pnpm run worker:code                       # each worker's /health.code vs this checkout — works for both
```

`worker:deploy` **cannot reach a bare-metal worker**: it is `utmctl file push` plus a `utmctl` reboot, it
takes a VM UUID rather than a host, and it fails immediately off macOS. Physical boxes are git-cloned
rather than file-pushed, so they deploy by pulling:

```bash
pnpm run fleet:deploy                  # pull + install + restart + PROVE it (bare metal)
pnpm run fleet:provision               # the ROLE: NVDA, the Edge pin, policies, and the provision stamp
pnpm run fleet:provision -- --serial=0 # all boxes at once, rather than one at a time
eval "$(pnpm run --silent fleet:env)"                                # A11Y_WORKERS from inventory.yml
pnpm run fleet:status                                                # what every box is doing, right now
```

`fleet:provision --serial=0` (all at once) is right here because `provisionRevision` is a MUST_MATCH cache key — a canary box IS the failure mode. [Why →](docs/operational-lessons.md#fleetprovision---serial0-and-the-sre-workbook)

`fleet:deploy`/`fleet:provision` REFUSE a worker that is capturing (a HARD fail, `-e a11y_force_deploy=true` overrides) — `recover.yml`/`restart.yml` are exempt, since they act on a worker that is busy AND wedged, but only against **one named worker** (`target=<worker>`/`-l <worker>`, required since #1829 — omitting it used to reach the whole fleet, including a box a different session is mid-capture on). `fleet:status` surfaces a **degraded** guest: the fault that produces zero failures because the worker's own retry absorbs every recovery. [Why the hard fail →](docs/operational-lessons.md#fleetdeployfleetprovision-refuse-a-capturing-worker)

`pnpm run fleet:auto-off` reports, per worker, `off` or `keep` and why -- report-only until `--apply` is
passed, and even then only for a worker its own pure decision names. It is the timer half of #2656: an
idle-five-minutes worker powers itself off through `sleep.yml`, reused rather than reimplemented, but only one with a
wake proof under a week old from `fleet:wake` (#3227; every other worker is `keep wake-unproven`, named in the report), and the
`auto-off-schedule.yml` playbook installs its timer LIVE, and the unit passes `--apply` (a unit without it is a
report on a clock; the installed copy is the program, so read `systemctl list-timers` on the control host, #2784).

A multi-round SAME-BUILD sequence (every round must land on one worker build, e.g. #781) needs its own hold BETWEEN captures, when no worker is actually `busy` and the check above says nothing. Write **`Fleet-hold-until: <ISO-8601 UTC timestamp, with seconds>`** in the row's body (an OPEN row carrying `fleet-gated`) and `fleet:deploy`/`fleet:provision` refuse until that time passes or the row closes — self-clearing either way, unlike the row-comment sentence that lost #1767's and #1768's baselines to ordinary merge cadence. **Name your own workers to hold only them** — append a comma-separated list, e.g. `Fleet-hold-until: 2026-09-27T22:00:00Z a11y-worker-2,a11y-worker-3` — and a deploy/provision whose own `--limit` never touches a named worker proceeds; naming none holds the whole fleet, unchanged (ceo, #928 point 2, #2736). `--allow-hold=<row>` overrides, one row at a time, repeatable, and refuses a number that names a row not currently holding anything. [#1839 →](https://github.com/a11ign/a11ign/issues/1839)

**Long lab work runs through Ansible, not through a shell.** Training, dataset builds, abstention sweeps and
real-page captures are named jobs, dispatched with fixed argv and supervised by systemd:

```bash
pnpm run lab:job -- -e job=train                 # the catalogue is in ansible/lab-job.yml
pnpm run lab:job -- -e job=capture-real-pages -e worker=a11y-worker-2 -e role=training -e shard=0/4
pnpm run lab:status                              # every a11y-job-* unit and its state
pnpm run lab:status -- -e job=train              # systemd's view + the journal + the run's own progress file
pnpm run lab:stop -- -e job=capture              # end one deliberately; reports what it discards first
```

`lab:stop` exists because the unit name is the lock, so `lab:job` REFUSES a second job of that name — and
until 2026-08-22 the only way to end one was `systemctl stop` over ssh, which is the exact hole ADR 0013
was written to close. It refuses a unit that is not running and names the state it found instead, because
"it was already finished" and "I stopped your job" are different outcomes.

Three systemd-polling rules, pinned by `lab-job.test.ts`: exit on a positive verdict never a marker's absence; prove a waiter's condition can be true before backgrounding it; poll `SubState` until it LEAVES `running`, never `is-active`. [Incidents →](docs/operational-lessons.md#three-systemd-polling-facts-and-the-pct-exec-history)

**A job of a given name is refused, not killed, while one is running.** The unit name is the lock and it
holds against the ssh path too, which an in-process flag could not.

`packages/control/ansible/README.md` is the map: why SSH and not WinRM (the blank-password guard),
why not an `/admin/update` route (the worker has no auth and binds all interfaces), and the two Windows
gotchas that otherwise cost an afternoon — `administrators_authorized_keys` and OpenSSH's `DefaultShell`.
The fleet is defined **once**, in `inventory.yml`.

Fetching a file FROM a Windows OpenSSH guest (copy-provisioning) takes `scp -O`: the default SFTP `scp` silently truncates it to 204800 bytes and exits 0. Push is unaffected. [Why →](docs/operational-lessons.md#a-default-scp-fetch-from-a-windows-openssh-guest-is-cut-to-204800-bytes-without-a-word-2770-found-on-2763)

A new bare-metal box needs no console visit — PXE + `autounattend.xml` plants the account and key. Deploy pushes every hashed file (defined once in `packages/nvda-worker/src/worker-files.mjs`) and reboots each guest, since `utmctl exec` cannot be trusted to restart the worker. Roll back by checking out the ref and redeploying — git is the source of truth. `worker:deploy` refuses a `CAPTURE_PROTOCOL_VERSION` change without `--allow-protocol-change` (it invalidates the whole cache). [Full detail →](docs/operational-lessons.md#a-new-box-needs-no-console-visit-and-the-protocol-version-trap)

Five more `utmctl`/local-VM quirks that have each cost real time — do not restart with `utmctl exec` and believe it, verify through `/health` not `exec`, this shell is zsh (no scalar word-splitting), `utmctl` needs the UTM app running, and `utmctl exec`/SSH land in session 0 and cannot run a capture. [Full detail →](docs/local-worker-vm.md#five-utmctl-quirks-moved-from-claudemd-458).

A correct value read from the wrong place, or a stale value read as current, cost six wrong diagnoses in one day. Ask the authoritative source and let it tell you what it is bounded to. [Full table →](docs/operational-lessons.md#the-diagnostics-lied-to-me-six-times-in-one-day-and-never-once-by-being-wrong)
