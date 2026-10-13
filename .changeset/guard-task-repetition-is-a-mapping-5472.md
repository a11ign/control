---
"@a11ign/control": patch
---

The worker role's Edge-updater guard task writes its repeat trigger's `repetition` as a mapping, which `win_scheduled_task` accepts, so `fleet:provision` no longer fails on every box at "Register the guard task" with `Index was outside the bounds of the array` (a11ign/a11ign#5472).
