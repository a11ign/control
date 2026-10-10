Row a11ign/a11ign#4863 (found on a11ign/a11ign#4860 and #4862). A `--qualify-sha` run on a sha whose lab pin is older than the playbook died a second after it started with `ERR_MODULE_NOT_FOUND` (lab v0.1.24 holds `scripts/stability-gate.mjs` only; `ansible/lab-job.yml` runs `packages/lab/scripts/stability-gate.ts`), the poster wrote `failure` twice, and the release raised a regression. The launch is now refused before `pending`, so nothing is posted.

Host-install: `src/qualification-run.ts` -- the control host's laid copy (`/root/a11y-witness/packages/control/src/qualification-run.ts`) still has no lab-pin check, so a skewed sha keeps posting two `failure`s from there until the file is laid. Putting it there is a host-run lay and is `orchestrator`'s, never this claimant's.

Closes: none -- a11ign/a11ign#4863 cannot be closed from this repository; `product-manager` closes it at merge.

platform: git, which `qualification-run.ts` already runs for `show` and `ls-remote`; a shallow `fetch` of the tag and an `ls-tree` need no second tool and no token, where the contents API needs `gh` and a credential on the control host.

Acceptance:

```bash
cd /home/agent/repos/wt-4863-control && bash -c 'L=$(mktemp -d) && mkdir -p "${L:?}/packages/control" && ln -s /home/agent/repos/a11y-witness/packages/worker-fleet /home/agent/repos/a11y-witness/packages/lab "${L:?}/packages/" && cp -R src ansible layers.json "${L:?}/packages/control/" && (cd "${L:?}/packages/control" && node --test src/qualification-pin-skew.test.ts); rc=$?; rm -rf "${L:?}"; exit $rc'
```

**As run (measured, 2026-10-10):** `tests 10, pass 10, fail 0`, at this branch's head. **The row's own command cannot run, and the reason is not this change:** `cd /home/agent/repos/control && npx rstest run src/qualification-pin-skew.test.ts` prints `npm ERR! code ENOVERSIONS` (the runner is `@rstest/core`, and `npx rstest` asks the registry for a package of that name), and that clone is 114 commits behind `main` in the pre-flat `packages/` layout, with no `src/`. The test also cannot run in a bare worktree of this repository: `qualification-run.ts` imports `../../worker-fleet/src/git-safe-env.ts` and the poster imports the lab's `gates/qualification-status.ts`, which `ci.yml` lays beside this package. The command above lays the same two siblings (the host's `packages/worker-fleet` and `packages/lab`, lab v0.1.28) in a temp directory and runs the test there with node's own runner, as `fleet-watch`'s acceptance does. CI's `checks` job runs it under the toolchain's rstest config over the core at `CORE_REF`, and is the verdict for the whole suite.

## What changed

- `src/qualification-run.ts`: `qualifiedPinsFor` is the `LayerRefsAt` the real entry now uses. It runs `layerRefsFor` unchanged, and only if that passes asks the sha's own `layers.json` (`git show <sha>:layers.json`) for `pinned.lab`, resolves its tag on the declared remote with the existing `commitOfTag`, fetches that tag one commit deep (writes only to `.git`, as the existing sha fetch does) and `ls-tree`s the scripts `playbookLabScripts` read out of the `gate-stability` block's `argv` of THIS copy's `lab-job.yml`. A script the tag lacks refuses with the sha, the lab tag, the remote, the missing path and the sentence that an older promotion row is superseded by the next release sha, not re-run. **The refusal rides the existing seam** (`Poster.layerRefs`, read by `run()` before `pending`), so `lab-job.ts` and `lab-job.test.ts` are untouched and every refusal posts nothing. `lockfileAt` became `fileAt` (one fetch-and-show for both files, same message for the lockfile).
- **The row says `withLayerRefs` "already reads the sha's `layers.json`"; it does not.** It reads the sha's `pnpm-lock.yaml`, and `layers.json` is read from the checkout by `separateLayers()`. The sha's own `layers.json` is read here for the first time, which is the right one: the lab is not a lockfile layer, `pinned.lab` is where the sha says which tag it lays.
- **What counts as the script the playbook runs** is the entries of the job's `argv` under `packages/lab/` (the runner `{{ lab_tsx }}` and `--local` are not the lab's). It is read, not named, so there is no third copy of the path to keep in step; a job block or `argv` it cannot find, or one naming no lab script, is a refusal and never an empty list (an empty list would pass every sha and be a check that never runs).
- Where the script is looked for in the tag is the sha's declared `source` (`.` at lab v0.1.13+, absent at v0.1.12 where it sat at `packages/lab`), not where it is laid.
- A sha that declares no `pinned.lab`, or a remote that is not an https URL or an absolute path, is a refusal that says so, and asks nothing of the remote (a sha cannot name `ext::` or a leading `-` to `git fetch`).
- `.changeset/qualify-refuses-an-outgrown-lab-pin-4863.md` (patch); `src/qualification-pin-skew.test.ts`: ten tests.

