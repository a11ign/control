Part of a11ign/a11ign#5026 (the known limit it filed as #5106). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5106-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-build-incident.test.ts' --include 'src/fleet-status.test.ts'
```

**As run (measured, 2026-10-11, this head):** `VERDICT pass: 107 tests in 2 files`; `pnpm exec tsc --noEmit` exits 0; `pnpm exec layout-check` prints `ok`. The row's command as written (`bash -c 'cd /home/agent/repos/control && ...'`) runs the primary checkout, which does not hold this change, so the form above is the one that reports on this branch. Before the change: 102 tests, `VERDICT pass`.

## What changed

- `src/fleet-status.ts`: `windowsBuildsOf(guests)` (exported, pure) and `windowsBuilds` on what `fleetStatus` returns: URL to the reported build, `null` for a box that answered without one; unreachable boxes absent; the `unknown` placeholder passed through.
- `src/fleet-build-incident.ts`: `readingsOf` reads `windowsBuilds` (falling back to the drift's values when a status has none), so a box is read only when it reported a real build. The `compared` input and the branch that read every answered box as read when no drift entry existed are gone.
- `src/fleet-build-incident.test.ts`: the `KNOWN LIMIT` test is turned around (the placeholder fleet's incident stays open) with its positive control (the same fleet on one real build closes it); the fixture takes `windowsBuilds` from the real `windowsBuildsOf`; the dropped-from-comparison test becomes the no-environment test; one new test for a status without the field.
- `src/fleet-status.test.ts`: three tests drive the real `fleetStatus`: an agreeing fleet names its build with no `windowsBuild` drift entry (split fleet as the control), the placeholder passes through, a no-build box is `null` and an unreachable one absent.
- `.changeset/fleetstatus-names-the-windows-5106.md` (minor).
- `src/fleet-watch.ts` is untouched: `watch` hands the whole status to the seam, and `StatusReader` already omits `compared` the same way, so the type needs no name for the new field.

## The placeholder's source, and how it was read

`unknown` is the worker's `/health.environment.windowsBuild` from process start until its first sample: `let windowsBuild = "unknown"` in the worker's `packages/nvda-worker/src/server.ts` (`refreshWindowsBuild`, run on the version sampler's timer, memoised only on a real answer; `windowsBuildFrom` also returns `unknown` for a half reading such as `26100.`), and `currentEnvironment()` returns it beside `windowsVersion`. **Read from that source file, not from a live `/health`**: the resource ban holds an engineer off the fleet, so no box was asked.

## Mutations (`cp` before, `cp` after, `cmp` identical; both test files run after each)

- Incident reader ignores `windowsBuilds` (drift only): 4 fail (the agreeing-fleet control, the no-environment test, and the two close-on-read tests).
- Placeholder counted as a build: 3 fail, including the placeholder-fleet test.
- Every box unread (the guard always fires): 17 fail, including the positive control that closes.
- `fleetStatus` omits `windowsBuilds`: 3 fail, all in `fleet-status.test.ts`.
- `windowsBuildsOf` drops the placeholder: 1 fails (the pass-through test only).
- `windowsBuildsOf` names only the first guest: 19 fail.
- Old `fleet-build-incident.ts` restored over the new tests: 4 fail, among them the placeholder fleet (the incident closes there).

## Not done here

- **A fleet with no rows at all still closes an open incident** (no row is unread, none is mixed). It was true before this change and no inventory is empty in practice; not widened here.
- **Filing, closing and the 4-hour wake were not exercised against GitHub**, as in #5026: every effect is tested against the `gh` seam.

Closes a11ign/a11ign#5106
