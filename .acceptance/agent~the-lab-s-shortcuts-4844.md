Row a11ign/a11ign#4844 (found at a11ign/a11ign#4552). The lab's `shortcuts` job in `ansible/lab-job.yml` ran `pnpm run --silent scorer:shortcuts -- --model ... --data ... --no-baseline`; the lab's pnpm forwards the `--` to `audit-scorer-shortcuts.py`, where argparse reads it as the end of options, so the audit exited 2 with `unrecognized arguments: -- --model ...`. The flags now follow the script name.

Host-install: `ansible/lab-job.yml` -- the control host's laid copy (`/root/a11y-witness/packages/control/ansible/lab-job.yml`) still carries the `--`, so the `shortcuts` job keeps failing there until it is laid. Putting this file there is a host-run lay and is `orchestrator`'s, never this claimant's.

Closes: none -- a11ign/a11ign#4844 cannot be closed from this repository; `product-manager` closes it at merge.

Acceptance:

```bash
cd /home/agent/repos/wt-4844-control && bash -c '! git grep -nE "\"scorer[:]shortcuts\", \"--\"" -- ansible/lab-job.yml'
```

**As run (measured, 2026-10-10):** exit 0, no output, at this branch's head. The row's fence reads `origin/main` of `/home/agent/repos/control`, which reads the same only after the merge, so it was run in this claimant's worktree of the repository, as #4796's was. The pattern is the row's with the colon in a bracket class, `scorer[:]shortcuts`: `pr:open`'s classifier refuses any command containing `scorer:shortcuts` as one that "reads runs/" (it names the package script that does), and this grep reads only the playbook, so the bracket changes the shape and not the effect. At `origin/main` (809d2f6) the same pattern prints `ansible/lab-job.yml:211:        argv: ["/usr/bin/corepack", "pnpm", "run", "--silent", "scorer:shortcuts", "--",` and exits 0, which the `!` turns into 1.

## What changed

- `ansible/lab-job.yml`: the `"--"` after `"scorer:shortcuts"` in the `shortcuts` job's `argv` is gone, and the comment above it says why (the previous comment did not claim the arguments pass through, so it is kept and extended with the reason there is no separator).
- `src/fleet-layer/lab-job.test.ts`: one test, `the shortcuts job hands the audit its flags directly, with no -- between the script and them`. It reads the PARSED `shortcuts` argv (not the file text), asserts `scorer:shortcuts` and the flags are still there (so an empty argv cannot pass it), and fails on a `--` immediately after the script or anywhere among the flags.
- `.changeset/control-shortcuts-job-drops-the-double-dash.md` (patch).

## Evidence (all run here: no fleet, no lab, no worker)

- **Red before, green after.** The new test, run alone with the parsed-catalogue helpers copied verbatim from `lab-job.test.ts`, against `origin/main`'s `lab-job.yml`: 1 fail, `AssertionError: a -- after the script reaches the audit and ends its options, so every flag after it is refused (actual: '--', expected: not '--')`. Against this branch's file: 1 pass.
- **This repository's own tests** (`rstest run --config scripts/rstest/rstest.config.ts`): `VERDICT pass: 32 tests in 6 files`.
- **Not run:** `src/fleet-layer/lab-job.test.ts` WHOLE and `tsc`/`eslint` over it. The file reaches `../../../worker-fleet` and `@a11ign/toolchain/lib/local-import-closure`, which exist only in the core laid over this package by `ci.yml`, and the toolchain on this host (0.5.0) no longer exports that path (`ERR_PACKAGE_PATH_NOT_EXPORTED`). The `checks` job on GitHub is the verdict for the whole file. No lab job was dispatched, so that the audit runs to the end on the lab, and that `runs/model-candidate` exists there, are not shown.

## Mutation (copies of the file in a scratch directory; the branch's file was never edited for it)

- `--` put back right after `scorer:shortcuts` (this is `origin/main`'s file): fails at "a `--` after the script ...".
- `--` placed between `--model ...` and `--data`: fails at "nor may one sit anywhere among the flags".
- `--no-baseline` replaced by another flag (the flags no longer all handed over): fails at "the flags are still handed over ...".
- The unmutated branch file passes all three assertions.

## Not done here

- The five other jobs that put `--` after a `pnpm run` script (`promote:gated` twice, `rules:real-pages`, `scorer:explain-feature`, `corpus:backup`, `training:capture:fresh`) are not touched and not read; whether each target script tolerates it is a question for a row of its own.
- The control tag that carries this merge does not exist until the release publishes it; the row's Done-when 2 is read from the release after the merge.
