# Fleet leases are one ledger on the control plane, in control, not in screenreader-fleet

---
Status: proposed (A11-244, written by an unattended planning run and not yet agreed by a person)
---

ADR 0036 calls screenreader-fleet the fleet's "lease/health/capacity" layer. Booking boxes so that
jobs and scheduled work never collide (A11-244) still lives in control: one versioned JSON ledger at
`/var/lib/a11y-fleet-leases/ledger.json`, written under a pid-checked mutex. Every taker reads and
writes it: the job service, the hourly drift check, the daily freeze and auto-off. Every one of them
runs on the control plane.

We chose this over three alternatives:

- **Extending screenreader-fleet's `leaseWorker`.** It is a local-VM lifecycle, and its release is a
  no-op on bare metal.
- **Publishing a lease module from screenreader-fleet.** Control-plane reach stays out of the
  published package (ADR 0012). Moving control's fleet pin also moves what `fleet:deploy` ships, and
  A11-205 freezes that between deliberate upgrades.
- **Making the job service the only lease authority.** The freeze and the drift check are separate
  timers, and they must keep running when the service is down.

## Consequences

- The ledger is written from two checkouts (`/root/fleet-jobs` and `/root/control`), so it carries
  `"version"`. A reader that sees a version it does not know treats every box as held.
- Anything new that touches a box from the control plane takes a lease here: `capture` and
  `maintain` are exclusive, and `read` is shared with `capture`. The person-run plays are the next
  takers (A11-244's follow-ups: `docs/fleet-jobs.md`, "Not here yet").
