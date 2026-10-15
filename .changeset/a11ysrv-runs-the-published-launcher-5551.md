---
"@a11ign/control": patch
---

The `a11ysrv` scheduled task launches the published `run-server.cmd` under `node_modules\@a11ign\screenreader-worker\launcher\`, the file the provision stamp hashes, and passes the repo root as its working directory (a11ign/a11ign#5551). It used to launch the laid `packages\nvda-worker\src\run-server.cmd`, which the stamp does not cover. The task is re-registered by a whole-fleet `fleet:provision`, not by `fleet:deploy`. `a11ycheck` stays on the laid capture-check launcher, because the release ships none.
