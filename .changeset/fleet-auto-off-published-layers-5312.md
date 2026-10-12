---
"@a11ign/control": patch
---

Auto-off imports the fleet's git helper, worker HTTP client and flag refusal from the published `@a11ign/screenreader-fleet` package at its pin, not from a sibling checkout (a11ign/a11ign#5312). `src/fleet-auto-off.ts` resolves its layers from the control checkout's own `node_modules`, and `REPO_ROOT` is the checkout's root. `package.json` declares exactly the two published layers at their `deploy-pins.json` versions, and `tsx` as a dev tool. Behaviour is unchanged: the same helpers, now resolved from the package. Revert: restore the `../../worker-fleet` imports in `src/fleet-auto-off.ts`.
