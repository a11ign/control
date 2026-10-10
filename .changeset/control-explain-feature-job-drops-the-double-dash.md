---
"@a11ign/control": patch
---

The lab's `explain-feature` job no longer hands `explain_feature.py` a literal `--` (a11ign/a11ign#4866, found at #4858). Its `argv` in `ansible/lab-job.yml` was `... scorer:explain-feature -- --subtype ... --feature ...`; the lab's pnpm forwards the `--` to the script, where argparse reads it as the end of options, so both flags arrived as positionals and the job exited 2 with `the following arguments are required: --subtype, --feature`. The flags now follow the script name, and `src/fleet-layer/lab-job.test.ts` fails if a `--` returns after `scorer:explain-feature`.

The other jobs in the file that put a `--` after a `pnpm run` script (`promote:gated` twice, `rules:real-pages`, `corpus:backup`, `training:capture:fresh`) are not touched: whether each target script tolerates it was not read. The file is a host copy's source, so the lab keeps dispatching the old argv until `orchestrator` lays this one.
