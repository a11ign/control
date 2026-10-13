Row a11ign/a11ign#5445. Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'set -e; C=/home/agent/repos/wt-5445-control; K=/home/agent/repos/wt-5445; mkdir -p "$K/packages/control"; cp -R "$C/src" "$C/ansible" "$C/layers.json" "$C/deploy-pins.json" "$C/pnpm-lock.yaml" "$C/CLAUDE.md" "$C/README.md" "$K/packages/control/"; jq "del(.version, .scripts, .devDependencies, .packageManager, .engines)" "$C/package.json" > "$K/packages/control/package.json"; for l in worker-fleet nvda-worker lab; do [ -e "$K/packages/$l" ] || rsync -a --exclude node_modules "/home/agent/repos/a11y-witness/packages/$l/" "$K/packages/$l/"; done; cd "$K"; pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include packages/control/src/layer-checkouts.test.ts --include packages/control/src/layer-control-lab.test.ts --include packages/control/src/layer-guests.test.ts --include packages/control/src/fleet-playbook.test.ts --include packages/control/src/lab-pipeline.test.ts'
```

**As run (measured, 2026-10-13):** `VERDICT pass: 217 tests in 5 files (1 skipped)`, of which 4 are the new `#5445` tests; the skip is the existing `noFirstCopy()` one in `layer-checkouts.test.ts`. The row's command as written (`pnpm exec node --test src/layer-checkouts.test.ts`) fails at import in a standalone control checkout: `Package subpath './lib/git-sandbox' is not defined by "exports"` in `@a11ign/toolchain` 0.1.7. The test imports a helper only the core's toolchain exports, so control's tests run laid under a core checkout, which is what `ci.yml`'s `checks` job does and what the command above reproduces. The layers are COPIED, not symlinked: a symlink makes `layerSourceDir("nvda-worker")` resolve to the symlink's target and fails that one pre-existing test, an artefact of the lay and not of the change.

## Mutation (`cp` the file aside, edit, run, `cp` back, `diff` identical)

- The published branch never fires (`const last = refusal;`, which is `origin/main`'s behaviour): `3` fail: the real declaration's command holds the refusal, a plane with the release installed is refused, and the wrong-version test sees the wrong message.
- The installed judgement always accepts (`true || { echo ... }`): `1` fails, the wrong-version and not-installed test, and no other.
- The release pattern check removed (`if (false)`): `1` fails, the malformed-release test, and no other.
- Positive control for the refusal that stays: the existing "POSITIVE CONTROL: a layer path with neither a .git nor a .layer-ref" test uses a manifest declaring no release and still refuses with the old text.

## What changed

- `src/layer-checkouts.ts`: `layerMoveShell`'s last branch is the installed release's judgement (`installedJudgement`) for a layer declaring `package` and `version`, and the old refusal for one that declares none. `publishedOf` holds the release to `@a11ign/<name>` and an exact `x.y.z` before either goes inside shell text.
- `src/layer-checkouts.test.ts`: four tests: the real declaration's sync command holds no half-laid refusal (Done-when 1), a plane with no `packages/` and the release installed passes, a wrong or absent release refuses naming the layer, and a malformed release is refused before a command is built. The shell is run against a stand-in plane directory.
- `.changeset/plane-sync-judges-published-layers-5445.md` (patch).

## Not done here

- **No fleet command was run** (the resource ban), so Done-when 2 (`fleet:provision -- --serial=0` getting past the plane sync) is `orchestrator`'s to read. The shell was run only against a stand-in directory: whether the plane's `node_modules/@a11ign/*` holds the declared releases is its own state, and the refusal names `pnpm install --frozen-lockfile` when it does not.
- **`layers.json` is NOT deleted**, and the row's item 2 deletes it only if nothing else reads it. The playbooks' own layer tasks still read it: `ansible/roles/worker/defaults/main.yml`, `ansible/tasks/read-layer-checkouts.yml`, `ansible/tasks/layer-checkouts.yml`, `ansible/tasks/lab-layer-checkouts.yml`, `ansible/tasks/lab-layer-reset.yml`. No file of `src/` reads it (`README.md` says so). Moving those readers to `deploy-pins.json` is a separate row.
- `src/control-plane-fleet.ts` is in the row's Region and is unchanged: it does not call `layerCheckoutMove`. The callers are `fleet-playbook.ts` (`controlPlaneCheckout`) and `lab-pipeline.ts`, which the fix reaches through `layerMoveShell` without an edit.
