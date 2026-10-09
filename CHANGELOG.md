# control-workspace

## 0.1.15

### Patch Changes

- 5c9aa1d: Control's rstest config and `control-unit-drift` are TypeScript (a11ign/a11ign#4268, the pilot of ADR 0043's conversion): converted by `@a11ign/toolchain`'s `js-to-ts` script, the one residue (three `@typedef`s) fixed by hand, and the `.mjs` baseline lowered from 23 to 21. The other twenty-one `.mjs` stay: each is named by a deployed unit, an Ansible task or a core `package.json` script, or is imported by one, and the host's Node has no type stripping, so a `.mjs` importing a `.ts` would not start.

## 0.1.14

### Patch Changes

- eee448f: The package is the repository's root (a11ign/a11ign#4217): `src/`, `ansible/`, `layers.json` and `CLAUDE.md` moved up from `packages/control/`, the private `control-workspace` shell and `pnpm-workspace.yaml` are gone, the root manifest is `@a11ign/control`, and the two READMEs are one. `@a11ign/toolchain` is bumped to ^0.1.5, the release that carries `layout-check`, and `ci.yml` runs it in the job `gate` waits for. Nothing the control plane runs moves: every `packages/control/...` the code names is the path the package is LAID at in the core's checkout (`/root/a11y-witness/packages/control`), and the next row changes how the core lays it. This is the first tag cut from the flat layout.
- 8269e08: `lab:fetch` can return `calibration-judgments` (`runs/abstention/calibration-judgments.json`), the calibration sweep's per-page findings with their quoted evidence (a11ign/a11ign#4293, #4241).

## 0.1.13

### Patch Changes

- 389c657: Control counts its `.js`/`.mjs`/`.cjs` source against a committed baseline (a11ign/a11ign #4265, the adoption half of #4243). `@a11ign/toolchain` is bumped to ^0.1.4, the release that carries `./mjs-ratchet`, and `scripts/mjs-ratchet.test.ts` calls `checkMjsRatchet` against `mjs-ratchet.baseline.json` at the repository root: 23 files today (22 under `packages/control/src/`, plus `scripts/rstest/rstest.config.mjs`), no exceptions. A new `.mjs` fails and is named; a drop passes and says the baseline can be lowered. No workflow file is edited: the test is under `scripts/`, which `pnpm test` already runs (it cannot live under `packages/control/`: CI resolves the core's older toolchain pin there).

## 0.1.12

### Patch Changes

- b550b9c: A guest's layer move accepts a pin that is only a tag (a11ign/a11ign #4158, #4107's chain). `layer-checkouts.yml` fetched heads, checked out `main` and ran `merge --ff-only <pin>`, so a release commit that no branch holds (`screenreader-worker` `v0.4.0`, `@a11ign/screenreader-fleet@0.5.1`) was "not something we can merge", while the control plane's check (#4150) refuses `main`'s tip in its place. The task now fetches tags (`git fetch --quiet --tags origin`) and checks the pin out detached (`checkout --detach <pin>`), as the core's and the lab's moves do. The dirt report and discard and the assertion that HEAD equals the pin are unchanged.

## 0.1.11

### Patch Changes

