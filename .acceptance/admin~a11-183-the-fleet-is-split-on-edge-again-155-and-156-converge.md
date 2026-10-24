A11-183 (https://linear.app/a11ign/issue/A11-183/the-fleet-is-split-on-edge-again-155-and-156-converge-forward-hold), step 2 of 2. The fleet's Edge pin follows forward to 156.0.4314.42, the Edge updater guard can hold the updater as SYSTEM, the updater's network is blocked as a second lever, and `fleet:status` fails (exit 3) on a split Edge, NVDA or Windows build or on an updater that is not held, naming the boxes and values.

Acceptance:

```bash
node --test src/fleet-status.test.ts src/fleet-converge.test.ts src/control-owned/edge-updater-guard.test.ts src/control-owned/edge-updater-firewall.test.ts src/control-owned/edge-pin-parity.test.ts src/control-owned/edge-updater-before-install.test.ts src/control-owned/provision-stamp-inputs.test.ts
```

**What the block shows:** one value per field is clean and exits 0; today's three-way Edge reading names each box under its version and exits 3; a Windows-only split, an NVDA-only split, an unreported field and a guard that is `stale`, `drift` or absent each fail by box; an unreachable box is no split; `--json` carries `buildSplit`; `fleet:converge` reads exit 3 as `failed`. The guard writes `Start` 4 through the registry (never `Set-Service`), stops `MicrosoftEdgeUpdate*` processes, catches each item, always writes its record and exits non-zero when anything stayed on; the closing assertion starts the guard and requires result 0; the firewall block is outbound, on every profile, on the updater's image; each with a control that fails when the property is removed.

**Live check after merge** (the chairman session, from the control plane): `pnpm run fleet:status` shows a single `Edge:` group in its `fleet builds AGREE` / `fleet BUILD SPLIT` line and the split check present. It exits 3 while `a11y-worker-5` stays on Windows 22631 (the hardware limit), and the only `BUILD SPLIT` line it prints is then `Windows`.
