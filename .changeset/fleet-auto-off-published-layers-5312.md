---
"@a11ign/control": patch
---

Control's fleet auto-off runs from control's own checkout (a11ign/a11ign#5312, #5335, ADR 0045 cut 9). `REPO_ROOT` is the checkout's root, and the git-safe environment, protocol guard, code-drift and pnpm-executable helpers come from the published `@a11ign/screenreader-fleet` 0.10.2 (`src/git-safe-env.ts` re-exports the first, so the core's git-spawn guard still sees it). `package.json` declares exactly the two published layers at their `deploy-pins.json` versions, and `tsx` as a dev tool. `CORE_REF` moves to `c5dddb33` and `ci.yml` lays the three layers itself, since the core no longer does. The `valueAt` / `edgeUpdaterGuard.state` re-carry (#5021) is restored in `worker-fleet-carried.ts`. Revert: restore `CORE_REF` and the `../../worker-fleet` imports.
