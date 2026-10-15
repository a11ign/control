Row a11ign/a11ign#5551: the `a11ysrv` scheduled task launches the published `node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd` (the file the provision stamp hashes), not the laid `packages\nvda-worker\src\run-server.cmd`. Region: `ansible/roles/worker/tasks/tasks.yml` only. `a11ycheck` stays on the laid capture-check launcher, because the release ships none.

Acceptance:

```bash
bash -c '! git grep -q -E "nvda-worker.+src.+run-server[.]cmd" -- ansible/roles/worker/tasks/tasks.yml && git grep -q -E "screenreader-worker.+launcher.+run-server[.]cmd" -- ansible/roles/worker/tasks/tasks.yml'
```

Run from the root of a `a11ign/control` checkout. It fails on `origin/main` (the first grep matches `tasks.yml:33`, the second matches nothing) and passes on this branch.
