Row a11ign/a11ign#5660. The fleet is split across Edge builds only when somebody looks: `browserVersion` is MUST_MATCH, so a capture refuses a fleet whose boxes differ from each other, but nothing raised it before capture day, and a fleet that agrees on the WRONG build has no drift entry at all. The off-fleet watch now compares each box's own reported Edge version to the pin.

Acceptance: `git grep -q "EDGE_PIN_PREFIX" -- ':!*.test.ts' ':!.acceptance'`

The job cannot run the Region's tests from its acceptance block (the row's own Acceptance is hand-run from `~/repos/control`). This line is the job-runnable part: it proves the Edge-pin line is in the tracked source (non-test files). The tests are measured under Evidence.

## What changed

- `src/fleet-status.ts`: `fleetStatus` carries `browserVersions` (`browserVersionsOf`): each reachable box's own `environment.browserVersion` keyed by URL, whether or not the boxes agree. Same seam as `windowsBuilds` (#5106). `windowsBuildsOf` now shares the string-or-null helper.
- `src/fleet-watch.ts`: `edgePinLines(status, pin)` raises `edge-pin: <box> <version> (pin <pin>)` for every reachable box whose reported version is not the pin. An unreachable box, a box that reported nothing and the `unknown` placeholder are no reading. `offFleetLines` takes the pin as an optional second argument (absent: no Edge-pin line, existing readings untouched). `readEdgePin` reads `worker_edge_version` from the role defaults and THROWS on a file that declares none. `watchFleet` wires it through `deps.edgePin`. `boxOfLine` reads the new prefix, so an asleep box's entry is carried and not cleared by silence.
- `src/control-owned/edge-version-fleet-reading.test.ts` (new, 9 tests): one box off the pin is named with its version; every box on the pin is clean; each box off is named (older, newer, several); a fleet that AGREES on the wrong build is still raised, with the premise asserted (no `browserVersion` drift entry); the same reports against another pin read differently (pin is the argument, reports are the data); unreachable / unreported / placeholder boxes are no reading; `readEdgePin` against the role defaults parsed independently, and its throw; `watchFleet` raises once, stays quiet while off, carries through sleep, clears on return, and re-raises. Driven through the REAL `fleetStatus`.
- `src/control-owned/edge-pin-parity.test.ts`: found its files from a monorepo root four levels up, so in control's own checkout it read `/home/agent/packages/control/...` and the row's Acceptance could not pass there (ENOENT at baseline). It now locates the role defaults from its own path and the bootstrap from `node_modules/@a11ign/screenreader-fleet` or, in the core's lay, `../worker-fleet`; neither present throws.
- `.changeset/a-box-off-the-edge-pin-is-raised-5660.md`: patch.

## Decisions

- The reference is the PIN, not the fleet's majority (unlike build and display): a majority reference cannot see a fleet that agrees on the wrong build.
- #4405's convergence covers the Windows build, the display mode and the Edge UPDATER. The Edge VERSION reading is this row's. Converging a box is not: the pin's history here (the rollback three boxes would not take) is why this raises and does not repair.

## Evidence (measured 2026-10-16, worktree `~/repos/control-wt-5660`)

- Row Acceptance, `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/control-owned/edge-version-fleet-reading.test.ts' --include 'src/control-owned/edge-pin-parity.test.ts'`: `VERDICT pass: 13 tests in 2 files`. At baseline the parity file failed with ENOENT.
- `pnpm run typecheck`: exit 0. `pnpm test` (control's own): `VERDICT pass: 45 tests in 8 files`.
- `src/fleet-watch.test.ts`, `src/fleet-status.test.ts`, `src/fleet-build-incident.test.ts`, `src/control-has-no-dependencies.test.ts`: all pass. `src/control-owned/fleet-consistency.test.ts` fails 4 of 4 with and WITHOUT this change (same layout defect, outside the Region; not changed here).
- Mutation, `version !== pin` replaced by a constant false in `edgePinLines`: `6 of 9 tests failed`. Restored from a copy, `diff`-identical.
- Not run: eslint (no eslint in this checkout; CI runs it in the core's lay).

Closes a11ign/a11ign#5660

🤖 Generated with [Claude Code](https://claude.com/claude-code)
