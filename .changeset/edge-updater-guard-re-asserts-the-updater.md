---
"@a11ign/control": patch
---

The worker role registers `a11y-edge-updater-guard`, a SYSTEM task that at startup and every 15 minutes stops and disables every `MicrosoftEdgeUpdate*` task and the updater's services, and writes `C:\ProgramData\a11ign\edge-updater-guard.json` (`{checkedAt, reenabled}`) naming what it had to change; the closing assertion requires it to exist and be enabled (a11ign/a11ign#5015, part of #4405).
