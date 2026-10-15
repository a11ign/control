---
"@a11ign/control": patch
---

The gate heartbeat unit runs `gate-heartbeat.ts` from control's own checkout at `/root/control` (the path `a11y-fleet-auto-off.service` already names, #5312), not from the laid copy at `/root/a11y-witness/packages/control`. Nothing the heartbeat needs is in that copy, and the laid path is what a11ign#5440 removes. Revert: restore the `ExecStart` path to `/root/a11y-witness/packages/control/src/gate-heartbeat.ts`.
