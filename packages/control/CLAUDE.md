## Working on a Mac (the usual case)

> **THE LOCAL UTM WORKER VMs ARE DEPRECATED. Capture on the bare-metal fleet.** Every box
> `inventory.yml` lists (`a11y-worker-2` upward; `-1` is retired and its number is never reused.
> [`-10` rejoined 2026-09-09 →](docs/operational-lessons.md#a11y-worker-10-withdrawn-2026-09-07-rejoined-2026-09-09)) serves
> `/health` without a laptop in the path, and `npm run fleet:status` is the one command that says
> so. Deploy with **`npm run fleet:deploy`**, never `worker:deploy` — that one is `utmctl file push` to a
> VM UUID and cannot reach a physical box.
>
> [Why this note exists, and what "kept" means below →](docs/operational-lessons.md#why-the-deprecation-note-exists-and-what-kept-means)

Everything except capture runs natively. Capture needs a Windows worker. The fleet is the answer;
`docs/getting-started.md` and `docs/local-worker-vm.md` describe the deprecated local VM.

```bash
npm run worker:ctl -- up        # start/resume the VM, wait for /health
npm run worker:ctl -- status    # state, host cost, health
npm run worker:ctl -- pause     # see below: UTM cannot actually suspend these guests
npm run witness -- https://example.com --task "..."   # no A11Y_WORKER needed
```

With no `A11Y_WORKER` set the run finds the local VM, starts it, and **puts it back as it
found it** — so a VM you started yourself is left running. `--after stop|pause|leave`
overrides. `--no-axe` skips the optional rule layer; `--axe-results file.json` imports one you
already ran.

**Changing any worker file means deploying to the guests. One command — but WHICH command depends on
what the worker is.**

```bash
npm run worker:deploy                     # UTM VMs on this Mac only — utmctl file push, keyed on a VM UUID
npm run worker:deploy -- --vm=a11y-worker-2
npm run worker:code                       # each worker's /health.code vs this checkout — works for both
```

`worker:deploy` **cannot reach a bare-metal worker**: it is `utmctl file push` plus a `utmctl` reboot, it
takes a VM UUID rather than a host, and it fails immediately off macOS. Physical boxes are git-cloned
rather than file-pushed, so they deploy by pulling:

```bash
npm run fleet:deploy                  # pull + install + restart + PROVE it (bare metal)
npm run fleet:provision               # the ROLE: NVDA, the Edge pin, policies, and the provision stamp
npm run fleet:provision -- --serial=0 # all boxes at once, rather than one at a time
eval "$(npm run --silent fleet:env)"                                # A11Y_WORKERS from inventory.yml
npm run fleet:status                                                # what every box is doing, right now
```

`fleet:provision --serial=0` (all at once) is right here because `provisionRevision` is a MUST_MATCH cache key — a canary box IS the failure mode. [Why →](docs/operational-lessons.md#fleetprovision---serial0-and-the-sre-workbook)

`fleet:deploy`/`fleet:provision` REFUSE a worker that is capturing (a HARD fail, `-e a11y_force_deploy=true` overrides) — `recover.yml`/`restart.yml` are exempt, since they act on a worker that is busy AND wedged. `fleet:status` surfaces a **degraded** guest: the fault that produces zero failures because the worker's own retry absorbs every recovery. [Why the hard fail →](docs/operational-lessons.md#fleetdeployfleetprovision-refuse-a-capturing-worker)

**Long lab work runs through Ansible, not through a shell.** Training, dataset builds, abstention sweeps and
real-page captures are named jobs, dispatched with fixed argv and supervised by systemd:

```bash
npm run lab:job -- -e job=train                 # the catalogue is in ansible/lab-job.yml
npm run lab:job -- -e job=capture-real-pages -e worker=a11y-worker-2 -e role=training -e shard=0/4
npm run lab:status                              # every a11y-job-* unit and its state
npm run lab:status -- -e job=train              # systemd's view + the journal + the run's own progress file
npm run lab:stop -- -e job=capture              # end one deliberately; reports what it discards first
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

A new bare-metal box needs no console visit — PXE + `autounattend.xml` plants the account and key. Deploy pushes every hashed file (defined once in `packages/nvda-worker/src/worker-files.mjs`) and reboots each guest, since `utmctl exec` cannot be trusted to restart the worker. Roll back by checking out the ref and redeploying — git is the source of truth. `worker:deploy` refuses a `CAPTURE_PROTOCOL_VERSION` change without `--allow-protocol-change` (it invalidates the whole cache). [Full detail →](docs/operational-lessons.md#a-new-box-needs-no-console-visit-and-the-protocol-version-trap)

Five more `utmctl`/local-VM quirks that have each cost real time — do not restart with `utmctl exec` and believe it, verify through `/health` not `exec`, this shell is zsh (no scalar word-splitting), `utmctl` needs the UTM app running, and `utmctl exec`/SSH land in session 0 and cannot run a capture. [Full detail →](docs/local-worker-vm.md#five-utmctl-quirks-moved-from-claudemd-458).

A correct value read from the wrong place, or a stale value read as current, cost six wrong diagnoses in one day. Ask the authoritative source and let it tell you what it is bounded to. [Full table →](docs/operational-lessons.md#the-diagnostics-lied-to-me-six-times-in-one-day-and-never-once-by-being-wrong)
