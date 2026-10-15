Row a11ign/a11ign#5552: `ansible/auth-leak-check.yml` starts the published `node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd` (the file the `a11ysrv` task runs since #5551) with the repo root as argument 2, and its existence check names the published fleet and worker files, not the laid `packages\nvda-worker\src\run-server.cmd` and `packages\worker-fleet\dist\*`. Region: `ansible/auth-leak-check.yml` only. Nothing is run on a box.

Acceptance:

```bash
bash -c '! git grep -q -E "nvda-worker.+src.+run-server[.]cmd" -- ansible/auth-leak-check.yml && git grep -q -E "screenreader-worker.+launcher.+run-server[.]cmd" -- ansible/auth-leak-check.yml'
```

Run from the root of a `a11ign/control` checkout. It fails on `origin/main` (the first grep matches `auth-leak-check.yml:103` and `:156`, the second matches nothing) and passes on this branch.
