Row a11ign/a11ign#5017 (parent #4405 item 4). Names no workflow, so it is not `lane:ceo`. Not run live: no `fleet:*`, `lab:*` or worker command was run (resource ban), and a corpus run that uses `workers=ready` is the daily use reading and the VERIFY row.

Acceptance:

```bash
cd /home/agent/repos/wt-5017-control && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include 'src/fleet-dispatch.test.ts' --include 'src/inventory-example-parity.test.ts' --include 'src/group-vars-state-their-connection.test.ts'
```

**As run (measured, 2026-10-11):** `VERDICT pass: 37 tests in 3 files` (28 in `fleet-dispatch.test.ts`, of which 9 render the real playbook tasks under `ansible-playbook`; `inventory-example-parity` prints its honest `SKIPPED: inventory.yml is absent` for the real-file comparison, and its example-shape tests pass with the new `all: vars:` block). `pnpm run typecheck` is clean. The row's command as written (no `--config`, `cd` swapped to this worktree) prints `No test suites found in file` for all three files and exits 1: the same fact #5002's acceptance recorded, since control's default rstest run lacks the `node:test` shim only the toolchain config carries.

## What changed

- `src/fleet-dispatch.ts` (new). `chooseWorkers({request, pool, load})`, pure: `ready` is every ready box, a number N is the N with the fewest captures in 24 h, ties by name with `a11y-worker-2` before `a11y-worker-10`. Only a `ready` box is a candidate (`busy`, `warming`, `unreachable` are never counted to make a number); fewer ready than N returns what exists with `short: true` and a note naming each box that was set aside and its state. A box with no capture reading ranks AFTER every box with one and is named, never read as zero. Around it: `resolveDispatch` (probe `/health`, read the ledger, choose, `wakeFleet` only the chosen, drop and name a chosen box that did not come up) and a CLI the playbook runs (one JSON object on stdout, exit 3 and nothing on stdout when nothing may be chosen, exit 2 on a request or pool it cannot read, pool entries refused unless a worker name and an IPv4 address).
- `ansible/lab-job.yml`, after `Which workers this run may use`: the option must be a literal boolean; `workers=ready` is refused naming `lab_dispatch_balance` when it is off; when on, a request of `ready` or a count runs the CLI (`delegate_to: localhost`, the tsx loader when `/opt/a11y-tsx` has it), takes the chosen in inventory order, re-asserts that every returned name is a capturing host, and refuses a COUNT the resolver could only part-fill. A resolver failure fails the play; there is no fall-back to the unbalanced selection. A name list and the no-`workers` default never reach the resolver. `workers` is unchanged in `lab_caller_params`.
- `ansible/inventory.example.yml`: `all: vars: lab_dispatch_balance: false`, with the meaning and the revert written beside it.
- `.changeset/a-lab-job-can-ask-for-n-workers-5017.md` (`ansible/` is releasable).

## The one-line revert, and what is not covered

**Revert: `lab_dispatch_balance: false` in the inventory** (it is `false` in the example and is the default when undeclared). With it off, nothing differs from `origin/main`: the rendered OFF tests pin `workers=<N>` as the first N capturing hosts and a name list as given, exactly as before.

**`capture-check` is not covered**: it is not dispatched through `lab-job.yml` (it is a scheduled task on one box, `worker_check_task_name`), so its single-worker shape is a separate change in a11ign/lab.

## Decisions the row left open

- **`workers=<N>` with the option OFF keeps its existing meaning (the first N capturing hosts), it is not refused.** The row says both "the new values are refused" and "the existing cap keeps its meaning"; a count is not a new value, and refusing it would change today's behaviour and fail `src/lab-job.test.ts`'s `#2764 workers=<n>` tests. `ready` is the only value refused when off.
- **A count the resolver can only part-fill is refused in the playbook, `ready` takes what is there.** The resolver returns what exists and says so (as specified); the playbook decides, for #21's reason that "five boxes" and "however many were ready" are different measurements.
- **The option is `all: vars:`, not a group var of one group**, because the selection tasks run in a play whose hosts are the lab and the localhost play, and only `all` is visible to both.

## Not established, and a gap outside this Region

- **`pnpm run lab:job -e workers=ready` still refuses in the wrapper, before the playbook runs.** `src/lab-job.ts`'s `neededWorkers` (line ~259) reads any non-numeric `workers` as a name list and refuses `ready` as "not in the inventory", and for a count it wakes `fleet.slice(0, N)`, the FIRST N, not the least loaded. `src/lab-job.ts` is not in this row's Region, so it is not touched. The playbook path is reachable directly (`ansible-playbook lab-job.yml -e job=... -e workers=ready`, a form the playbook's own header documents), and is complete there; making `lab:job` reach it is a small change to `neededWorkers` (accept `ready`, and under the option resolve through `chooseWorkers` so the wake and the playbook name the same boxes) that needs the Region widened.
- The ledger path (`/root/a11y-witness/runs/fleet-captures-state.json`) is `CONTROL_PLANE_CHECKOUT_PATH` plus `fleet-watch`'s own `DEFAULT_CAPTURES_STATE_PATH`, read through `sshToControlPlane`; no box was read here, so that the file is where the resolver looks is inferred from those two constants, not measured.
- `src/lab-job.test.ts` and `src/fleet-layer/lab-job.test.ts` cannot load in this standalone tree (they import `../../lab/src/...` and read `/home/agent/packages/...`), so they were NOT run. The whole `src/**` suite printed `19 of 832 tests failed in 75 files`; every failure message is `Cannot find module '../../lab|guards|scripts/...'` or `ENOENT /home/agent/packages/...` (inferred from the messages, not re-run on `origin/main`). The marks those files lift tasks between are untouched and `fleet-dispatch.test.ts` lifts the same span.

## Mutation (measured, each restored from a `cp` backup, `cmp` byte-identical)

| Mutation | Tests that fail |
| --- | --- |
| chooser sorts by name instead of load | 6: the N-least-loaded pin, its own mutation control, unknown-load, and the three resolver/CLI tests that order by load |
| the `ready` filter removed (pads with non-ready boxes) | 10, every one a test of the chooser or of what is woken |
| unknown load read as zero | exactly 1: `a box with no capture count ranks after...` |
| playbook: the `workers=ready` refusal's assertion made `true` | exactly 1: `OFF ... workers=ready is refused naming the option` |
| playbook: the option ignored (always on) | exactly 1: `OFF: workers=<N> is still the first N ...` |
| playbook: the part-filled-count refusal made `true` | exactly 1: `ON: a count the resolver could only part-fill is refused` |

Closes a11ign/a11ign#5017
