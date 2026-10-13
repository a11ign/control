---
"@a11ign/control": patch
---

The worker role creates `C:\ProgramData\a11ign` before it lays the Edge-updater guard script, so `fleet:provision` no longer fails on every box that lacks it (a11ign/a11ign#5466). The directory is writable only by SYSTEM and Administrators, and Users can read it, because the script runs as SYSTEM and the unelevated worker reads the guard's record from it.
