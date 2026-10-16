---
"@a11ign/control": patch
---

The fleet watch raises a box whose own reported Edge version is not the role's pin (a11ign/a11ign#5660): `edge-pin: <box> <version> (pin <pin>)`, one line per box, before capture day and not as the `browserVersion` refusal during one. The reading is each box's own `/health` report (`fleetStatus` now carries `browserVersions`, agreeing or not) against `worker_edge_version`, so a fleet that agrees on the wrong build is raised too. `edge-pin-parity.test.ts` locates its files from its own path, so it runs in control's checkout as well as the core's lay (`src/fleet-watch.ts`, `src/fleet-status.ts`).
