The control plane's follow-main step runs `scripts/lay-layer.ts` under the `tsx` loader, so a layer-pin move is followed in one tick again (a11ign/a11ign#4571). Did NOT run the control test job on the engineer host (the test imports into the laid core); the evidence below is from a scratch core, and **the PR's own CI is expected red until `CORE_REF` moves, see "Known gap"**.

Acceptance:

```bash
cd /home/agent/repos/wt-4571-control && bash -c '! grep -n "lay-layer\.mjs" ansible/files/a11y-fleet-auto-off.service' && bash -c 'test "$(grep -c "scripts/lay-layer\.ts" ansible/files/a11y-fleet-auto-off.service)" -ge 2' && bash -c 'grep -q "lay-layer\.ts" src/fleet-auto-off.test.ts'
```

Closes a11ign/a11ign#4571

## What changed

- `ansible/files/a11y-fleet-auto-off.service`: both `ExecStartPre` lay lines are `node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs scripts/lay-layer.ts <layer>` (the loader `ExecStart` names); steps 4 and 5 of the header say `lay-layer.ts`, and a paragraph says why (the `-` hid `Cannot find module` on every firing). `-` and `WorkingDirectory` untouched.
- `src/fleet-auto-off.test.ts`: the recorder test expects the new argv (`LOADER_ARGS`, one constant). New test `#4571`: `scriptsRun` lists every core-relative script path the `ExecStart`/`ExecStartPre` lines run, and each must exist in the core the package is laid into.
- `.changeset/follow-main-runs-lay-layer-ts.md` (patch).

## Measured, 2026-10-09 (scratch core: a11ign `50adf137b` = `CORE_REF`, this package laid over `packages/control`, `screenreader-fleet` laid, `node --test src/fleet-auto-off.test.ts`)

| case | result |
|---|---|
| new unit, core holding `scripts/lay-layer.ts` (copied beside `.mjs` to simulate a post-#4268 core) | 117 pass, 0 fail |
| **old unit (`origin/main`'s, `.mjs` lines), same core** | 2 fail: the `#3852` recorder test and `#4571`, whose positive control prints `found ["packages/control/src/fleet-auto-off.ts","scripts/lay-layer.mjs","scripts/lay-layer.mjs"]` |
| new unit, core at `CORE_REF` as is (only `lay-layer.mjs`) | `#4571` fails: `a script the unit runs that the laid core does not hold` |
| mutation: `absentFrom` never reports | `#4571` red, nothing else |
| mutation: `absentFrom` always reports | `#4571` red, nothing else |

The test also carries its own positive control: against a temp core holding exactly what the shipped unit names, the scan says nothing; on the unit with `.ts` rewritten to `.mjs` it names `scripts/lay-layer.mjs`. Mutated files restored with `cp`, `cmp` clean. Not run: lint and `tsc` (no toolchain on this host for a laid tree), `fleet:*`, anything live.

## Known gap: this PR's CI cannot be green as the Region stands

`ci.yml` lays the package over a11ign at `CORE_REF` (`50adf137b`, 2026-10-07), which predates a11ign#4268: it holds `scripts/lay-layer.mjs` and no `.ts`. The new test, correctly, says that core lacks `lay-layer.ts`. Making it green means bumping `CORE_REF` and then repointing the two tests that still import the `.mjs` (`fleet-auto-off.test.ts:26`, `layer-checkouts.test.ts:351`), neither of which is in this row's Region. I have asked `product-manager` to amend the Region or file the `CORE_REF` row; I did not weaken the test to pass on the old core.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
