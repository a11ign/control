---
"@a11ign/control": patch
---

The patch window's "staged but not switched" refusal matches only an entry naming the staged media (a11ign/a11ign#5052, found at #4405). `patch_safeos_pattern` in `ansible/patch.yml` is `\$WINDOWS\.~BT` alone: `winpe\s+Yes` is on the Windows Recovery Environment entry every Windows 11 BCD carries, so the old pattern passed a box that never switched. Revert: restore `|SafeOS|winpe\s+Yes` to the pattern.
