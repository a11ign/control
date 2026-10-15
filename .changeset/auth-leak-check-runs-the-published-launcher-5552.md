---
"@a11ign/control": patch
---

The ADR 0038 leak rehearsal (`ansible/auth-leak-check.yml`) starts the published `run-server.cmd` under `node_modules\@a11ign\screenreader-worker\launcher\`, the file the `a11ysrv` task runs since a11ign/a11ign#5551, and passes the repo root as its working directory. Its pre-run existence check names the published fleet and worker files, not the laid `packages\worker-fleet` and `packages\nvda-worker` trees (a11ign/a11ign#5552).
