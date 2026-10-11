Row a11ign/a11ign#5048 (part of a11ign/a11ign#4405). The guard's record was rewritten fresh each run, so a clean run wrote `reenabled: []` and a drift outlived the run that found it by one interval. The script now reads the previous record and carries `lastReenabledAt` and `lastReenabled` forward across clean runs.

Closes a11ign/a11ign#5048

platform: nothing new built; the same PowerShell script, one read added.

Acceptance:

```bash
cd /home/agent/repos/control && node --test src/fleet-layer/edge-updater-guard.test.ts
```

**As run (measured), in the PR's worktree:** `tests 12, pass 12, fail 0` (7 existing, 5 new: the carry-forward and four controls: no read of the previous record, no carry on a clean run, no set from a changed run, a clean run that invents a stamp).

**Behaviour (measured with `pwsh`, the record block of the script extracted and run in sequence):** dirty, clean, clean, dirty, clean gave `lastReenabledAt` = run 1, run 1, run 1, run 4, run 4 with `lastReenabled` following; two clean runs on a fresh directory wrote neither field.

## Not done here
- Not run on a Windows box and no `fleet:*` was run; the worker's reader and the fleet's `REPORTED_ONLY` entry take the new fields in the following row.