## Evidence (all run here: no fleet, no lab job, no worker; `git ls-remote`/`fetch` of `https://github.com/a11ign/lab.git` read-only)

- **Done-when 2: the real entry point, dispatch stubbed, on `7c87a6a94c91191857e39e2d21e28915b177ee34`** (the shipped `run()` from `lab-job.ts`, the shipped `qualifiedPinsFor`, git bound to a checkout holding that sha, poster and dispatch recorders that throw or record if reached). Printed, with `EXIT 3` and `events: []` meaning no `post` and no `dispatch`:

  ```
  REFUSING --qualify-sha=: 7c87a6a94c91 pins the lab at v0.1.24 (https://github.com/a11ign/lab.git), which holds no scripts/stability-gate.ts, and this copy of lab-job.yml runs gate-stability from packages/lab/scripts/stability-gate.ts: the job would die a second after it started with ERR_MODULE_NOT_FOUND, reach no worker, and the poster would write `failure` twice, which the release reads as a regression. Nothing was posted or dispatched, and this is not a regression: a lab pin older than the playbook is superseded by the next release sha, which pins a lab that holds the script, and an older promotion row is not re-run.
  EXIT 3
  events: []
  ```

- **The real negative control:** the same function on `36c354839` (a11ign/a11ign `main` at the time, `layers.json` pins lab `v0.1.28`) returns `{"layer_refs":{"nvda-worker":"dc8f506c...","screenreader-fleet":"c355b8ed..."}}`, no refusal.
- **Red before:** `qualification-pin-skew.test.ts` does not exist at `origin/main`, and without the change `qualifiedPinsFor` is not exported, so the file fails to load.
- **Neighbouring suites in the same laid tree, unchanged by this diff:** `qualification-layer-refs.test.ts` 12/12, `lab-job.test.ts` 80/80, `control-has-no-dependencies.test.ts` 3/3, `control-runs-under-tsx.test.ts` 5/5, `layer-checkouts.test.ts` 33/33, `layer-control-lab.test.ts` 3/3, `lab-catalogue-is-found-by-name.test.ts` 3/3. `eslint --no-ignore` on the two files: 0 problems; `tsc --noEmit -p tsconfig.control.json` (as `ci.yml` runs it, over the laid tree): 0 errors.
- **Not run:** this repository's own `pnpm test` (no `node_modules` in the worktree, and the diff touches none of `scripts/`), and the rest of `src/` (about seventy files; the six above are the ones that read the same modules). The `checks` job is the verdict for both.

## Mutation (on copies of the file in a scratch laid tree; the branch's file was never edited for it, and each copy was restored from a saved byte-identical original)

- **The check never fires** (`qualifiedPinsFor` returns the layers' answer whatever the lab says): 6 fail, naming the positive control, both layout cases, the `.bak` case, the unreadable/absent-tag case and the `run()` one. The negative control stays green.
- **The check always fires** (the `missing.length === 0` exit removed): the negative control and the layout case that expects a pass fail, and no other.
- **The lab asked before the layers** (the order swapped): only `the layers are read first ...` fails.
- The unmutated file passes all ten.

## Not done here

- The release's own read of two `failure`s as a regression is not changed: a refused launch posts nothing, so the release reads it as no status, which is the existing, correct wait. Whether the release should ALSO notice a promotion row older than the playbook is a question for its owner.
- The Region of the row names no change to the `LayerRefsAt` type's name or to `lab-job.ts`; `withLayerRefs` is as it was.