- 36aa51b: `fleet:deploy --layer-ref` reaches the playbook on a control plane that holds a layer laid rather than cloned, and can pin a release whose commit is only a tag (a11ign/a11ign #4150, #4107's chain). A LAID layer (`.layer-ref` beside `src/`, no `.git`) is accepted when the commit its tag names on the layer's remote is the pin, and refused, naming the layer, the `.layer-ref` and the pin, when it is not; a path with neither shape still refuses. A CLONED layer's move now fetches tags (`git fetch --quiet --tags origin`), so a version commit that no branch holds is a commit the control plane has. The refusal no longer sends the operator to `bootstrap-control-plane.sh`, and the comment that said nothing lays on the control plane is corrected.

## 0.1.10

### Patch Changes

- 8d07c65: `lab:job --qualify-sha` refuses a `gate-stability` launch with no `-e worker=<n>` BEFORE `pending` is posted, so a launch the playbook would refuse leaves no `qualification` status on the sha (a stray `failure` stays counted by the release's regression read, #3988).

## 0.1.9

### Patch Changes

- 97f9906: control releases through `a11ign/toolchain`'s shared per-merge workflow (`kind: tag`), and the version and `CHANGELOG.md` now live at the repository root (`control-workspace`), which is the one private package that workflow tags. The tag is still `v<version>`, numbered on from `v0.1.8`; nothing a consumer lays (`src`, `ansible`, `CLAUDE.md`, `README.md`) changes. Row: a11ign/a11ign#3960.

## 0.1.8

### Patch Changes

- dbdddbc: The control plane's follow-main step (`a11y-fleet-auto-off.service`) lays `control` after it lays `screenreader-fleet`, so a move of `pinned.control.tag` in `layers.json` is followed in one tick and fleet auto-off no longer refuses `stale-checkout` until somebody lays it by hand (#3976).

## 0.1.7

### Patch Changes

- 85b3e96: The gate heartbeat reads the chairman's file in the shape it really has. `telegram-chairman` is `{"chatId":<n>,"userId":<n>,"pairedAt":"<iso>"}`, not a bare number, and the first install sent that whole object as `chat_id`: the unit saw the outage (`stale (last tick 10 min old)`) and Telegram answered HTTP 400, so nothing reached the chairman. A bare number still reads; JSON with no numeric `chatId` is `no route`, naming the file. Row: a11ign/a11ign#3851.

## 0.1.6

### Patch Changes

- ca90bf1: `CLAUDE.md` documents `pnpm run lab:status -e job=…` and `pnpm run lab:stop -e job=…` without the `--`: pnpm 10 forwards a literal `--` to `ansible-playbook`, which reads it as the end of its options (`the playbook: -e could not be found`). Row: a11ign/a11ign#3924.

## 0.1.5

### Patch Changes

- f80468c: `lab:job --qualify-sha` supplies `layer_refs` itself (a11ign/a11ign #3920): each layer with its own repository is pinned at the commit its tag names on its remote, the tag being the one the sha's own `pnpm-lock.yaml` pins, and a tag the remote lacks is a refusal naming the layer, the tag and the remote before anything is posted. And `lab-layer-checkouts.yml` no longer refuses, before the install that lays it, a layer the pull has just removed.

## 0.1.4

### Patch Changes

- 01dc1b7: Syncs `packages/control` to `a11ign/a11ign` `2135079a0`, taken immediately before the delete (a11ign/a11ign#3506): `macsByHost` accepts a same-line comment (#3918), a lab job refuses a host with no laid `packages/lab` through the new `lab-laid-copy` (symlink-resolving entry guard, `run-job.yml` guard and its `a11y_lab.yml` variable, #3833), and `lab:job` drops the package manager's leading `--` (#3919).

## 0.1.3

### Patch Changes

- 295ece7: Syncs `packages/control` to `a11ign/a11ign` `50adf137b`, taken immediately before the delete (a11ign/a11ign#3506): the gate heartbeat (`gate-heartbeat.mjs` with its playbook and two unit files), `fleet:auto-off` judging a laid control against `pinned.control` (#3914) and its refusal clock (`since`, #3859), the auto-off mirror test, and the lab's layer declaration (`pinned.lab`, #3505).

## 0.1.2

### Patch Changes

- b5bd7e5: Carries `a11ign/a11ign` #3837 (#3289): the qualification-status poster uses the host's ambient `gh` and has no token file, and `lab:job` gains `--qualify-sha` (new `qualification-run.mjs`).

## 0.1.1

### Patch Changes

- 7a0cf6e: Synced to `a11ign/a11ign` `eae7806ca`: five commits that touched `packages/control` there after `v0.1.0` was copied (#3534, #3447, #3761, #3504). The tag's layer declaration now has the `screenreader-fleet` layer, `layer-checkouts` is an export, and the 27 tests #3504 relocated (`src/fleet-layer/`) are here.

## 0.1.0

First release from its own repository. `packages/control` moved out of `a11ign/a11ign` with its history (375 commits, internal addresses redacted from every file and commit message), and releases itself from here: a merge carrying a changeset is tagged `v<version>` with a GitHub Release.
