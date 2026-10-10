Part of a11ign/a11ign#4714. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-4714 && pnpm exec rstest run --config packages/control/scripts/rstest/rstest.config.ts --include 'src/fleet-watch.test.ts'
```

**As run (measured, 2026-10-10):** `VERDICT pass: 54 tests in 1 file`, in a core worktree with this tree copied to `packages/control` beside `packages/worker-fleet` and `node_modules` hybrid-linked (an untracked overlay, never committed; the core's checkout gets reset afterwards). The row's own `cd /home/agent/repos/control && pnpm exec rstest run src/fleet-watch.test.ts` cannot run: that clone is 97 commits behind `main` and does not hold this branch, its `node_modules` predates `rstest` (`Command "rstest" not found`), and without `--config` rstest finds no `node:test` suites (#4708's PR recorded the same). `node --test src/fleet-watch.test.ts` over this tree also printed `tests 54, pass 54, fail 0` (45 before this change, 9 added).

`tsc --noEmit` reports nothing in `src/fleet-watch.ts`, `src/fleet-watch.test.ts` or `src/control-unit-drift.ts`; its only errors are the `@a11ign/toolchain/*` imports under `scripts/`, which this checkout's stale `node_modules` cannot resolve.

## What changed

- `src/fleet-watch.ts`: `watchFleet` takes an optional `unitDrift` reader (`controlUnitDrift` over `readControlHost` and the checkout's playbooks, from `main`). `unitDriftTick` turns a reading into `unit-drift: <unit> <kind>` lines for `differs` and `missing-on-host`, the `not-shipped` units it only reports, and a `CANNOT_TELL` reason. The lines ride the off-fleet ledger (posted once, cleared on re-install, carried through an unread host, as the patch line is) and come back as `unitDrift.fresh`, with their own comment body. `exitCodeFor` is the tick's exit: ATTENTION for anything new, else QUIET unless the host was unread, which is `CANNOT_ASK` and never QUIET.
- `src/control-unit-drift.ts`: exports `Finding`, `Reading` and `ATTENTION_KINDS` (`differs`, `missing-on-host`). The module's own CLI is unchanged.
- `src/fleet-watch.test.ts`: nine tests, each with its positive and negative control: differs is ATTENTION and names the unit while the shipped text is QUIET; missing-on-host; `not-shipped` alone is reported and never raised (and is not a line beside a real finding); an unread host, an empty answer and a throwing reader are `CANNOT_TELL`; the exit code table; once-only, carried-through-unread, cleared-on-reinstall and relapse over the real ledger; no reader means nothing claimed and the lines stand; the body.
- `.changeset/fleet-watch-reads-control-unit-drift.md`.

## Mutations (`cp` before, `cp` after, `diff` identical)

- `not-shipped` added to `ATTENTION_KINDS`: the `not-shipped` test fails (1 test, and no other).
- `ATTENTION_KINDS` emptied (never fires): the five tests that expect a line fail; the exit-code and unread-host tests do not.
- an unread host not carried (`carry: false`): the once-only/carry test fails (1 test).
- an unread host exits QUIET: the exit-code test fails (1 test).
- an unread host outranking ATTENTION: the same exit-code test fails on its last assertion (1 test).

## Not done here

- The live reading on the agents host, the release and the `docs/gate-exit-codes.md` line that calls the reading hand-run are the VERIFY row's (#4730); the line is true only once the tick on the host carries the release.
- `readRefusalOrSay` still reads an unreadable control host as "no refusal", so a tick whose only trouble is that read exits QUIET. That is the same shape this row closes for units, one reader over; not changed here.

Closes: none -- a11ign/a11ign#4714 cannot be closed from this repository; `product-manager` closes it at merge.
