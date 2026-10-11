Row a11ign/a11ign#5030 (parent #4405, item 2). Names no workflow, so it is not `lane:ceo`.

Acceptance:

```bash
bash -c 'set -e; C=/home/agent/repos/wt-5030-control; K=/home/agent/repos/wt-5030; rm -rf "${K:?}/packages/control/src"; mkdir -p "$K/packages/control"; cp -R "$C/src" "$C/ansible" "$C/layers.json" "$K/packages/control/"; jq "del(.version, .scripts, .devDependencies, .packageManager, .engines)" "$C/package.json" > "$K/packages/control/package.json"; [ -e "$K/packages/worker-fleet" ] || ln -s /home/agent/repos/a11y-witness/packages/worker-fleet "$K/packages/worker-fleet"; cd "$K"; pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include packages/control/src/fleet-wake.test.ts --include packages/control/src/fleet-playbook.test.ts --include packages/control/src/fleet-auto-off.test.ts'
```

**As run (measured, 2026-10-11):** `VERDICT pass: 289 tests in 3 files` for the command above (and 302 in 4 files with `fleet-lock.test.ts` added to the includes). The row's command as written (`cd /home/agent/repos/control && pnpm exec rstest run src/...`) cannot run: the primary control checkout holds `main` and so none of this change, and its tests import `../../../scripts/...` and `../../worker-fleet/...`, which resolve only when control is laid under a core checkout. The form above is that lay (what `ci.yml`'s `checks` job does), the same one #5014's acceptance used.

## What changed

- `src/fleet-wake.ts`: `keepWokenBoxes(results, { now, take, log })`, called from the command line's `main` after the report and before the exit. At least one result `woken`, `already-up` or `came-up` takes `fleet-lock.ts`'s lock with operation `WAKE_LOCK_OPERATION` (`"wake"`), `longestRunMs: LOCK_GRACE_MS`, so `expiresAt = now + LOCK_GRACE_MS`, holder the process (`lockHolder()`). None ready: no call. A refused take or a control plane that cannot be asked is printed and never thrown or turned into the exit code, as the proof ledger's write is. `wakeFleet` is not touched.
- `src/fleet-playbook.ts`: `lockTakeStep` takes an injectable `end` beside `take`. When the take is refused by a lock whose operation is `wake`, it ends that lock under the wake's own holder (`expireFleetLock`, which sets `endedAt`, and an ended lock refuses nobody) and takes again; at most two passes. The second take is `fleet-lock.ts`'s own atomic read-decide-write, so two operations starting together still have one winner. A refusal by any other operation is untouched, and `end` is never called for it.
- `.changeset/fleet-wake-takes-the-5030.md`.

## Decisions the row left open

- **The take-over is in `fleet-playbook.ts`, not in `fleet-lock.ts`'s `REMOTE_TAKE`** (outside the Region). End-then-take uses only what `fleet-lock.ts` exports and the lock's own refusal rule, which the row's change 2 names for `startPlaybookUnit`.
- **"Ended ready" is `woken`, `already-up`, `came-up`.** `busy` is up and taken by someone else's capture and was not woken for the operator, so it does not take a lock alone; an `already-up` box can be powered off by auto-off as much as a woken one.
- **A wake lock never overrides a fresh lock of a different operation**: the take is refused and said (`fleet lock not taken: provision-role.yml holds it`), because that operation already keeps the boxes.
- **Two operators' wakes**: both use the same `wake` operation, which `fleet-lock.ts` lets take over each other, so the later wake simply extends the grace.

## Mutation (`cp` backup, edit, run `fleet-wake`/`fleet-playbook`/`fleet-auto-off`/`fleet-lock` tests, restore from backup, `cmp` identical)

- `keepWokenBoxes` never takes: 4 fail (ready-box, no-box, said-not-thrown, auto-off keeps).
- Takes with no box ready (guard removed): 1 fails (no-box test). Runs 1000 ms instead of `LOCK_GRACE_MS`: 2 fail.
- `main` does not call it: 1 fails (the wiring pin). `wakeFleet` calls it: 1 fails (the wiring pin only; see below).
- No take-over (`pass < 0`): 2 fail (take-over, bounded). Take-over of any fresh lock: 1 fails (provision-role still refuses patch). Ten passes instead of two: 1 fails. Notice claims a take-over on a plain take: 1 fails.

## Not established

- **Nothing here woke a box or touched the control plane** (resource ban; and the row's third done-when): the lock is written through the real `flock` and `node` against a directory standing in for the control plane's checkout. Whether auto-off now keeps a woken box under the live timer is the live reading on a11ign#4948, not this change.
- **`wakeFleet` writing no lock is pinned by source text, not by behaviour.** The library has no lock transport to inject, so a test that mutates it to take one with the default `ssh` transport passes the behavioural test (the lock goes elsewhere) and fails only the wiring pin; the behavioural test proves no `fleet-lock` command went through the transport it was given.
- Typecheck: the primary checkout's `tsc` run on this worktree reports nothing for the four files; its only errors are `@a11ign/toolchain/*` modules this standalone checkout does not have (the same without this change). ESLint on the laid copy: 0 errors.
