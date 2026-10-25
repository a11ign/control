# The fleet is frozen between deliberate whole-fleet upgrades, from one pins manifest

---
Status: accepted (the chairman, 2026-10-24, A11-205)
---

Version drift between capture boxes split the capture cache key and stopped the line again and again. Windows Update was only deferred. A 28-day patch window moved the build forward on a clock, with the newest box as its target. A 15-minute guard raced Edge's updater.

**Nothing on a fleet box upgrades by itself. Every box stays on the versions in `deploy-pins.json`, the one pins manifest, until a person edits that manifest and runs `fleet:patch -- --apply`.** The manifest holds the Windows release, build and KB, Edge, NVDA, Node and the worker code. The upgrade run moves every box to the manifest one at a time, re-freezes each box in `always:`, and ends by reading every box back.

Between upgrades, every self-updater on the box is held off by levers that take effect on standalone Windows 11 Pro. A daily run re-applies only those levers. An hourly read-only check compares every box with the manifest. Any difference fails `fleet:status`, takes that box out of capture and is announced.

This supersedes the patch window (`patch-schedule.yml`, `fleet:patch --scheduled`), the Windows Update deferrals, and "converge forward to the newest on any mismatch" as the normal response to drift. Converging is now the deliberate upgrade only.

## Considered options

- **Keep deferring and patch on a schedule.** Rejected: a deferral expires and installs on its own, and a box that misses the window falls behind. That is the drift this ends.
- **Follow the newest version automatically.** Rejected: the newest is whatever one box picked up first, so the target itself drifts.
- **A per-box exception in the manifest** (for a box whose CPU cannot run the target). Rejected: it is a second set of versions. Such a box is reported as differing until a person decides what becomes of it.

## Consequences

- The upgrade run never rolls back a box that is above the manifest. That box stops the run and is named.
- Security updates, Defender's included, arrive only when a person runs the upgrade. That person decides the cadence, not a timer.
- The manifest names the exact cumulative-update KB, so a run does not overshoot to whatever Microsoft published after the manifest was edited.
- One pin stays in the role's `defaults/main.yml`: the Intel display driver. No box reports its version live, so the provision stamp's hash of that file is the only thing that puts it in the capture cache key. It moves into the manifest when a box reports it.
