---
"@a11ign/control": minor
---

`fleetStatus` names the Windows build of a fleet that agrees (a11ign/a11ign#5106). The status gains `windowsBuilds`: the `windowsBuild` each reachable box reported, keyed by URL, whether or not the boxes agree (`null` for a box that answered without one; an unreachable box is not named; the `unknown` placeholder is passed through as the worker sent it). `fleetConsistency` still names a value only where boxes differ, so `reportedOnly` and `mismatches` are unchanged. `buildSpread` in `src/fleet-build-incident.ts` reads the new field instead of inferring "agreed" from the absence of a drift entry, so a fleet where EVERY box is on the placeholder (a fleet-wide restart before the first sample) is unread and an open incident stays open; the same fleet on one real build closes it. A status with no `windowsBuilds` claims nothing read. Revert: drop `windowsBuilds` from the return of `fleetStatus` and restore `readingsOf`.
