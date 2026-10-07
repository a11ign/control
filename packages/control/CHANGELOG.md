# @a11ign/control

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
