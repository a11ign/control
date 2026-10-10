Row a11ign/a11ign#4866 (found at a11ign/a11ign#4858). The lab's `explain-feature` job in `ansible/lab-job.yml` ran `pnpm run --silent scorer:explain-feature -- --subtype ... --feature ...`; the lab's pnpm forwards the `--` to `explain_feature.py`, where argparse reads it as the end of options, so both flags arrived as positionals and the script exited 2 with `the following arguments are required: --subtype, --feature`. The flags now follow the script name.

Host-install: `ansible/lab-job.yml` -- the control host's laid copy (`/root/a11y-witness/packages/control/ansible/lab-job.yml`) still carries the `--`, so the `explain-feature` job keeps failing there until it is laid. Putting this file there is a host-run lay and is `orchestrator`'s, never this claimant's.

Closes: none -- a11ign/a11ign#4866 cannot be closed from this repository; `product-manager` closes it at merge.

Acceptance:

```bash
cd /home/agent/repos/wt-4866-control && bash -c '! git grep -nE "\"scorer[:]explain-feature\", \"--\"" -- ansible/lab-job.yml'
```

**As run (measured, 2026-10-10):** exit 0, no output, at this branch's head. The row's fence reads `origin/main` of `/home/agent/repos/control`, which reads the same only after the merge, so it was run in this claimant's worktree of the repository, as #4844's was. The pattern is the row's with the colon in a bracket class, `scorer[:]explain-feature`, for the reason #4844 gave: `pr:open`'s classifier reads a command containing the package script's name as one that "reads runs/", and this grep reads only the playbook. At `origin/main` (0cfe2e3) the same pattern prints `ansible/lab-job.yml:894:        argv: ["/usr/bin/corepack", "pnpm", "run", "--silent", "scorer:explain-feature", "--",` and exits 0, which the `!` turns into 1.

## What changed

- `ansible/lab-job.yml`: the `"--"` after `"scorer:explain-feature"` in the `explain-feature` job's `argv` is gone, and a comment above the job says why there is no separator.
- `src/fleet-layer/lab-job.test.ts`: one test, `the explain-feature job hands the script its flags directly, with no -- between the script and them`. It reads the PARSED `explain-feature` argv (not the file text), asserts `scorer:explain-feature` and both flags are still there (so an empty argv cannot pass it), and fails on a `--` immediately after the script or anywhere among the flags.
- `src/lab-job.test.ts`: **outside the row's Region, and required.** `#2334: no existing job's argv changed` pinned the `explain-feature` argv WITH the `--` (line 496), so the merge would have turned it red. The expectation is the same array minus the one `"--"`.
- `.changeset/control-explain-feature-job-drops-the-double-dash.md` (patch).

## Evidence (all run here: no fleet, no lab, no worker)

- **Red before, green after.** The new test's body, extracted verbatim from `src/fleet-layer/lab-job.test.ts` into a scratch file with a `catalogueJobs()` that parses the playbook with PyYAML, run under `node --test`: against `origin/main`'s `lab-job.yml`, 1 fail, `a -- after the script reaches it and ends its options ...`; against this branch's file, 1 pass.
- **The edited `#2334` expectation**, compared with the parsed `explain-feature` argv of each file: `origin/main` False, this branch True.
- **`ansible/lab-job.yml`** parses as YAML (`yaml.safe_load`).
- **Not run:** `src/lab-job.test.ts` and `src/fleet-layer/lab-job.test.ts` WHOLE, and `tsc`. This worktree has no `node_modules`, and the files import `yaml`, `@a11ign/toolchain` and `../../../lab` and `../../../worker-fleet`, which exist only in the core laid over this package by `ci.yml` (`node --test src/lab-job.test.ts` fails with `Cannot find module '/home/agent/repos/lab/src/gates/qualification-status.ts'`). The `checks` job on GitHub is the verdict for the whole files. No lab job was dispatched, so that the script runs to the end on the lab is not shown; that is read from the job's next run, `orchestrator`'s act on a11ign#4858.

## Mutation (copies of the playbook in a scratch directory; the branch's file was never edited for it)

- `--` put back right after `scorer:explain-feature` (this is `origin/main`'s file): fails at "a `--` after the script ...".
- `--` placed between `--subtype ...` and `--feature`: fails at "nor may one sit anywhere among the flags".
- `--feature` replaced by another flag (the flags no longer all handed over): fails at "the flags are still handed over ...".
- The unmutated branch file passes all three assertions.

## Not done here

- **Whether #4844's test generalises:** it would, to every job whose package script already ends in the script's own path and takes no trailing separator, by looping over a list of `[job, script]` pairs. That is not done here because the other `--` users (`promote:gated` twice, `rules:real-pages`, `corpus:backup`, `training:capture:fresh`) are not read, and some of those package scripts may NEED the `--` (a `pnpm run` script that ends in a shell pipeline or an `npm run` chain). A generalised guard over an unread population would assert something nobody has measured, so it is a row of its own once someone reads them.
- `packages/scorer/python/explain_feature.py`'s usage docstring says `npm run scorer:explain-feature -- --subtype ...`; with npm that separator is correct and it is in the core, outside this row's Region, so it is left.
- The control tag that carries this merge does not exist until the release publishes it; the row's Done-when 2 is read from the release after the merge.
