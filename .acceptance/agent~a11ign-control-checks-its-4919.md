Row a11ign/a11ign#4919 (part of #4425, Done-when 3 of its next tranche). `a11ign/control` now checks its own playbooks: an `ansible` job in `ci.yml` that runs `ansible-playbook --syntax-check` on every top-level playbook and `check-modules.py`, so the core can drop its copy once this has run green on `main`.

Closes a11ign/a11ign#4919

Acceptance:

```bash
bash -c 'cd /home/agent/repos/wt-4919-control && grep -q "ansible-playbook" .github/workflows/ci.yml && grep -q "check-modules.py" .github/workflows/ci.yml && grep -q "ansible/requirements.yml" .github/workflows/ci.yml && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include scripts/ci-composition.test.ts'
```

**As run (measured, 2026-10-11):** the three greps pass and `VERDICT pass: 9 tests in 1 file`. **The row's command as written reads `/home/agent/repos/control`, the primary checkout, which holds `main` at 3ae20b1 (121 commits behind) with no `.github/` at all, so it cannot pass there before or after this merge; the `cd` is to this branch's worktree.** `product-manager` owns the row's Acceptance. The `rstest` half is added, not substituted: the greps prove the words are present, the test proves the job's shape and the gate's wiring.

## What changed

- `.github/workflows/ci.yml`: a job `ansible`, the core's job minus its `lay-layer` step, with `packages/control/ansible` read as `ansible/`: Python 3.12, `pip install ansible-core pyyaml`, `ansible-galaxy collection install -r ansible/requirements.yml`, `--syntax-check` over every top-level playbook against `ansible/inventory.example.yml`, then `python3 check-modules.py` from inside `ansible/` (it globs from its cwd). **It runs on every pull request and merge-group entry, with no path filter**: `gate` accepts `success` only, so a skipped job would read red, and the cost is one small job (about 4 s of `--syntax-check` over 29 playbooks plus `check-modules.py`, measured locally). `gate` now `needs: [changeset, checks, ansible]` and reads `needs.ansible.result`.
- `scripts/ci-composition.test.ts`: the `gate` pin moved to the three needs (outside the row's Region, and unavoidable: the row asks for the job to join the aggregate and that test pins the aggregate), and one new test for the job, with its positive control.

## One deliberate difference from the core's job

The core's loop skipped any file lacking a top-level `hosts:` (`grep -q "^- hosts:\|^  hosts:" "$playbook" || continue`). **That skips a playbook whose `hosts:` is MISTYPED**, which is the exact mutation the row's Done-when 3 names. Measured below: `hosts:` -> `host:` in `sleep.yml` leaves the core's job GREEN although `ansible-playbook` rejects it (`'host' is not a valid attribute for a Play`, exit 4). So this job names the two files that are not playbooks (`inventory.example.yml`, `requirements.yml`; the only two of 31 top-level files the old filter skipped, measured) and checks every other file. A new top-level non-playbook then fails by name, which is the prompt to add it to the list. **The core's own job still has the hole until it is deleted**, which is the plan.

## Mutation

### The job itself (the job's own `run:` blocks extracted from `ci.yml` and run on a copy of `ansible/`; unmutated: 29 playbooks, 462 invocations, 0 problems, GREEN)

- `hosts:` -> `host:` in `sleep.yml`, **the core's filter**: syntax-check step exit 0, check-modules exit 0, job GREEN (the hole). **This job's filter**: syntax-check step exit 1, job RED.
- unknown play keyword (`hostz_typo: x`, `hosts:` kept): syntax-check step exit 1, `'hostz_typo' is not a valid attribute for a Play`, RED.
- invented module option (`reboot_timeout` -> `reboot_timeoutt` on `win_reboot` in `patch.yml`): check-modules exit 1, `undocumented option(s): ['reboot_timeoutt']`, `462 module invocation(s) checked, 1 problem(s)`; **the syntax-check step on the same file exits 0**, which is why both steps exist.

### The test's guards (each against `.github/workflows/ci.yml`, restored by `cp` from a copy and `diff`ed identical; each broke exactly one test and no other)

- `gate` no longer needs `ansible`: fails the `gate waits for changeset, checks and ansible` test.
- the core's content filter put back: fails the new `playbooks are checked in this repository's own CI` test.
- `if: false` on the job (a skip): fails the new test.
- job renamed `playbooks`: fails the new test (its positive control, "the ansible job is found").
- Unmutated: 9 pass.

## Run here

`pnpm run typecheck` clean; `pnpm run layout-check` ok (270 files); the six `scripts/**/*.test.ts` files pass (33 tests). The `checks` job's lay-over-the-core tests (`src/`) were not run here and are CI's. No fleet, no lab, no worker command was run.

## Not done here, and not claimed

- **The job has not run on GitHub yet.** Done-when 2 (a green run on control's `main`, run id on the row) is after the merge, and the core's `ansible` job must not be deleted before it. The row's Done-when 3 mutation is shown above at the job's own commands, not as a red CI run.
- **The repository's required-check set is unchanged**: `gate` is the one required check and now waits for `ansible`, so no ruleset edit is needed (read from `ci.yml`'s header, not from the ruleset, which this session does not hold admin for).
- The collections are installed from Galaxy at the versions `requirements.yml` pins as ranges (`>=`), as the core's job does; a collection release that changes a module's options could turn this red without a change here.

platform: GitHub Actions' own `needs` and `setup-python`; nothing built.
