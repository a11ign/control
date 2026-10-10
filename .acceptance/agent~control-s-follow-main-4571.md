Closes: none -- a11ign/a11ign#4571 is closed by `product-manager` at merge; a PR here cannot close a row there. Region: `src/fleet-auto-off.test.ts`, `.changeset/follow-main-runs-lay-layer-ts.md`.

Acceptance:

```bash
cd /home/agent/repos/wt-4571-control && bash -c '! grep -n "lay-layer\.mjs" ansible/files/a11y-fleet-auto-off.service' && bash -c 'test "$(grep -c "scripts/lay-layer\.ts" ansible/files/a11y-fleet-auto-off.service)" -ge 2' && bash -c 'grep -q "lay-layer\.ts" src/fleet-auto-off.test.ts' && bash -c 'test -f .changeset/follow-main-runs-lay-layer-ts.md'
```

All four pass at this head (the first prints nothing and exits 1 from `grep`, so its `!` passes).

**As run (2026-10-10):** control's `test` job was NOT run on the engineer host (the test imports into the laid core). The evidence below is from a scratch core at `CORE_REF` (`83b46f522`: `pnpm install --frozen-lockfile`, this package laid over `packages/control`, `rstest run --config scripts/rstest/rstest.config.ts`).

## What is already on `main`, and what this adds

`main` (`ac52c5d`, the merge of control#34) already holds Change 1 and Change 2 of the row: the unit's lay lines read `node scripts/lay-layer.ts <layer>` (no loader: host `node` v24 strips types, and a11ign#4596 is removing the loaders) and `src/fleet-auto-off.test.ts` records `node scripts/lay-layer.ts <layer>: <head>`. This PR is Change 3 and Change 4:

- `src/fleet-auto-off.test.ts`: `scriptsRun` lists every core-relative script path the `ExecStart`/`ExecStartPre` lines run (absolute under `/root/a11y-witness/`, and bare ones from `WorkingDirectory=`; an absolute path elsewhere, the `/opt` loader, is the host's). New test `#4571` requires each to exist in the core the package is laid into.
- `.changeset/follow-main-runs-lay-layer-ts.md` (patch).

## Measured (scratch core at `CORE_REF`)

| case | result |
|---|---|
| `src/fleet-auto-off.test.ts`, this head | 117 pass, 0 fail |
| **unit with `lay-layer.ts` rewritten to `.mjs` (the old line), same core** | 2 fail: the `#3852` recorder test (expected: it pins the `.ts` argv) and `#4571`: `a script the unit runs that the laid core does not hold` naming `scripts/lay-layer.mjs` |
| mutation: scan returns nothing | `#4571` red on its positive control (`found []`), nothing else |
| mutation: `absentFrom` always reports | `#4571` red, nothing else |
| mutation: `absentFrom` never reports | `#4571` red (the synthetic-core `.mjs` direction), nothing else |
| eslint `--no-ignore packages/control/src/fleet-auto-off.test.ts` | 0 errors (warnings are the file's existing `no-magic-numbers`) |
| `tsc --noEmit -p tsconfig.control.json` | no output |
| whole control suite | 1186 of 1188 pass; the 2 failures are `fleet-layer/entry-points.test.ts`, which fail identically with `origin/main`'s version of this test file in the scratch (it reads the core's `git ls-files`, and the scratch's index holds only `packages/control`), so they are the scratch's and not this change's |

Mutated files were restored with `cp`, and `diff` against the saved copy was clean. Not run: any `fleet:*` or `lab:*` command.

## Not this row

Moving a11ign's `layers.json` pin for `control` to the tag this releases, and re-rendering the unit on the control plane, are separate rows (`orchestrator`'s).
