Part of a11ign/a11ign#4944 (parent #4405, outcome 1). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-4944-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-status.test.ts' --include 'src/fleet-playbook.test.ts'
```

**As run (measured, 2026-10-11):** `VERDICT pass: 195 tests in 2 files`. The row's Acceptance as written (`pnpm exec rstest run --config scripts/rstest/rstest.config.ts src/fleet-status.test.ts src/fleet-playbook.test.ts`, positional paths) prints `VERDICT REFUSED: 0 tests run`: the shared config's `include` is `scripts/**/*.test.ts` only, so the `src/` files need `--include`, the same fact #4445's file records.

## What changed

- `src/fleet-status.ts`: `probeWorker` runs the `/health` and `/progress` pair once and, if either fails, runs the pair again (`retryOnce`). A box that answers the retry is reachable; a box that fails twice keeps today's result, its `error` the second failure's message. The request is an injected dependency (`request = requestJson`, the pattern `probeIdle` and `probeWorker` in `fleet-wake.ts` already use), so a test can make a probe fail once.
- `src/fleet-status.test.ts`: three tests. (a) fail-once-then-answer is `reachable: true` with both readings, for `/health` and for `/progress` (the positive control, and the case that bit); (b) fail-always is `reachable: false` with the error after exactly two attempts per path (the bound: an unbounded retry would hang a gate on an off box); (c) a box that answers first time is asked exactly once per path (the retry is for a failure, not every call).

## Mutations (`sed` on a copy, restored with `cp`, `diff` byte-identical)

- Retry deleted (`await retryOnce(...)` -> bare `Promise.all`): 2 fail, (a) and (b). (c) passes, as it should.
- Retry always fires (an extra attempt on success): 1 fails, (c). (a) and (b) pass.
- Unmutated: 79 of 79 pass in `fleet-status.test.ts`.

## Off-box cost

A box that is OFF now costs two `PROBE_TIMEOUT_MS` (5 s each) instead of one, in parallel with the other boxes, so the probe over 15 boxes takes about 10 s instead of 5 when a box is off. Retrying only non-timeout failures was the alternative the row allowed; not taken, because a `socket hang up` and a timeout are both one failed request and the row's measured case is the former. Say so if the cost is not acceptable.

## Not done here

- **The cause of the single failure is not proved.** The row guessed a stale keep-alive socket; the retry is measured to clear it, not explained.
- `patchRefusal` still refuses a box that does not answer the retry: the existing test at `src/fleet-patch.test.ts` (#4446) is unchanged and passes.
- Fleet tests outside this change: the wider `src/fleet*.test.ts` + `src/fleet-layer` run has 16 failures (`Cannot find module '../../../scripts/lay-layer.ts'`, `guards/src/walk-scope.ts`, `/home/agent/packages/control/...`). They need the full a11ign/a11ign tree this standalone checkout does not have. The identical 16 fail on pristine `origin/main` (597 tests there, 600 here with the three added).
- Nothing here reaches the fleet or the lab: the Acceptance and mutations are unit tests against injected requests. The live run is a11ign#4937 (`lane:orchestrator`).
