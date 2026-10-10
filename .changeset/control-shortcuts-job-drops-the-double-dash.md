---
"@a11ign/control": patch
---

The lab's `shortcuts` job no longer hands the audit a literal `--` (a11ign/a11ign#4844, found at #4552). Its `argv` in `ansible/lab-job.yml` was `... scorer:shortcuts -- --model ... --data ... --no-baseline`; the lab's pnpm forwards the `--` to `audit-scorer-shortcuts.py`, where argparse reads it as the end of options and refused every flag after it (`unrecognized arguments: -- --model ...`, exit 2), so the job could never pass. The flags now follow the script name, and `src/fleet-layer/lab-job.test.ts` fails if a `--` returns after `scorer:shortcuts`.

The five other jobs in the file that put a `--` after a `pnpm run` script (`promote:gated` twice, `rules:real-pages`, `scorer:explain-feature`, `corpus:backup`, `training:capture:fresh`) are not touched: whether each target script tolerates it was not read. The file is a host copy's source, so the lab keeps dispatching the old argv until `orchestrator` lays this one.
