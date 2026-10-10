# control-workspace

## 0.3.1

### Patch Changes

- 3cc11f3: A test now fails when any script `a11y-fleet-auto-off.service` runs is absent from the core the package is laid into. The follow-main step's `-` prefix hid `Cannot find module` on every firing from a11ign/a11ign#4268 (which renamed `scripts/lay-layer.mjs` to `.ts`) until the unit was repointed, so a move of a layer pin was not followed in one tick; the test is what would have caught it (#4571).

## 0.3.0

### Minor Changes

- 090712a: `fleet:patch` (`fleet-playbook.ts --playbook=patch.yml`) is the patch window as a command (a11ign/a11ign#4446, under #4405): dry (`--check`) unless `--apply`, behind the link and hold gates, refusing a busy box, a box that cannot be asked, a `Fleet-hold-until:` in the future, and a `--limit` naming more than one box without `--apply`. A completed `--apply` writes `runs/fleet-patch-last-run.json` (`{"lastRunAt": <epoch ms>}`), the file `fleet-watch` reads. `ansible/patch-schedule.yml` installs `a11y-fleet-patch-window.{service,timer}`: the unit passes `--apply --scheduled`, takes its window from playbook variables (`patch_window_days` 28, retry, weekday, hours), retries a refusal each day, and on the last day prints `fleet-health: patch-window-missed` and fails. `a11y-fleet-auto-off` now keeps boxes powered while `patch` runs.

## 0.2.1

### Patch Changes

- 0744d71: Control imports the fleet layer's `.ts` (a11ign/a11ign#4516, for #4514): `@a11ign/screenreader-fleet` 0.6.0 ships its modules as `.ts` and no `.mjs`, so the 82 `../../worker-fleet/src/<f>.mjs` specifiers in 39 files of `src/` (18 distinct fleet modules) name `.ts` now, and so do the three bare file names the tests compare against (`fleet-auto-off.test.ts`'s `FLEET_FILE`, `fleet-scripts.test.ts`'s self-exclusion, `worker-url.test.ts`'s client exclusion). A control tree is now only as good as the fleet laid beside it: it needs a core whose lockfile pins `@a11ign/screenreader-fleet` at 0.6.0 or later, and `ci.yml`'s `CORE_REF` has to move to one (it names a core that lays 0.5.3). The tag this change makes is the one the core pins in #4514.
  
  The other layers moved to `.ts` too (nvda-worker 0.9.0, the core's `scripts/`), and control follows them: the tests that read the worker's source read the laid layer through `layerSourceDir("nvda-worker")` (the npm package ships `dist/` only), `fleet:auto-off`'s remedy and its unit name `node scripts/lay-layer.ts`, and `layers.json` is read at the core root. The runtime reader `layerCodeVersion` resolves a layer's `code-version.ts` first and falls back to `code-version.mjs`, in one helper (`layerHasherFile`), pinned by a fixture each; the fallback exists only for this row's transition and is not a convention to copy.

## 0.2.0

### Minor Changes

- 1bac8d9: `ansible/patch.yml` is the patch window (a11ign/a11ign#4445, under #4405): for each worker, one at a time, it refuses a busy box, lifts the quality-update deferral, installs the pending quality updates with `win_updates` (`reboot: false`), reboots only a box that installed something and Windows asked, restores `worker_update_deferral_policy` from the role in an `always` and reads it back, then reads `CurrentBuild.UBR`. A closing play fails when the readable boxes are on more than one build and names the odd ones; a box that cannot be read is `unreadable`, not a mismatch. Not run live: the first run is row E's.

## 0.1.20

### Patch Changes

- a1836ad: `fleet:watch` posts a box that is off the fleet's Windows build or display mode on #928 before capture day (a11ign/a11ign#4447, under #4405): one line per odd box, `<box>: build <b> (fleet <f>)` or `<box>: display <d> (fleet <p>)`, read off the `mismatches` and `reportedOnly` drift `fleetStatus` already returns. The fleet's value is the modal one among reachable boxes; a tie (which is all that fewer than three disagreeing boxes can be) raises `fleet-split: <values>` instead of naming a value nobody holds, an unreachable box is never counted, and the `unknown` a worker reports before its first sample is not a reading. It raises `patch-window-missed` when the last patch run (`runs/fleet-patch-last-run.json` on the control host, written by `fleet:patch`, #4446) is older than 28 days; no run on record is not a miss. Lines already posted are kept in `runs/fleet-off-fleet-state.json`, not `fleet-watch-state.json`, because agent-org reads every key of that file as a non-ready worker name; a box that returns to the fleet's value is dropped, an unreachable box's entry is carried, and a dry run (no `--post`) does not write the ledger. `watch()` is unchanged; `watchFleet()` returns the stuck workers and the new lines.

## 0.1.19

### Patch Changes

- ebdc3ce: #4441: the display mode is re-asserted and read back at every logon. `tasks.yml` registers `a11y-display-mode-logon`, a logon-triggered `interactive_token` task that runs `set-display-mode.ps1` with `worker_display_mode`'s width and height and exits with the read-back's verdict; `display.yml`'s provision-time task is unchanged, and the report task prints the new task's registration.

## 0.1.18

### Patch Changes

- 0feadd1: Windows quality updates are deferred 30 days on every worker (a11ign/a11ign#4438, under #4405): `worker_update_deferral_policy` gains `DeferQualityUpdates` = 1 and `DeferQualityUpdatesPeriodInDays` = 30, Windows Update for Business's documented ceiling, beside the two feature-update values, so the patch window is the only thing that moves a box's build inside a month. The comment that called quality updates "deliberately left unrestricted" is rewritten, and `update-deferral-policy.test.ts` pins the two values, the 30-day ceiling and the absence of that sentence. `provision.yml` already reads the whole list back; it lands on the fleet at the next `fleet:provision`.

## 0.1.17

### Patch Changes

- a73e796: `layerPinTag` returns the tag a layer's repository really made (a11ign/a11ign #4363): `v<semver>` from the package's first flat version (`screenreader-worker` 0.3.0, `screenreader-fleet` 0.5.3), `@a11ign/<package>@<version>` before it, the rule of `scripts/lay-layer.mjs`'s `releaseTag`. `lab:job --qualify-sha` asked `git ls-remote` for `@a11ign/screenreader-worker@0.5.0`, which the remote never held, so it refused every sha pinning a flat-tagged layer; and `fleet:auto-off`'s stale-checkout guard compared a laid layer's `.layer-ref` (`v0.5.3`) with the scoped form, so it read a current tree as stale.

## 0.1.16

### Patch Changes

- f665921: Control's last twenty-one `.mjs` are TypeScript (a11ign/a11ign#4341, following #4268): converted by `@a11ign/toolchain`'s `js-to-ts` script, its residue (`@typedef`s, casts, untyped parameters) typed by hand, and the `.mjs` baseline lowered from 21 to 0. Every unit, task and argv that runs one now names the loader that resolves on its box: the two control-plane units (`a11y-fleet-auto-off`, `a11y-gate-heartbeat`) and `deploy.yml` and the worker `bespoke.yml` run `/usr/bin/node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs`, the lab's argvs (`lab-status.yml`, `lab_laid_copy_check`) run `lab_tsx`, and `inventory-install.yml` (the operator's machine) runs the core checkout's `tsx`. `control-host-install.yml` now asserts `/opt/a11y-tsx` is installed (it does not install it: ADR 0012, `orchestrator` owns the install, #4292), and `control-runs-under-tsx.test.ts` pins each spelling.

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
