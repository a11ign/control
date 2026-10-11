---
"@a11ign/control": patch
---

`ansible/patch.yml` commits a staged feature update's switch and fails a box that staged without switching (a11ign/a11ign#5002, #4979): a pass that installed an `Upgrades` item and asked for a restart runs `UsoClient.exe StartInstall`, reads `bcdedit /enum all` for a SafeOS entry, and fails the box `staged but not switched` (with the entries) before any restart. A pass with no `Upgrades` item is unchanged. Not run live: the window on worker 6 is its own VERIFY row.
