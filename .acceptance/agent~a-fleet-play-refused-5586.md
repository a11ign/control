Row a11ign/a11ign#5586. A fleet play refused for a failed hold read now names the child's first stderr line, not Node's footer. Region is `src/fleet-playbook.ts` and `src/fleet-playbook.test.ts` only. No `fleet:*`, `lab:*`, `training:capture*`, `worker:*` or `gate:stability` command was run (resource ban); the reader is driven through `readGateSnapshot`'s injected child runner, so the five controls run no real `agent-org`.

Acceptance: `cd ~/repos/control && node --test src/fleet-playbook.test.ts` (run as `node --test src/fleet-playbook.test.ts` in the worktree, which is the same file; the primary checkout has no change until merge)

**As run (measured, 2026-10-16, worktree `~/repos/control-wt-5586`, commit 8be9ebc):** `ℹ tests 154 / ℹ pass 154 / ℹ fail 0` (exit 0). The five `#5586` controls alone (`--test-name-pattern='#5586'`): `ℹ tests 5 / ℹ pass 5 / ℹ fail 0`. `pnpm run typecheck` exit 0.

**Fails before the fix, measured:** main's reader with only the export and run parameter added (the first-line change not yet made; main itself has no export for the test to import), controls (a), (b) and (d) failed, each refusal still ending in `(Node.js v24.21.0)`. (c) and (e) passed, as they must: a success read and an unparseable exit-0 read are unchanged.

**Mutation (measured):** the first-line selection changed to the last non-empty line by `sed`; controls (a) and (d) fail, the other three pass. Restored from a scratchpad copy and checked byte-identical with `diff`.

## What changed

- `readGateSnapshot` takes its child runner as a parameter (default `execFileSync`). A failed child is rethrown as `agent-org gate-snapshot-read exited N: "<first non-empty stderr line>"` (cut at 200 characters with `... (cut)`), `cause` kept. With no stderr: `… exited N and printed nothing on stderr`; a spawn failure with no status: `… failed: <first message line>`. Unparseable stdout is still a plain `JSON.parse` throw, unchanged.
- The refusal keeps its words and still refuses. `fleetHoldReadRefusal` (gh's path) is not touched.
- Not changed, per the row: `AGENT_ORG_HOST` is not defaulted inside the control.

Closes a11ign/a11ign#5586
