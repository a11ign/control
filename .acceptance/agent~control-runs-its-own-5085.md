Row a11ign/a11ign#5085 (ADR 0045 cut 7 of 9, control side; epic #4425). Names no workflow, so it is not `lane:ceo`. **Nothing deploys from this change:** it is a pull request to control and no host moves.

Acceptance:

```bash
cd /home/agent/repos/wt-5085-control && pnpm exec rstest run src/layer-pins.test.ts && test "$(git grep -l layers.json -- src | wc -l)" = 0
```

**As run (measured, 2026-10-11, at this head):** `src/layer-pins.test.ts` 18 tests pass with rstest's own API and no config, and the grep counts `0` (it was `17` at control `3c059fd`). The row's own form is `cd /home/agent/repos/control && ...`, the primary checkout, which holds `main` until this merges; the worktree form is the same files. Also green: `pnpm test` here (40 tests in 7 files, including the new `scripts/control-commands.test.ts`), `pnpm run typecheck`, and, laid over a core checkout as `ci.yml` lays it (core `70361744f`, fleet v0.9.0, worker v0.13.0, lab v0.1.28): `tsc --noEmit -p tsconfig.control.json` clean, eslint 0 errors, and the whole `packages/control` suite at 1421 tests with 12 failures, **the same 12 that control `origin/main` fails in that layout** (measured by running both; they are fleet/judge build artefacts of the hand-laid tree, and `layer-launchers.test.ts` expecting `capture-check.mjs`).

## Which path a host takes

- **A host that does not have `deploy-pins.json`** (the control plane and the lab today: they run the control laid at the core's pin `v0.5.3`, which this change does not touch) takes the OLD path unchanged: that laid copy reads its own copy of the core's list, and the playbooks keep reading a list of their own (`ansible/tasks/read-layer-checkouts.yml`, which is why `layers.json` stays in this repository for them). This change moves no host.
- **A checkout that has `deploy-pins.json`** (control's own checkout, from this merge) takes the NEW path on `fleet:deploy` / `fleet:provision` with no `--layer-ref`: `npm pack` each pinned release, compare the tarball's sha512 with `integrity`, refuse by layer name BEFORE the control plane is touched, put each guest's checkout on the commit the release's tag names (`a11y_layer_commits`, the playbooks' existing input). With `--layer-ref` for every layer it takes the typed commits, as before.
- **Nothing deploys until a VERIFY row** (`orchestrator`, Fleet: Yes) runs `fleet:deploy --limit=<one box>` with the pins, and reads it back.

## What changed

- `deploy-pins.json` (new): `@a11ign/screenreader-worker 0.13.0` and `@a11ign/screenreader-fleet 0.9.0` with their integrities (the values `npm view` prints and the core's lockfile holds), where a host holds each, and the lab at `v0.1.28`.
- `src/layer-pins.ts` (new): the reader, `stagePublished` (fetch, compare, THEN unpack, as `node_modules/@a11ign/<name>` so the fleet's bare-name imports of the worker resolve with nothing installed), `resolvePublished` (adds the commits), `releaseTag`/`commitOfTag` moved here.
- The 17 readers: the pins file instead of a copy of another repository's list, the lockfile at the sha and the core's manifest at `origin/main`. `laidControl`, `pinnedLayerTag`, `layerPinTag`, `CONTROL_LAYER` are deleted.
- `fleet-playbook.ts`: the published path above, and `readLocalProtocol` reads `dist/protocol-version.mjs` from the unpacked worker. `with-control-plane-fleet.ts`: `doctor` and `worker-code` run the fleet's bins by name from the verified pair.
- `package.json`: the 31 commands, `dependencies: {}`.

## Not established, and outside this row's Region

- **No command was RUN** (the resource ban). `scripts/control-commands.test.ts` shows each of the 31 names a file this repository holds; it cannot show `lab:job` working from this root.
- **From control's own root, `lab:job`, `lab:pipeline` and `lab:watch` will not find their playbooks:** `lab-job.ts`, `lab-pipeline.ts` and `lab-watch.ts` take `../../../` as the core's root and name `packages/control/ansible/...`. **Fourteen modules still import the fleet's SOURCE by relative path** (`../../worker-fleet/src/...`; measured with `git grep -l`), `with-control-plane-fleet.ts` and `fleet-auto-off.ts` among them, and `post-qualification-status.ts` the lab's. `with-control-plane-fleet.ts` keeps its static import of `worker-http.ts`: it also reaches `fleet-status.ts` and `control-plane-fleet.ts`, which import the fleet's source too, so removing that one line alone would leave the module unable to load without the fleet laid, and a mechanism for all fourteen is one row. Twelve of the fourteen are not in the Region. They are the row after this one (reported on the row).
- `fleet-auto-off.ts` and `layer-checkouts.ts` keep their `../../../` geometry, so from control's own root they refuse (fail closed) rather than judge. Same row.
- The lab tag is now a SECOND declaration of what the core lays: a core that moves its lab pin leaves `lab-laid-copy.ts` refusing every lab job, naming both tags, until `deploy-pins.json` moves too.
- A qualified run pins the layers and the lab to control's declaration, no longer to the sha's own lockfile and manifest; that is a change in what `--qualify-sha` means.

## Mutation

`integrityRefusal`'s compare, in `src/layer-pins.ts`, mutated both ways and restored from a `cp` backup (`diff` identical each time):

- **Compare skipped** (`if (true) return null`): four tests fail, all negative (`NEGATIVE CONTROL: a tarball whose integrity differs…`, `every layer that does not match is named…`, `integrityRefusal compares the whole digest…`, `a pin that does not verify asks git nothing…`); the POSITIVE CONTROL stays green.
- **Compare always refuses** (`if (false) return null`): six tests fail, the positive ones (`POSITIVE CONTROL…`, the unpack, the bare-name import, `a verified pair answers…`) and the ones that compare a good digest.
- **Unpack even when a layer refused** (the `refusals.length > 0` return removed): four tests fail, naming the nothing-unpacked and the collected-refusal cases.

The REAL pins were also verified live (hand, not a test): `resolvePublished` over `deploy-pins.json` unpacked both releases and resolved `nvda-worker` to `2876d9070f3c…` and `screenreader-fleet` to `7d02bf7793db…`; the fleet's three bare imports of the worker resolve from the unpacked pair; and the worker's digest placed on the fleet is refused naming `screenreader-fleet`, both digests and "Nothing was unpacked or shipped".

Closes a11ign/a11ign#5085
