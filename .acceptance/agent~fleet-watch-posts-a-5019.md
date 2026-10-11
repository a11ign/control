Row a11ign/a11ign#5019 (#4405 item 2). Region is `src/fleet-watch.ts` and `src/fleet-watch.test.ts` only. No `fleet:*`, `lab:*`, `worker:*` or capture command was run (resource ban); the lock is exercised through `watchFleet` with an injected `fleetLock` reader and the real `parseFleetLock`.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include src/fleet-watch.test.ts --include src/fleet-watch-auto-off-mirror.test.ts`

**As run (measured, 2026-10-11):** baseline before the change `VERDICT pass: 92 tests in 2 files`; after it `VERDICT pass: 98 tests in 2 files` (six new). `pnpm run typecheck` exit 0; `pnpm run layout-check` ok; `pnpm test` `VERDICT pass: 35 tests in 6 files`. `pnpm exec rstest run ... --include 'src/fleet-*.test.ts'`: 575 tests, none failed, but `src/fleet-auto-off.test.ts` does not load (`Cannot find module '../../../scripts/lay-layer.ts'`). That import resolves only inside the a11y-witness monorepo layout, and it is on `origin/main` as well, so it is not this change. Mutations, each restored from a scratchpad copy and checked byte-identical: raising the ENDED lock (negative control) fails 1 test; making the unreadable lock quiet fails 2; dropping the carry when no reader is passed fails 1; dropping the `fleet-lock` branch of `carriesEntry` fails 1; stating the stale time from `takenAt` instead of `expiresAt` fails 3.

Judgment on the row's definition of stale: a lock whose operation ENDED and whose grace has passed raises nothing. The row says "stale" means an un-ended, crashed run; a finished sequence is designed to let go on its own (`fleet-lock.ts`'s header).

Closes a11ign/a11ign#5019
