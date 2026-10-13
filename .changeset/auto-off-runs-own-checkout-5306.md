---
"@a11ign/control": patch
---

The fleet auto-off unit runs `src/fleet-auto-off.ts` from control's own checkout (`WorkingDirectory=/root/control`, a11ign/a11ign#5306, #5312) and no longer runs `scripts/lay-layer.ts`, which a11ign#5087 deleted, so every tick had refused `cannot-tell`. Its `ExecStartPre` keeps the follow-`main` fast-forward and lays nothing: `@a11ign/worker-fleet` comes from `pnpm install` in that checkout. Revert: restore the unit's `WorkingDirectory=` and `ExecStart=` lines and the two `lay-layer.ts` steps in `ExecStartPre`; the unit then runs the laid copy again.
