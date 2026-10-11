Part of a11ign/a11ign#5026 (parent #4405). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-5026-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-build-incident.test.ts' --include 'src/fleet-watch.test.ts'
```

**As run (measured, 2026-10-11, this head):** `VERDICT pass: 97 tests in 2 files`; `pnpm exec tsc --noEmit` exits 0. The row's command as written (`pnpm exec rstest run <two files>`, no `--config`, no `--include`) printed no `VERDICT` line from this worktree: the toolchain config is the one carrying the `node:test` shim (the same fact `agent~there-is-a-playbook-4445.md` records), so the form above is the one that reports.

## What changed

- `src/fleet-build-incident.ts` (new): `buildSpread(status)` (pure; target = the highest build, dotted-numeric), `reconcileIncident(spread, deps)` (file / nothing / close-duplicate / close-final / hold), `FLEET_BUILD_INCIDENT_LINE`, `openFleetBuildIncident()`, and `ghIncidentDeps(gh)` behind which every `gh` call sits.
- `src/fleet-watch.ts`: `boxValues` and `workerKey` exported (the new file reads the same drift the way `offFleetLines` does, so it imports them instead of copying), one `WatchDeps.buildIncident` seam called once per reading after the status read, `WatchFound.buildIncident`, two terms in `exitCodeFor`, and a section in the #928 post. `main()` passes the real `gh` only under `--post`.
- `src/fleet-watch.test.ts`: the two `exitCodeFor` fixtures carry `buildIncident`; three new tests for the seam and the exit codes.
- `src/fleet-build-incident.test.ts` (new): 21 tests; the drift comes out of the REAL `fleetConsistency`.
- `.changeset/fleet-watch-reads-the-5026.md` (minor).

## The incident contract, exactly as filed

- Repository `a11ign/a11ign`; labels `incident`, `lane:orchestrator`, `ready`, `priority`, `out-of-release` (all five exist: read with `gh label list`).
- Title `Mixed Windows build across the fleet: <n> boxes behind <target>`, where `<n>` is the laggard count.
- Body carries `Incident: incident:fleet-build-mixed` on a line of its own; the constant is `FLEET_BUILD_INCIDENT_LINE` and the reader matches a LINE equal to it, never the id anywhere in a body (the body's own Acceptance quotes the id).
- The body has `## What it is`, `## Change` (none), `## Region` (a reading), `## Acceptance`, `## Open-check`, `## Done-when`, `## Tier`, `## Fleet` (Yes).
- One-line revert: drop `buildIncident: ...` from `main()` in `fleet-watch.ts`.

## The gate and the filed body (Done-when 4)

The generated body was run through agent-org's own `missingTemplateFields` (`src/row-claim/template-fields-rule.ts`) from a scratch script: `[]`, none of Region, Acceptance, Open-check missing. What the gate may still object to: `## Region` holds no path (`A reading: no file is changed by this row.`), so a file-overlap reading sees an empty Region; and the Acceptance uses `gh`, which the credential-less `acceptance` job cannot run, so it is a hand-run command like any `gh`-reading Acceptance. Neither affects the line: the open issue is what dispatch reads and what the 4-hour wake reads.

## Mutations (`cp` before, `cp` after, `cmp` identical; the new test file run after each)

- target = the most COMMON build: 6 fail, including the ruling-map and the "ten older, five newer" tests.
- plain string compare in place of dotted-numeric: 2 fail (the test where a build's third component is 9 against one whose is 10, and the ruling map).
- never files: 5 fail. Files when not mixed: 2 fail. Files when mixed with one already open: 3 fail.
- closes with a box unread: 1 fails (the unread test only). Never closes: 2 fail.
- duplicate closes the OLDER: 1 fails. Matches the id anywhere in a body: 1 fails. A search in place of the label list: 1 fails. A failing `gh` swallowed as "none open": 3 fail.
- in `fleet-watch.ts` (the fleet-watch tests): `cannotAsk` ignored by `exitCodeFor`: 1 fails; a filed incident not ATTENTION: 1 fails; the seam never called: 1 fails.

## Not done here, and a known limit

- **Every box on the SAME placeholder reads as read.** `fleetConsistency` names a `windowsBuild` value only where somebody disagrees or did not report, so a fleet that agrees on `unknown` (a fleet-wide restart before first sample) is indistinguishable at this seam from one that agrees on a build, and an open incident would close. One placeholder among real builds IS caught. Closing it needs `fleetStatus` to expose the agreed value, which is outside this row's Region; `known limit` is pinned by a test that must be turned around when it lands. Filed as a11ign/a11ign#5106.
- **A stale title.** A mixed fleet with one incident open is not commented on again (the row's rule), so the title keeps the `<n>` it was filed with while boxes are patched forward.
- **Filing, closing and the 4-hour wake were not exercised against GitHub.** Every effect is tested against the `gh` seam only (Done-when 3); the first live run is the orchestrator's, as the row says.
- `pnpm test` here ran 35 tests in 6 files (`VERDICT pass`); the 14 files that fail under `tsx --test src/*.test.ts` fail identically on the unmodified primary control checkout (they import sibling layers by relative path), measured.

Closes a11ign/a11ign#5026
