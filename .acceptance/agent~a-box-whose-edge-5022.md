Row a11ign/a11ign#5022 (parent #4405 item 3). Region is `src/fleet-watch.ts` and its test only. No `fleet:*`, `lab:*`, `worker:*` or capture command was run (resource ban); the off-fleet ledger is exercised through `watchFleet` with fake deps.

Acceptance: `pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include src/fleet-watch.test.ts`

**As run (measured, 2026-10-11):** `VERDICT pass: 81 tests in 1 file`. Full control suite `pnpm test`: `VERDICT pass: 35 tests in 6 files`. `pnpm run typecheck` clean; `pnpm run layout-check` ok. Mutations, each restored from a scratchpad copy and checked byte-identical: adding `absent` to the odd set fails the negative control (`edge-updater: a11y-worker-3 absent` raised); removing the `edge-updater` branch of `boxOfLine` fails the carry test (an asleep box's entry is dropped).

Closes a11ign/a11ign#5022
