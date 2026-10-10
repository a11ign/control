Part of a11ign/a11ign#4708 (parent #4405). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
cd /home/agent/repos/wt-4708 && pnpm exec rstest run --config packages/control/scripts/rstest/rstest.config.ts --include 'src/fleet-playbook.test.ts' --include 'src/fleet-layer/protocol-guard.test.ts'
```

**As run (measured, 2026-10-10):** `VERDICT pass: 129 tests in 2 files`, in a core worktree with this tree overlaid on the laid `packages/control` (and `packages/worker-fleet`, `node_modules` linked, both `git add -f`ed so the discovery tests' `git ls-files` walk sees them; reset afterwards). The row's own `cd /home/agent/repos/control && pnpm exec rstest run src/...` cannot run: that clone has no sibling `worker-fleet`/`guards`, and without `--config` rstest prints `No test suites found` (no `node:test` shim), as #28 and #4445 recorded.

## What changed

- `src/fleet-playbook.ts`: `PROTOCOL_VERSION_FILE` is `protocol-version.ts`; `PROTOCOL_VERSION_FILES` lists it then the older `protocol-version.mjs`, and `readLocalProtocol` reads the first that exists (ENOENT on the last is the refusal; any other error rethrows). The refusal names both files.
- `src/fleet-playbook.test.ts`: the clone test asks for `.ts`; new #4708 test: a clone with only `.ts` reads, only `.mjs` reads, neither is refused with the existing message.
- `src/fleet-layer/protocol-guard.test.ts`: the HEAD-comparison regex accepts `.ts` or `.mjs`; comments moved. The layer (`src`, `ansible`) names the old file nowhere else (grep, laid v0.7.2 fleet and control v0.3.0).

## Mutations (`cp` before, `cp` after, `diff` identical)

- list reduced to `.mjs` only: the `.ts` positive control fails (2 tests: the #3761 read and the #4708 one).
- list reduced to `.ts` only: the `.mjs` fallback control fails (1 test, #4708's).

## Not done here

- The live `fleet:deploy` past the guard is #4449's (fleet ban). The release is cut after merge; the control tag is named on the row then.

Closes: none -- a11ign/a11ign#4708 cannot be closed from this repository; `product-manager` closes it at merge.
