Row a11ign/a11ign#5015 (part of a11ign/a11ign#4405, item 3). Nothing re-asserted the Edge updater's tasks between provisions, and Edge puts one back: 12 boxes ended a11ign#4948 run 1 with `MicrosoftEdgeUpdateBrowserReplacementTask` `Ready`. `edge-version.yml` now registers a SYSTEM guard that repeats the disable and records what it undid.

Closes a11ign/a11ign#5015

platform: Windows Task Scheduler (`community.windows.win_scheduled_task`, already used by `tasks.yml`) is the repetition; nothing new is built.

Acceptance:

```bash
cd /home/agent/repos/wt-5015-control && bash -c 'L=$(mktemp -d) && mkdir -p "${L:?}/packages/control" && for d in /home/agent/repos/a11y-witness/packages/*; do [ "$(basename "$d")" = control ] || ln -s "$d" "${L:?}/packages/$(basename "$d")"; done && ln -s /home/agent/repos/a11y-witness/scripts "${L:?}/scripts" && cp -R src ansible layers.json package.json "${L:?}/packages/control/" && (cd "${L:?}/packages/control" && node --test src/fleet-layer/edge-updater-guard.test.ts src/fleet-layer/edge-updater-before-install.test.ts src/fleet-layer/edge-pin-parity.test.ts src/fleet-layer/provision-stamp-inputs.test.ts); exit $?'
```

**As run (measured):** the row's own command (`cd /home/agent/repos/control && pnpm exec rstest run <the four files>`) cannot run: that clone is the primary checkout, does not hold this branch, has no `rstest` binary (`Command "rstest" not found`), and `edge-pin-parity` and `provision-stamp-inputs` fail there at baseline with `ENOENT`/`ERR_MODULE_NOT_FOUND` because they read the core's sibling packages. The command above runs the same four files with node's runner in a temp tree laying this branch's `src` and `ansible` as `packages/control` beside symlinks to the core's `packages/*` and `scripts`: `tests 23, pass 23, fail 0`. CI's `checks` job is the verdict under rstest.

## Policy was NOT added

The chairman's "tasks removed or disabled, plus policy" is narrowed on evidence. The header of `edge-version.yml` records that the EdgeUpdate policies are stored and never honoured on these standalone boxes (a11y-worker-2 updated itself with them set and read back), so policy is not a mechanism here; unregistering the tasks is not durable since the updater re-registers them. The pair the role already uses (disable the tasks, disable the services) works; what was missing is repetition.

## What changed

- `ansible/roles/worker/tasks/edge-version.yml`: a block lays `C:\ProgramData\a11ign\edge-updater-guard.ps1` and registers `a11y-edge-updater-guard` as SYSTEM (highest run level), triggers: boot, and daily repeating every `edge_guard_interval_minutes` (15, a variable at the top of the block, no new `defaults/main.yml` key). The script matches tasks by the `MicrosoftEdgeUpdate*` prefix, stops a Running task before disabling it, stops a service before setting it Disabled, and writes `edge-updater-guard.json` as `{checkedAt, reenabled}` via a sibling file and `Move-Item`. The closing assertion also requires the guard task to exist and not be Disabled.
- `src/fleet-layer/edge-updater-guard.test.ts`: 7 tests, one positive and a control per property.
- The script is a file run with `-File`, not an inline `-Command`, because quotes survive neither YAML nor the Windows command line.

## Mutation (each on the guard block only, asserted to have changed it)

- Prefix replaced by a two-name list: fails the prefix and the names-not-matched assertions.
- Disable moved before stop (tasks; services): each fails its own order assertion.
- `username: SYSTEM` changed, boot trigger changed, `repetition` removed, record name changed, closing assertion's `Guard` changed: each fails its own message.
- A file with the guard block removed is refused, not passed.

## Not done here

- Not run on a box: the live proof is the whole-fleet provision (a11ign#4948), and a box whose record shows `reenabled` non-empty. No `fleet:*` was run.
- The Ansible `repetition` list form and `duration: P1D` under a daily trigger were not exercised against a real `community.windows` install here.
