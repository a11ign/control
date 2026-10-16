---
"@a11ign/control": patch
---

A manager's fleet-hold read now comes from the gate's snapshot, not the API. The host's `gh` refuses a manager's `issue list --json body` before making any call, so `fleet:deploy` and `fleet:provision` were refused from a manager account on every run, including when no hold existed (a11ign/a11ign#5155, row a11ign/a11ign#5575). The read follows that refusal to `gate-snapshot-read rows --json` and fails closed, every way the snapshot can be missing: unreadable, older than 15 minutes, a row without labels, or a fleet-gated row without its body. Every other caller runs the live `gh issue list` with the same argv as before. Revert: restore the `readFleetGatedIssues` body and delete `readGateSnapshot`, `gatedRowsFromSnapshot` and the two constants beside it.
