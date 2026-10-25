# Fleet facts: every box's hardware, read through the job service

`fleet facts submit` reads each box's make, model, BIOS, CPU, RAM, disks, Windows build, TPM and Secure Boot state, and keeps them in `fleet-facts.json`. It is a job of the [fleet job service](fleet-jobs.md): the boxes are booked like a capture's, the job is followed by its ID, and nothing on any box changes. A11-283 built it; [`docs/adr/0005`](adr/0005-the-job-service-runs-one-read-only-play-the-facts-read.md) says why the service runs a play at all.

## Using it, from the agents host

```bash
set -a; . ~/.config/a11ign/fleet.env; set +a
pnpm run fleet -- facts submit --boxes all --label A11-283        # prints the job ID at once
pnpm run fleet -- job wait fj-20261025T181500Z-3a1b2c --timeout 30m
pnpm run fleet -- facts show                                       # the table
pnpm run fleet -- facts show --json --boxes a11y-worker-2,a11y-worker-3
```

`--boxes` is `all` (every box in the control plane's inventory, **named** at submit, whatever its drift or readiness), a number of boxes (the least loaded free ones), or names separated by commas. `ready` is refused: a facts job exists to wake the boxes that are asleep. `--label` is required: the ticket key. A facts job takes no pages, cases, passes, body or freeze, and each is refused by name. `job status`, `wait`, `list`, `fetch` and `cancel` work on it as on a capture job.

## What a job does

1. **Books** its boxes with a `capture` lease, as a capture does. It is not subject to the drift record: hardware does not depend on the manifest, so a box that is off it is still read.
2. **Reads each box in turn** (`src/fleet-facts/read.ts`): wakes that one box, then runs `ansible/facts.yml --limit <box>` from the service's checkout with the JSON stdout callback and a 10-minute limit.
3. **Checks the play**: `changed` for the box must be 0, or the box's entry fails with `the facts play changed <n> things on <box>; it must change nothing`; the output must parse (`parseFacts`), or the entry fails naming the missing field.
4. **Records** `results/<box>.facts.json` (`{ readAt, worker, status, changed, facts | error }`) and the box's entry in the facts file.
5. **Lets the box go** as its read ends. The idle power-off (`fleet-auto-off.ts --apply`) sleeps it on its next tick, as after a capture; the job runs no `sleep.yml`.

A box that does not wake, is unreachable, fails the play or returns output that is not whole gets a failed entry with the reason; the job goes on with the other boxes and ends `done`. It ends `failed` only when no box could be read.

## The facts file

`/etc/a11ign/fleet-facts.json`, beside the control plane's inventory (`A11Y_FLEET_FACTS_FILE` overrides it for tests). The job service is its only writer, by read-merge-write after each box.

```json
{ "version": 1, "boxes": { "a11y-worker-2": {
  "readAt": "2026-10-25T18:30:00.000Z", "stale": false, "lastAttemptAt": "2026-10-25T18:30:00.000Z", "lastJob": "fj-20261025T181500Z-3a1b2c", "lastError": null,
  "facts": { "make": "LENOVO", "model": "ThinkCentre M720q", "machineType": "10T8", "serial": "…", "bios": { "version": "…", "date": "2024-03-14" },
             "cpu": { "name": "…", "cores": 6, "threads": 6 }, "ram": { "totalBytes": 0, "modules": 2, "speedMtps": 2666 },
             "disks": [{ "model": "…", "type": "SSD", "bus": "NVMe", "sizeBytes": 0 }], "systemDrive": { "freeBytes": 0, "sizeBytes": 0 },
             "windows": { "build": "26200", "ubr": 0, "displayVersion": "25H2", "edition": "Professional" },
             "tpm": { "state": "present", "ready": true, "specVersion": "2.0, 0, 1.38" }, "secureBoot": { "state": "enabled" } } } } }
```

- **A good read replaces the box's entry**: `stale: false`, `readAt` now.
- **A failed read keeps the last `facts` and `readAt`** and sets `stale: true`, `lastAttemptAt` and `lastError`. A box never read has `facts: null` and `stale: true`.
- **A file that cannot be read is not overwritten** (not JSON, or an unknown version). The box's record still lands in the job's results, its entry is failed naming the file, and the file is left alone.

## What the play reads

`ansible/facts.yml` runs one task, `Read the box's hardware`, from CIM and the registry only: `Win32_ComputerSystem`, `Win32_ComputerSystemProduct`, `Win32_BIOS`, `Win32_Processor`, `Win32_PhysicalMemory`, `Get-PhysicalDisk`, `Win32_LogicalDisk` for `$env:SystemDrive`, the `CurrentVersion` registry key, `Get-Tpm` with `Win32_Tpm.SpecVersion`, and `Confirm-SecureBootUEFI`. TPM and Secure Boot are each in a `try`: a read that throws is `unknown` with the message, and Secure Boot on a legacy BIOS is `unsupported`. It uses no `become` and no module but `win_powershell`.

Make, model and machine type depend on the vendor. **Lenovo** (`Manufacturer` `LENOVO`): the model is `Win32_ComputerSystemProduct.Version` (`ThinkCentre M720q`) and the machine type the first four characters of `Win32_ComputerSystem.Model` (`10T8`). **Any other make**: the model is `Win32_ComputerSystem.Model` (`HP ProDesk 600 G4 DM`) and the machine type is `SystemSKUNumber`, the HP product number.

## `fleet facts show`

One row per box, in the inventory's order, then any box only the file knows. Disk sizes are decimal gigabytes (as sold), RAM is binary gigabytes rounded, and a RAM speed is the slowest module's configured one.

| Column | Content |
| --- | --- |
| box | the box's name |
| make / model (type) | `LENOVO ThinkCentre M720q (10T8)` |
| serial | the BIOS serial |
| BIOS | version and date |
| CPU | name, `cores c / threads t` |
| RAM | `16 GB, 2 × 2666 MT/s` |
| disks | `model bus type size`, joined with `; ` |
| free on system drive | `free / size GB` |
| Windows | build and UBR, and the display version |
| TPM | present, ready and spec version |
| Secure Boot | the state |
| read at | the time, or `STALE: last read <readAt>; last attempt <lastAttemptAt>: <lastError>`, or `never read` |

`--json` prints the file as it is (`--boxes` narrows it). `show` exits 2, saying that no facts job has run, when the file does not exist.

## Not here yet

Facts for the control plane, the hypervisor or the lab; lab access to the facts commands; comparing facts across runs or alerting on a change; scheduling facts reads.
