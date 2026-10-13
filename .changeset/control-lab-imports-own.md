---
"@a11ign/control": patch
---

Control's lab imports are control's own (a11ign/a11ign#5372, ceo's ruling on a11ign#5335). `post-qualification-status` reads its verdict types from a carried copy, `src/lab-carried.ts`, exported as `@a11ign/control/lab-carried`, instead of reaching `../../lab`. The three tests that read the lab's scripts and corpus move to a11ign/lab (a11ign#5379). No behaviour change.
