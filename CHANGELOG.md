# control-workspace

## 0.13.44

### Patch Changes

- 6db36c3: `fleet:deploy` puts a guest on a core that pins `@a11ign/screenreader-worker` 0.13.13 (a11ign/a11ign#5701, the release carrying the a11ign/a11ign#5697 fix): `deploy-pins.json` moves `core.commit` from `e1beb9034` (which resolved 0.13.4) to `721e2b88e` (a11ign/a11ign#5702, row #5700), and `layers.nvda-worker` to 0.13.13 with the registry's integrity; this package's own `package.json` and `pnpm-lock.yaml` move with it. `control-has-no-dependencies.test.ts` pins the 0.13.13 closure entry.

## 0.13.43

### Patch Changes

- 33b7b6c: `deployedToNothing` no longer calls a run that reached no hosts when the PLAY RECAP shows a host that ran tasks (`ok=<n>`, n above 0): `patch.yml --limit a11y-worker-12` finished `ok=18 failed=0` and the wrapper exited 5 because the log also carried the absent in-tree inventory's `Unable to parse` warning and a `skipping: no hosts matched`, which also left the completed patch window unrecorded (a11ign/a11ign#5311). A log with those signatures and no ran host in the recap is still refused (`src/fleet-playbook.ts`, `src/deploy-reached-no-hosts.test.ts`).

## 0.13.42

### Patch Changes

- 8fed77e: The fleet watch raises a box whose own reported Edge version is not the role's pin (a11ign/a11ign#5660): `edge-pin: <box> <version> (pin <pin>)`, one line per box, before capture day and not as the `browserVersion` refusal during one. The reading is each box's own `/health` report (`fleetStatus` now carries `browserVersions`, agreeing or not) against `worker_edge_version`, so a fleet that agrees on the wrong build is raised too. `edge-pin-parity.test.ts` locates its files from its own path, so it runs in control's checkout as well as the core's lay (`src/fleet-watch.ts`, `src/fleet-status.ts`).

## 0.13.41

### Patch Changes

- 2b10684: `fleet:deploy` installs the plane's locked layers itself when `node_modules/` lags a merged pin (a11ign/control#5596, after #5155 and #5556): where the plane's lockfile declares the released layer and `node_modules/` holds the release before it, the play runs `pnpm install --frozen-lockfile` in the plane's checkout once, says so on stdout, reads again, and refuses if the layers still disagree. Every other lag stays a refusal or a note: no release installed, a lockfile that names none, and a plane whose own lockfile is behind the declaration (`src/layer-checkouts.ts`, `src/fleet-playbook.ts`).

## 0.13.40

### Patch Changes

- 3f3049b: `fleet:deploy` puts a guest on a core that pins `@a11ign/screenreader-worker` 0.13.4 (a11ign/a11ign#5593): `deploy-pins.json` moves `core.commit` from `7e751f5` (which resolved 0.13.1, the release whose junction start-up fails, screenreader-worker#66) to `e1beb9034` (a11ign#5591), and `layers.nvda-worker` to 0.13.4 with the registry's integrity; this package's own `package.json` and `pnpm-lock.yaml` move with it. `layer-installed-lag.test.ts` now derives the declared release in its refusal assertions and `control-has-no-dependencies.test.ts` pins the 0.13.4 closure entry, so the next bump moves one file.

## 0.13.39

### Patch Changes

- c95d9e1: A fleet play refused for a failed hold read names the cause (a11ign/a11ign#5586): when `agent-org gate-snapshot-read` fails, the refusal quotes the child's first non-empty stderr line with its exit status (cut at 200 characters and marked), instead of Node's `Node.js v24.21.0` footer. The refusal still refuses; a read that succeeds, or prints unparseable stdout, is unchanged (`src/fleet-playbook.ts`).

## 0.13.38

### Patch Changes

- 336fde2: A manager's fleet-hold read now comes from the gate's snapshot, not the API. The host's `gh` refuses a manager's `issue list --json body` before making any call, so `fleet:deploy` and `fleet:provision` were refused from a manager account on every run, including when no hold existed (a11ign/a11ign#5155, row a11ign/a11ign#5575). The read follows that refusal to `gate-snapshot-read rows --json` and fails closed, every way the snapshot can be missing: unreadable, older than 15 minutes, a row without labels, or a fleet-gated row without its body. Every other caller runs the live `gh issue list` with the same argv as before. Revert: restore the `readFleetGatedIssues` body and delete `readGateSnapshot`, `gatedRowsFromSnapshot` and the two constants beside it.

## 0.13.37

### Patch Changes

- 0f64ee0: A fleet write reads the control plane's installed layers before it moves the plane (a11ign/a11ign#5556). A merged pin bump reaches the plane's checkout by `git merge --ff-only` and nothing installs afterwards, so its `node_modules/` could hold `@a11ign/screenreader-worker@0.13.0` under a lockfile resolving `0.13.1`, and the move's own layer judgement refused only after the merge, spending the first write of a covered run. The command now asks first, read-only, and refuses with exit 2 naming the installed release, the one the plane's lockfile resolves and the one `deploy-pins.json` declares, with `pnpm install --frozen-lockfile` in `/root/control` as the remedy. That install is a write to the control plane and is not made by this change. A plane whose own lockfile is behind the declaration is a note and not a refusal, because the move is what brings it forward.

## 0.13.36

### Patch Changes

- f327d4b: The ADR 0038 leak rehearsal (`ansible/auth-leak-check.yml`) starts the published `run-server.cmd` under `node_modules\@a11ign\screenreader-worker\launcher\`, the file the `a11ysrv` task runs since a11ign/a11ign#5551, and passes the repo root as its working directory. Its pre-run existence check names the published fleet and worker files, not the laid `packages\worker-fleet` and `packages\nvda-worker` trees (a11ign/a11ign#5552).

## 0.13.35

### Patch Changes

- 5616a8d: The `a11ysrv` scheduled task launches the published `run-server.cmd` under `node_modules\@a11ign\screenreader-worker\launcher\`, the file the provision stamp hashes, and passes the repo root as its working directory (a11ign/a11ign#5551). It used to launch the laid `packages\nvda-worker\src\run-server.cmd`, which the stamp does not cover. The task is re-registered by a whole-fleet `fleet:provision`, not by `fleet:deploy`. `a11ycheck` stays on the laid capture-check launcher, because the release ships none.
- fe04008: The lab job's post-install pin assertion (`ansible/tasks/run-job.yml`) judges a laid layer by the `version` the install put under `node_modules/<package>/package.json`, against its `deploy-pins.json` version, instead of by its tag's commit. At the core commit in use the install does not re-lay a laid tree (a11ign/a11ign#5546), so the tree keeps its old tag and the assertion refused a lab that was on its pin (a11ign/a11ign#5548, a11ign/a11ign#5155). A clone keeps the commit assertion, and the reading has the guest's shape (`ansible/deploy.yml`). Revert: restore the single "Read each layer AFTER the install" task and the pin assertion's previous `that:` in `ansible/tasks/run-job.yml`, and drop the "Which release deploy-pins.json names for each layer" set_fact; the lab then judges a laid tree by its commit again.

## 0.13.34

### Patch Changes

- b22e3ee: `fleet:deploy` judges a laid worker or fleet tree by the release the install put under `node_modules/@a11ign/<package>`, against `deploy-pins.json`'s `version`, instead of by the commit its stale `.layer-ref` tag names (a11ign/a11ign#5546, #5155): at the core's pinned commit nothing re-lays the tree, so the old post-install assertion refused every guest. A layer held as a clone is still judged by commit. `deploy-pins.json` moves to what the core commit's lockfile resolves, `@a11ign/screenreader-worker` 0.13.1 and `@a11ign/screenreader-fleet` 0.11.0 (version and integrity together), and `src/layer-pins-core-lock.test.ts` fails when the two disagree. Revert: restore the previous `deploy.yml` read and assertion and the 0.13.0/0.10.2 pins.

## 0.13.33

### Patch Changes

- 6299967: `layerCodeVersion` answers a published layer from its installed release when no `packages/<layer>` checkout exists, so `fleet:deploy` passes its first task on the plane (#5540).

## 0.13.32

### Patch Changes

- 828f4ec: `fleet:deploy`'s first task resolves the control checkout as its root (`playbook_dir/..`) and imports `./src/layer-checkouts.ts`, instead of climbing to `/` and importing `./packages/control/src/...` (a11ign/a11ign#5532).

## 0.13.31

### Patch Changes

- 208d118: `lab:fetch` writes the artifact under the control checkout that ran it (`runs/fetched/` beside `ansible/`), not three directories above it. The old destination climbed to `/` from every checkout (a11ign/a11ign#5521).

## 0.13.30

### Patch Changes

- 8c2ccae: `deploy.yml` puts every guest's core checkout on a commit the repository DECLARES, not on whatever `--ref` names (a11ign/a11ign#5515, the `deploy.yml` half). `deploy-pins.json`'s `core` is that commit (`remote` and a full 40-hex `commit`), read by `src/layer-pins.ts` and refused by name when it is a branch, a short sha or a non-GitHub remote. `fleet-playbook.ts` passes it as `a11y_expected_commit` to the core plays, `provision-role.yml` included, and no longer hands them control's own `rev-parse`. `--ref` now selects only the guest's checkout branch, so a ref whose tip does not include the pinned commit fails loudly at the merge or the assertion. Moving the core is a pull request that changes `commit` alone; `src/core-pin.test.ts` asks the core's remote for the pinned object (opt-in with `A11Y_CHECK_CORE_PIN=1`, because no test fails when the network does). Revert: restore `deploy.yml`'s own core `rev-parse` and drop `core` from `deploy-pins.json`.

## 0.13.29

### Patch Changes

- 70e8738: `ansible/provision.yml` (the manual path, not `fleet:provision`) checks every git call in its guest fast-forward and asserts the guest's HEAD is the commit it resolved, as `provision-role.yml` does since a11ign/a11ign#5512 (a11ign/a11ign#5515). Before, the step was three bare commands, so its exit status was `rev-parse`'s and a merge that could not run printed `changed` on a box that never moved. The commit is resolved on the guest (`rev-parse --verify`), so a commit the guest does not hold fails the box and is named; the report line reads the last line of the output rather than the whole of it. The short sha the step printed is gone: a short sha cannot be compared with the full one the assertion checks.

## 0.13.28

### Patch Changes

- 4ca3875: `fleet:provision` no longer hands the guests a commit of the control repository they cannot hold: the role fast-forwards each guest's core checkout to its own `origin/main`, checks every git call, and fails the box by name when the guest is not on the commit it resolved (a11ign/a11ign#5512).

## 0.13.27

### Patch Changes

- 4574e5b: The patch-window unit carries its control-plane key (a11ign/a11ign#5506): `ansible/patch-schedule.yml` renders `Environment=A11Y_PVE_KEY={{ patch_plane_key }}` into `a11y-fleet-patch-window.service`, so the 02:00 run no longer dies on `A11Y_PVE_KEY is required`. `patch_plane_key` has no default and is not committed; the playbook refuses when it is empty. Re-laying the unit on the plane is a fleet write (a11ign/a11ign#5511).

## 0.13.26

### Patch Changes

- 56f85d8: The gate heartbeat unit runs `gate-heartbeat.ts` from control's own checkout at `/root/control` (the path `a11y-fleet-auto-off.service` already names, #5312), not from the laid copy at `/root/a11y-witness/packages/control`. Nothing the heartbeat needs is in that copy, and the laid path is what a11ign#5440 removes. Revert: restore the `ExecStart` path to `/root/a11y-witness/packages/control/src/gate-heartbeat.ts`.

## 0.13.25

### Patch Changes

- afdabdf: The worker role's Edge-updater guard task writes its repeat trigger's `repetition` as a mapping, which `win_scheduled_task` accepts, so `fleet:provision` no longer fails on every box at "Register the guard task" with `Index was outside the bounds of the array` (a11ign/a11ign#5472).

## 0.13.24

### Patch Changes

- 1a322aa: The worker role creates `C:\ProgramData\a11ign` before it lays the Edge-updater guard script, so `fleet:provision` no longer fails on every box that lacks it (a11ign/a11ign#5466). The directory is writable only by SYSTEM and Administrators, and Users can read it, because the script runs as SYSTEM and the unelevated worker reads the guard's record from it.

## 0.13.23

### Patch Changes

- 9c65587: `fleet:provision` (and every playbook that pins layers) no longer refuses in the control plane's remote sync for a layer control holds as a published dependency (a11ign/a11ign#5445). `layerMoveShell` ended in a refusal naming `/root/control/packages/<path>`, a directory the plane's plain clone (a11ign/a11ign#5312) never holds, so the sync stopped before the playbook on `nvda-worker` and `screenreader-fleet`. A layer whose `deploy-pins.json` entry declares a `package` and `version` is now judged by the release installed under `node_modules/<package>/`: accepted when `package.json` names the declared version, refused (exit 4) naming the layer, the release and what the directory holds when it does not or when nothing is installed. A clone and a laid tree are moved and judged as before, and a layer declaring no release still refuses.

## 0.13.22

### Patch Changes

- b5025d6: The in-tree inventory fallback is `ansible/inventory.yml` under the control plane's checkout (`/root/control`), the directory `ansible.cfg` sits in, not `packages/control/ansible/inventory.yml`, which that checkout does not have (a11ign/a11ign#5425). The installed `/etc/a11ign/inventory.yml` is still read first, so a plane with the durable copy is unaffected. Revert: restore `packages/control/ansible/` in `inventorySources` in `src/control-plane-fleet.ts`.

## 0.13.21

### Patch Changes

- 08f5bbb: `lab-job.ts` and `lab-watch.ts` resolve `ansible/` from the file itself instead of spelling the core's `packages/control/ansible` (a11ign/a11ign#5426). Both run on the control plane, whose checkout is control's own repository (`/root/control`, a11ign/a11ign#5310) with `ansible/` at the top; there the old `new URL("../../../")` working directory was `/` and every path missed. `lab-job` now runs `ansible-playbook` with `ansible/` as its working directory, like `fleet-playbook.ts`.

## 0.13.20

### Patch Changes

- e5ba4cc: The fleet playbook enters the control plane's checkout at `/root/control` (`CONTROL_PLANE_CHECKOUT = "control"`, the path `ansible/patch-schedule.yml` names as `patch_checkout`, a11ign/a11ign#5306) and runs Ansible from its `ansible/` directory, not `packages/control/ansible`, which that checkout does not have. The playbook unit's `--working-directory` and the patch target probe both use the one `ANSIBLE_ON_THE_PLANE` path, so `fleet:patch --apply` no longer fails on the remote sync or the probe (a11ign/a11ign#5310). Revert: restore `CONTROL_PLANE_CHECKOUT = "a11y-witness"` and `packages/control/ansible` in `fleet-playbook.ts`.

## 0.13.19

### Patch Changes

- cd81a9a: The control-host install playbook (`ansible/control-host-install.yml`) also lays control's own checkout at `/root/control` from `origin/main`, the pnpm that control's `packageManager` field pins (refusing anything but an exact version), and control's production dependencies from the lockfile alone (`pnpm install --frozen-lockfile --ignore-scripts --prod`), so a rebuilt control plane has the working directory and pnpm its units name (a11ign/a11ign#5410, a11ign/a11ign#5306). The loader assertion still runs last and installs nothing. Revert: delete the checkout, pin-read, pin-assert, corepack and install tasks and the `control_repo_url` and `control_checkout` vars; the playbook then lays only the host value again.

## 0.13.18

### Patch Changes

- 2cd6a65: The fleet auto-off unit runs `src/fleet-auto-off.ts` from control's own checkout (`WorkingDirectory=/root/control`, a11ign/a11ign#5306, #5312) and no longer runs `scripts/lay-layer.ts`, which a11ign#5087 deleted, so every tick had refused `cannot-tell`. Its `ExecStartPre` keeps the follow-`main` fast-forward and lays nothing: `@a11ign/worker-fleet` comes from `pnpm install` in that checkout. Revert: restore the unit's `WorkingDirectory=` and `ExecStart=` lines and the two `lay-layer.ts` steps in `ExecStartPre`; the unit then runs the laid copy again.

## 0.13.17

### Patch Changes

- 821dfbf: Control's fleet auto-off runs from control's own checkout (a11ign/a11ign#5312, #5335, ADR 0045 cut 9). `REPO_ROOT` is the checkout's root, and the git-safe environment, protocol guard, code-drift and pnpm-executable helpers come from the published `@a11ign/screenreader-fleet` 0.10.2 (`src/git-safe-env.ts` re-exports the first, so the core's git-spawn guard still sees it). `package.json` declares exactly the two published layers at their `deploy-pins.json` versions, and `tsx` as a dev tool. `CORE_REF` moves to `c5dddb33` and `ci.yml` lays the three layers itself, since the core no longer does. The `valueAt` / `edgeUpdaterGuard.state` re-carry (#5021) is restored in `worker-fleet-carried.ts`. The lab's scripts moved out of the core's root `package.json` (cut 9, #5087) into the lab's own from v0.1.40, so `deploy-pins.json`'s `lab.tag` moves v0.1.28 -> v0.1.40, `lab-job.test.ts` resolves `npm run` names and script paths through the lab as well as the core, and the lay copies `pnpm-lock.yaml`. `layer-checkouts.ts` resolves a layer's `path` from the checkout's own root (`layersRootOf`), the tree above only where the package is laid at `packages/control`. Revert: restore `CORE_REF`, the lab tag and the `../../worker-fleet` imports.

## 0.13.16

### Patch Changes

- f6cd740: Control's Region test files take the screenreader-fleet originals from `@a11ign/screenreader-fleet` package exports instead of `../../worker-fleet/src/`, and the package is a pinned devDependency at 0.9.0. The carried copy keeps the reading the old pin carries; the `edgeUpdaterGuard.state` re-carry (a11ign/a11ign#5021) returns with the pin bump (a11ign/a11ign#5312). The display-mode runtime harness and the `.ps1` reads are gone: no published tarball ships the harness, and the stamp test reads the script from the package. One reference remains: `protocol-guard` is imported by path in `fleet-playbook.test.ts`, blocked on the pin bump to 0.11.0 (a11ign/a11ign#5312).

## 0.13.15

### Patch Changes

- 83c6e4d: Control's lab imports are control's own (a11ign/a11ign#5372, ceo's ruling on a11ign#5335). `post-qualification-status` reads its verdict types from a carried copy, `src/lab-carried.ts`, exported as `@a11ign/control/lab-carried`, instead of reaching `../../lab`. The three tests that read the lab's scripts and corpus move to a11ign/lab (a11ign#5379). No behaviour change.

## 0.13.14

### Patch Changes

- 886795d: `src/fleet-layer/` no longer exists (a11ign/a11ign#5345, step 2 of ruling B on #5335). Its tests that read control's own files live in `src/control-owned/`, a sibling, so every `../..` read keeps its depth; the ones whose destination had merged (a11ign/screenreader-fleet #41, a11ign/lab #105, core #5357) are deleted from control rather than kept as a second copy. Four worker-text tests, the doctor `LIVE` judge-package test and the worker-index half of `no-win32-imports` have no merged destination and stay in `src/control-owned/` until their owner rows land.

## 0.13.13

### Patch Changes

- 1c77f39: Six control modules (`fleet-playbook`, `fleet-discover.test`, `fleet-switch.test`, `fleet-build-incident.test`, `fleet-watch.test`, `fleet-status.test`) take `WORKER_GROUP`, `groupPerLine`, `workersFromInventory` and `fleetConsistency` (with `MUST_MATCH` and `REPORTED_ONLY`) from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/fleet-env.ts` and `fleet-consistency.ts`, paths the core's lay stopped providing at a11ign/a11ign#5175 (a11ign/a11ign#5349, the last of three steps split from #5344 under ruling B on #5335). The carried copies were already compared with the originals by `worker-fleet-carried.test.ts`, which now also pins that these modules import the copy and none names `fleet-env` or `fleet-consistency` by path.

## 0.13.12

### Patch Changes

- 330fb58: `fleet-auto-off` and `fleet-status`'s test take `requestJson` from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/worker-http.ts`, a path the core's lay stopped providing at a11ign/a11ign#5175 (a11ign/a11ign#5346, step 1b of ruling B on #5335). The carried copy was already compared with the original by `worker-fleet-carried.test.ts`, which now also pins that these two import it and neither names `worker-http` by path. The closure test in `fleet-auto-off.test.ts` and the `check-worker-code` reader in `layer-checkouts.test.ts` now read the layer through its resolver and the layer's own files.

## 0.13.11

### Patch Changes

- e25a9d0: Six control modules (`fleet-auto-off`, `fleet-converge`, `fleet-playbook`, `lab-failed-units`, `lab-pipeline`, `post-qualification-status`) take `refuseUnknownFlags` and `flagValue` from `worker-fleet-carried.ts` instead of `../../worker-fleet/src/cli-flags.ts` (a11ign/a11ign#5344, step 1 of ruling B on #5335): a path the core's lay stopped providing at #5175. The carried copy was already compared with the original by `worker-fleet-carried.test.ts`, which now also pins that these six import it and none names `cli-flags` by path.

## 0.13.10

### Patch Changes

- b28826f: `patch.yml` downloads the feature update before the install on a target pass (a11ign/a11ign#5314): a box with nothing staged used to meet the update at the install, where WUA failed the download with HRESULT 0 and left nothing for a switch to commit. The new `win_updates` task is `state: downloaded` on the Upgrades category alone, and a verdict fails the box by name when that pre-download failed, quoting WUA's own `Download result` lines from the module's log. A pre-download that did not fail, including one that finds the update already downloaded, passes through unchanged, and `--check` runs neither task.

## 0.13.9

### Patch Changes

- 77ce75e: The fleet-hold read now names `a11ign/a11ign`, where the rows live, instead of asking the checkout's own remote. From control's checkout that remote is `a11ign/control`, which has issues disabled, so every write play refused on the hold read before reaching the plane (a11ign/a11ign#5307). The remote-sync half of #5307 (`controlPlaneCheckout`) is NOT in this change: it needs the plane's `/root/control` checkout, which nothing provisions yet (a11ign/a11ign#5306).

## 0.13.8

### Patch Changes

- 9b0bfdd: `patch.yml` names each update it installed, by title and KB, after the install (a11ign/a11ign#5308, #4405 item 1): a feature update printed only as a count of "1" could not be told from a cumulative update. No task is added to the install, the switch or the reboot; the new task is a `debug` loop over the installed entries of `win_updates`' `updates`, and prints nothing when none installed.

## 0.13.7

### Patch Changes

- a28b62d: `control-plane-fleet.ts` and `fleet-switch.ts` no longer reach `../../worker-fleet` (a11ign/a11ign#5190, follow-on to #5184 and parent #4425 done-when 3). The declarations they need (`WORKER_GROUP`, `groupPerLine`, the inventory readers `workersFromInventory`, `workerNamesFromInventory` and `portFromGroupVars`, and `DEFAULT_WORKER_PORT`) are carried verbatim in `src/worker-fleet-carried.ts`, each judged against its original in `src/worker-fleet-carried.test.ts`. Nothing the control plane runs changes behaviour.

## 0.13.6

### Patch Changes

- 0292e75: `fleet-discover.ts`, `fleet-status.ts` and `with-control-plane-fleet.ts` no longer import the core's `worker-fleet` by relative path (a11ign/a11ign#5184, found at #5183). The helpers they used (the `/health` read, the inventory group reader, the flag refusal, the health assessment and the fleet-consistency comparison) are carried in `src/worker-fleet-carried.ts`, pinned to their originals by `worker-fleet-carried.test.ts`. Revert: restore the nine `../../worker-fleet/src/` imports in the three files and delete the two new files.

## 0.13.5

### Patch Changes

- 1cc72a3: `@a11ign/control/fleet-wake` no longer imports the core's `worker-fleet` by relative path (a11ign/a11ign#5183, found at #5176). Its `/health` read and its no-flags refusal are now its own, so the module resolves outside a core checkout. Revert: restore the two `../../worker-fleet/src/` imports in `src/fleet-wake.ts`.

## 0.13.4

### Patch Changes

- 3a4f2bf: The patch-window unit runs control's own `src/fleet-playbook.ts` from control's checkout, and no longer runs the core's `scripts/lay-layer.ts` or a laid `packages/control` (a11ign/a11ign#5180, under a11ign#5087, ADR 0045 cut 8 and 9). `ansible/patch-schedule.yml` sets `patch_checkout` to `/root/control`; `ExecStartPre` keeps its `git merge --ff-only origin/main` of that checkout and drops both `lay-layer` calls; `ExecStart` runs `{{ patch_checkout }}/src/fleet-playbook.ts`. Without this, once the core's checkout follows `main` the `lay-layer` step fails quietly and the unit starts a stale copy. Revert: restore the previous `ansible/patch-schedule.yml` and run `fleet:patch-schedule` again; the unit is re-rendered on the next run.

## 0.13.3

### Patch Changes

- 7e1749c: Control declares what it deploys and starts its own commands (ADR 0045 cut 7, a11ign/a11ign#5085). `deploy-pins.json` holds the PUBLISHED worker and fleet (exact version and the `integrity` of each release's tarball) and the lab's tag, and `src/layer-pins.ts` is its one reader: no file of `src/` reads another repository's declaration any more, and `layer-checkouts.ts`, `fleet-auto-off.ts`, `qualification-run.ts`, `lab-laid-copy.ts` and `fleet-converge.ts` read the pins file instead. `fleet:deploy` and `fleet:provision` with no `--layer-ref` fetch each pinned release with `npm pack`, compare its tarball with the pinned integrity and REFUSE, naming the layer and both digests, before the control plane is touched; the guests' commits are the ones the releases' tags name, and the protocol guard reads the unpacked worker. `--layer-ref` still takes typed commits, as before. `doctor` and `worker:code` can run the fleet's bins by name from the same verified pair. `package.json` gains the 31 commands the core started from its own scripts, with paths relative to this repository, and `dependencies` stays `{}`.
  
  Gone with the laid copy: `laidControl`, `pinnedLayerTag`, `layerPinTag` and `CONTROL_LAYER` (the closure judgement of a control laid inside the core, #3914), and the walk-scope declaration of `provision-stamp-inputs.test.ts`. The core must not bump the tag it lays this package at until its `lays` includes `deploy-pins.json` (the readers refuse without it). A qualified run now pins the layers and the lab to what control declares and no longer to the sha's lockfile and manifest; `lab-laid-copy.ts` refuses a lab host laid at another tag than `deploy-pins.json`'s.

## 0.13.2

### Patch Changes

- f657348: A fleet lock whose holder died is posted on the off-fleet ledger (a11ign/a11ign#5019, #4405 item 2): a lock past its `expiresAt` with no `endedAt` gets one `fleet-lock: <operation> stale since <time>` line, posted once and not repeated, and dropped when the lock reads `none` or is taken afresh. A held lock and an ended lock are quiet; an unreadable lock is one constant `fleet-lock: unreadable` line and is never quiet, and an unread lock carries its standing line (`src/fleet-watch.ts`). Revert: drop `fleetLockTick` from `recordOffFleet` and the `fleetLock` option from `main()` in `src/fleet-watch.ts`.

## 0.13.1

### Patch Changes

- a632125: A box whose Edge updater came back is posted on the off-fleet ledger (a11ign/a11ign#5022, #4405 item 3): each box whose worker reports `edgeUpdaterGuard` as `drift` or `stale` gets one `edge-updater: <box> <state>` line, so the box is named where it appears instead of being found by a provision across the fleet. `ok`, `absent` and the `unknown` placeholder are quiet, and an asleep box's line is carried until it reads `ok` (`src/fleet-watch.ts`). Revert: drop `...edgeUpdaterLines(status)` from `offFleetLines` in `src/fleet-watch.ts`.

## 0.13.0

### Minor Changes

- 5f9ef74: `fleet-watch` starts the forward patch for the laggards once per stop-the-line incident (a11ign/a11ign#5028, #4405). `src/fleet-build-incident.ts`: when the fleet is mixed and a new incident is filed, or the standing incident has no start recorded, the watch runs `fleet:patch --apply` through the same entry the orchestrator runs, and records it in `runs/fleet-build-incident-state.json` BEFORE it runs (`running`) and AFTER (its outcome: `done`, `refused: <REFUSING line>` or `failed: exit <n>`). One comment on the incident says the outcome. A refused or failed start is never retried: the line stays stopped until the orchestrator moves the boxes or closes the incident. A reading with a fleet play running, or the fleet locked (a held or unreadable lock), starts nothing and records nothing, so the next reading asks again. A new incident whose URL carries no issue number waits one reading. Without `--post` the start is only said (`WOULD START`). Revert: make `startPatchFor` return `NO_START`; the incident still files, stops dispatch and posts its #928 line as before.

## 0.12.0

### Minor Changes

- f96c7db: A lab job that dispatches to the fleet is refused while a fleet build incident is open (a11ign/a11ign#5029, chairman ruling #4405). `lab:job` asks `openFleetBuildIncident` before it resolves a pool or wakes a box; while an `incident:fleet-build-mixed` issue is open, every catalogue job that `workerDemand` derives as fleet-dispatching exits 3 with stderr naming the incident, the laggard boxes and the target build. A read that cannot be made refuses too, saying it could not ask, so an unreadable GitHub is never read as "no incident". There is no override flag. `describe=1` and jobs with no fleet demand are not refused, and `fleet:deploy`, `fleet:provision` and `fleet:patch` are unchanged. Paths that reach boxes without `lab:job` (direct `ansible-playbook ansible/lab-job.yml`, the scheduled `capture-check` task) are not covered. Revert: delete the `buildRefusal` guard block in `runOnce` (`src/lab-job.ts`).

## 0.11.0

### Minor Changes

- aa3eabe: `fleetStatus` names the Windows build of a fleet that agrees (a11ign/a11ign#5106). The status gains `windowsBuilds`: the `windowsBuild` each reachable box reported, keyed by URL, whether or not the boxes agree (`null` for a box that answered without one; an unreachable box is not named; the `unknown` placeholder is passed through as the worker sent it). `fleetConsistency` still names a value only where boxes differ, so `reportedOnly` and `mismatches` are unchanged. `buildSpread` in `src/fleet-build-incident.ts` reads the new field instead of inferring "agreed" from the absence of a drift entry, so a fleet where EVERY box is on the placeholder (a fleet-wide restart before the first sample) is unread and an open incident stays open; the same fleet on one real build closes it. A status with no `windowsBuilds` claims nothing read. Revert: drop `windowsBuilds` from the return of `fleetStatus` and restore `readingsOf`.

## 0.10.1

### Patch Changes

- 30ba4b1: The patch window's "staged but not switched" refusal matches only an entry naming the staged media (a11ign/a11ign#5052, found at #4405). `patch_safeos_pattern` in `ansible/patch.yml` is `\$WINDOWS\.~BT` alone: `winpe\s+Yes` is on the Windows Recovery Environment entry every Windows 11 BCD carries, so the old pattern passed a box that never switched. Revert: restore `|SafeOS|winpe\s+Yes` to the pattern.

## 0.10.0

### Minor Changes

- 82ad6ce: `fleet-watch` reads the Windows build spread on every reading and files ONE stop-the-line incident (a11ign/a11ign#5026, #4405). `src/fleet-build-incident.ts`: when two reachable boxes report different `windowsBuild`s, one issue in `a11ign/a11ign` is filed, labelled `incident`, `lane:orchestrator`, `ready`, `priority` and `out-of-release`, titled `Mixed Windows build across the fleet: <n> boxes behind <target>`, naming each laggard with its build and carrying `Incident: incident:fleet-build-mixed` on a line of its own (`FLEET_BUILD_INCIDENT_LINE`; `openFleetBuildIncident()` is the one reader). The target is the HIGHEST build compared as dotted numbers, not the most common. OPEN means the line is stopped: it is not commented on again each tick, a second open one is closed as a duplicate, and it is closed with the final reading only when the fleet reads one build AND every box in the inventory was read. A `gh` that cannot be asked is `CANNOT_ASK`, never QUIET; a filed incident is ATTENTION and a line in the #928 post; without `--post` the effects are only said. Revert: drop the `buildIncident:` line in `fleet-watch.ts`'s `main()`; the watch then reads as before.

## 0.9.0

### Minor Changes

- 28e3835: `src/fleet-converge.ts`: one scripted run takes the fleet lock as operation `wake`, wakes every box, runs `deploy.yml` and `provision-role.yml` (with the `--layer-ref` pair resolved from the control plane's laid tags) and `fleet:status`, retries the two known transient causes (an `UNREACHABLE` box after a wake, and a re-enabled Edge updater) up to 3 attempts per box, and reports one result in `runs/fleet-converge-last-run.json`, on a row with `--row=<n>`. The orchestrator is woken once, only for an unknown failure or a known cause that exhausted its attempts. Without `--apply` it only reads and prints the plan (a11ign/a11ign#5023, #4405 item 5). Revert: delete the file; nothing else imports it.

## 0.8.3

### Patch Changes

- ee2411b: `fleet-watch` records, at each hourly tick, which boxes were awake and which worked, and posts the fleet's use on #928 once per UTC day: captures per box and the share of awake box-ticks that did work (a11ign#5016, part of #4405). Under 20 observed ticks it says `unknown` rather than a share.

## 0.8.2

### Patch Changes

- 0b24d42: The worker role stops and disables the Edge updater again after the Edge install and before its closing refusal (a11ign/a11ign#4948, #4405). The first provision over a box that installs Edge used to end `failed=1` at "Refuse to call this provisioned unless Edge is the pinned build and the updater is off": the installer re-registers `MicrosoftEdgeUpdateTaskMachineCore` and `MicrosoftEdgeUpdateTaskMachineUA` as it runs, after the early stop. The early pair stays before the install (a11ign#4732). Revert: delete the late pair from `edge-version.yml`; the role then reads as it does today.

## 0.8.1

### Patch Changes

- a9e7c86: The Edge-updater guard's record keeps the last re-enable (`lastReenabledAt`, `lastReenabled`) across clean runs, so a drift no longer vanishes at the next 15-minute run (a11ign#5048, part of #4405).

## 0.8.0

### Minor Changes

- c6c9dd9: `fleet:wake` takes the fleet lock for the boxes it woke, so the provision or patch typed next meets them awake (a11ign/a11ign#5030, #4405 item 2). After a wake in which at least one box ended `ready` (`woken`, `already-up` or `came-up`), the command takes `runs/fleet-lock.json` with operation `wake`, running to `now + LOCK_GRACE_MS`; with no box ready it takes none, and `wakeFleet`, the library call `lab:job` and the scripted run make, takes none. A fresh `wake` lock is a keep and not a claim: `fleet:deploy`, `fleet:provision` and `fleet:patch` end it under its holder's name and take their own instead of refusing, while a fresh lock of one of those three still refuses a different one. Cost: a box woken by `fleet:wake` and then left alone stays awake until the grace has passed. Revert: drop the `keepWokenBoxes` call in `fleet-wake.ts`'s `main`; auto-off then reads as it does today.

## 0.7.0

### Minor Changes

- ec89e5a: A lab job can ask for all ready workers or the N least loaded (a11ign/a11ign#5017, #4405 item 4): with the inventory var `lab_dispatch_balance: true`, `-e workers=ready` takes every ready box and `-e workers=<N>` the N with the fewest captures in the last 24 h, confirmed awake with `fleet-wake` before the job starts (`src/fleet-dispatch.ts`, wired in `ansible/lab-job.yml`). The option is `false` by default: `workers=ready` is then refused naming it, and `workers=<N>` keeps its meaning of the first N capturing hosts, so nothing changes until the inventory says `true`. `capture-check` is not dispatched through `lab-job.yml` and is not covered. Not reachable through `pnpm run lab:job` until `src/lab-job.ts`'s `neededWorkers` learns `ready` (outside this row's Region, named on the row); `ansible-playbook lab-job.yml` takes it directly.

## 0.6.1

### Patch Changes

- 9c5e2a2: The worker role registers `a11y-edge-updater-guard`, a SYSTEM task that at startup and every 15 minutes stops and disables every `MicrosoftEdgeUpdate*` task and the updater's services, and writes `C:\ProgramData\a11ign\edge-updater-guard.json` (`{checkedAt, reenabled}`) naming what it had to change; the closing assertion requires it to exist and be enabled (a11ign/a11ign#5015, part of #4405).

## 0.6.0

### Minor Changes

- 602bdab: Auto-off keeps every box while a fleet operation holds the fleet lock (a11ign/a11ign#5014, #4405 item 2). `fleet:deploy`, `fleet:provision` and `fleet:patch` take `runs/fleet-lock.json` on the control plane before their unit starts (`src/fleet-lock.ts`), refuse to start under a different operation's lock that has not ended, and shorten it to a 30-minute grace when their unit ends instead of clearing it, so a failed run's next attempt meets awake boxes. `fleet:auto-off` keeps every box with `fleet-lock-held` (or `fleet-lock-unreadable`) and ignores a lock past its `expiresAt`, the operation's longest run, so a crashed run cannot keep the fleet awake for ever. `sleep.yml` and the single-box plays take no lock. Revert: drop `fleetLock: readFleetLock` from `fleet-auto-off.ts`'s `main()`; auto-off then reads as before.

## 0.5.3

### Patch Changes

- 3a80e80: `ansible/patch.yml` commits a staged feature update's switch and fails a box that staged without switching (a11ign/a11ign#5002, #4979): a pass that installed an `Upgrades` item and asked for a restart runs `UsoClient.exe StartInstall`, reads `bcdedit /enum all` for a SafeOS entry, and fails the box `staged but not switched` (with the entries) before any restart. A pass with no `Upgrades` item is unchanged. Not run live: the window on worker 6 is its own VERIFY row.

## 0.5.2

### Patch Changes

- 8cec908: Carries `a11ign/a11ign` #4944 (parent #4405): `probeWorker` retries once when either endpoint fails before it counts a box unreachable, so `fleet:patch` no longer refuses a fleet it could reach on one `socket hang up` (a11ign#4937's live run refused two boxes that answer in 11 ms).

## 0.5.1

### Patch Changes

- 0dff746: The fleet's Edge pin follows forward to `155.0.4283.45` (a11ign/a11ign#4939, from #4732), and the role stops the Edge updater BEFORE it fetches, refuses or installs, so a box that stops at the Edge step can no longer drift. Workers 7, 8 and 9 had Edge move to 154 and then 155 on its own because the updater tasks sat after "Install it": Chromium's MSI declined the 152 pin while logging success, `--rename-chrome-exe` threw, and the role stopped before the tasks that disable the updater. `worker_edge_version`, `worker_edge_msi_url` and `worker_edge_msi_sha256` move to the highest Stable x64 MSI `edgeupdates.microsoft.com` publishes (published 2026-10-08T18:58Z); `worker_edge_allow_downgrade` stays `false`. `provisionRevision` hashes `defaults/main.yml` and `edge-version.yml`, so every box reads provisioned-stale until `fleet:provision` runs, which is the live window and its own VERIFY row.
  
  `src/fleet-layer/edge-updater-before-install.test.ts` pins the order, with the same assertion shown failing on the file with the blocks put back. `edge-pin-parity.test.ts` gains `BOOTSTRAP_LAG`: the bootstrap lives in screenreader-fleet and is laid at the core's pinned tag, which still reads `152.0.4191.66`, so the test accepts that one whole earlier pin and fails the moment the bootstrap carries the role's pin, so the allowance cannot outlive its reason. The bootstrap itself is not changed here.

## 0.5.0

### Minor Changes

- e34331a: `fleet:patch` and the scheduled patch window hand `patch.yml` the fleet's target (a11ign/a11ign#4905, the caller half of #4897 under #4405): a box below the fleet's highest build is brought up to it, a feature update included, and no longer left behind. The wrapper names the boxes on the fleet's highest `/health` build, reads `CurrentBuild.UBR` and `DisplayVersion` from them in one read-only ad hoc `win_shell`, and passes `-e patch_target_release=<NNHn> -e patch_target_build=<build>.<UBR>`. `/health` carries only `<major>.<minor>.<CurrentBuild>`, so the UBR and the release name cannot come from it; there is no build-to-release table. Where no target can be read it passes neither and the plan says why: the play as it was. The dry run prints the target it would pass. With a target, the time the command watches the unit is the larger of four hours and 2.5 hours (the play's 7200 s reboot ceiling plus 1800 s, derived, not measured) per box under the top build, because the next scheduled attempt stops a unit still running.

## 0.4.0

### Minor Changes

- 6e019e8: The patch window brings a box below the fleet's target build up to it, a feature update included (a11ign/a11ign#4897, under #4405, chairman amendment a11ign#4795: "a box below the target is patched, never excluded"). `ansible/patch.yml` takes `patch_target_release` (a release name such as `25H2`) and `patch_target_build` (`<CurrentBuild>.<UBR>`), both read from the fleet by the caller and both empty by default. With a target the window lifts the feature deferral, writes `TargetReleaseVersion`, `TargetReleaseVersionInfo` and `ProductVersion`, adds `Upgrades` to the categories and gives the reboot a longer timeout; every one of those is restored or removed in the `always`, and the removal is read back. Each box's last task fails it, by worker number, when its build is below the target or cannot be read. With no target the play is what it was.
  
  Two things the caller does not do yet: no wrapper (`fleet:patch`, the patch-window timer) reads the target from the fleet and passes `-e`, so the window as scheduled still runs without one; and nothing has run the `Upgrades` path on a box (the live window is its own VERIFY row). `ansible/roles/worker/defaults/main.yml` is deliberately untouched: it is hashed into `provisionRevision`, and these values belong to the window, not to what is provisioned.

## 0.3.9

### Patch Changes

- 4118fe1: The lab's `explain-feature` job no longer hands `explain_feature.py` a literal `--` (a11ign/a11ign#4866, found at #4858). Its `argv` in `ansible/lab-job.yml` was `... scorer:explain-feature -- --subtype ... --feature ...`; the lab's pnpm forwards the `--` to the script, where argparse reads it as the end of options, so both flags arrived as positionals and the job exited 2 with `the following arguments are required: --subtype, --feature`. The flags now follow the script name, and `src/fleet-layer/lab-job.test.ts` fails if a `--` returns after `scorer:explain-feature`.
  
  The other jobs in the file that put a `--` after a `pnpm run` script (`promote:gated` twice, `rules:real-pages`, `corpus:backup`, `training:capture:fresh`) are not touched: whether each target script tolerates it was not read. The file is a host copy's source, so the lab keeps dispatching the old argv until `orchestrator` lays this one.

## 0.3.8

### Patch Changes

- 700c319: `lab:job --qualify-sha` refuses a `gate-stability` launch whose sha pins a lab tag that does not hold the script this copy of `lab-job.yml` runs, BEFORE `pending` is posted (a11ign/a11ign#4863). It asks the sha's own `layers.json` for the lab tag, fetches that tag one commit deep and reads its tree, so a lab older than the playbook (`stability-gate.mjs` only, against a playbook that runs `stability-gate.ts`) leaves no `failure` for the release to read as a regression.

## 0.3.7

### Patch Changes

- c2b8419: The lab's `shortcuts` job no longer hands the audit a literal `--` (a11ign/a11ign#4844, found at #4552). Its `argv` in `ansible/lab-job.yml` was `... scorer:shortcuts -- --model ... --data ... --no-baseline`; the lab's pnpm forwards the `--` to `audit-scorer-shortcuts.py`, where argparse reads it as the end of options and refused every flag after it (`unrecognized arguments: -- --model ...`, exit 2), so the job could never pass. The flags now follow the script name, and `src/fleet-layer/lab-job.test.ts` fails if a `--` returns after `scorer:shortcuts`.
  
  The five other jobs in the file that put a `--` after a `pnpm run` script (`promote:gated` twice, `rules:real-pages`, `scorer:explain-feature`, `corpus:backup`, `training:capture:fresh`) are not touched: whether each target script tolerates it was not read. The file is a host copy's source, so the lab keeps dispatching the old argv until `orchestrator` lays this one.

## 0.3.6

### Patch Changes

- dc0b21a: `ansible/lab-job.yml` names the lab's scripts by their `.ts` paths (a11ign/a11ign#4796, step 3 of #4551): `build-realism-tier`, `calibrate-abstention`, `gate-probe-order`, `axe-calibration`, `lab-inventory`, `stability-gate` (the `stability` and `gate-stability` jobs), `corpus-prune-orphans`, `fleet-hours` and `evidence-check`. The seven that ran under `/usr/bin/node` now run under `lab_tsx`, the runner five other jobs on the same lab host already use, so no job depends on a Node the lab host may not have: the lab's `.mjs` names are one-release shims that stop on the `.ts` import under the distro's Node 22, and are deleted by a11ign/a11ign#4798.
  
  `ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4820 (#4797), whose `layers.json` pins lab v0.1.28, the first tag that holds those nine `.ts` entries. `lab-job.test.ts` discovers the dispatching gates among the `.ts` files (importing `gates/dispatch.ts`) and reads `axe-calibration.ts`'s exit codes from the `.ts`; both read the `.mjs` shims before, which would have made the `--local` guard match nothing.

## 0.3.5

### Patch Changes

- d19fda5: Control follows the lab's `.ts` renames (a11ign/a11ign#4786, step 3 of #4519). `src/post-qualification-status.ts` names `../../lab/src/gates/qualification-status.ts` in its import and its two `Outcome` / `StatusPayload` type references, where it named `.mjs`; and `ansible/lab-job.yml`'s `capture-check` job runs `packages/lab/src/harnesses/capture-check.ts` (lab v0.1.27 keeps the `.mjs` as a one-release shim that THROWS, so a job still naming it would have failed at run time). The tests that read the five other renamed lab files (`assert-action-report`, `capture-check`, `capture-fixtures`, `occurrence-verdict-stability`, `page-identity-rate`) name `.ts` too, and `capture-body-owner.test.ts`'s discovery of capture clients matches `.ts` as well as `.mjs`.
  
  A control tree is now only as good as the core laid beside it: `ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4803, whose `layers.json` pins `lab` at v0.1.27 (it named a core that lays v0.1.24, which holds only the `.mjs`). That core has deleted its own `evidence/src/source-text`, `guards/src/{tree-wide-guard,local-import-closure}` and `scripts/test-support/git-sandbox` in favour of `@a11ign/toolchain/lib/*`, so the six test files that imported them by relative path import the toolchain's copies. The tag this change makes is the one a11ign/a11ign#4787 pins.

## 0.3.4

### Patch Changes

- fcab118: `fleet-watch` no longer exits QUIET when the control host's auto-off refusal could not be read (a11ign/a11ign#4734, #4714's shape one reader over). `readRefusalOrSay` answers a refusal, `null` (read, refused nothing) or `UNREAD`, and `exitCodeFor` makes an unread refusal `CANNOT_ASK` unless something else is ATTENTION.

## 0.3.3

### Patch Changes

- 69390d0: `fleet-watch`'s hourly tick takes the `control-unit-drift` reading (#4714). A control-plane unit that `differs` from the repository's copy, or is `missing-on-host`, is ATTENTION: one `unit-drift: <unit> <kind>` line, posted once and cleared when the unit is re-installed. `not-shipped` is printed and never raised. A host that cannot be read is said on stderr, carries the last lines, and exits `CANNOT_ASK` rather than QUIET. A stale `a11y-fleet-auto-off.service` naming `lay-layer.mjs` failed 316 ticks behind a `-`-prefixed pre-step with nothing on a clock to see it.

## 0.3.2

### Patch Changes

- 41366ef: `fleet:deploy`'s protocol guard reads `src/protocol-version.ts`, the name `screenreader-worker` v0.9.0 ships, and still accepts `protocol-version.mjs` for older layer tags (#4708). It refused "the worker layer is not checked out" with a full clone present.

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
