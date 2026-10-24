---
"@a11ign/control": patch
---

`fleet:deploy` registers the `a11ysrv` task before it restarts it, reads the registered action back and refuses a box whose task does not start the published launcher (A11-204). The deploy used to restart a task it never registered, so a box whose task still started the laid `packages\nvda-worker\src\run-server.cmd` (an orphan since a11ign/a11ign#5546, v0.9.0 on a11y-worker-11) kept serving that tree through the restart and through the reboot `verify-code.yml` escalates to: the logon trigger starts the registered action, not the code the deploy laid. The two registration steps move unchanged from `roles/worker/tasks/tasks.yml` into `roles/worker/tasks/worker-task.yml`, which the role imports and `deploy.yml` runs, so the registration is defined once.

`fleet:status` reads each box's worker code (`/health.code`) as a fourth field of the build split: a code split, or a reachable box that reports no code, prints `fleet BUILD SPLIT — Worker code: <hash> on <boxes>; …` and exits **3**, and an agreeing fleet names its one code in the `fleet builds AGREE` line. The old `fleet SPLIT — N different code hashes` line, which named no box, said "Nothing is broken" and exited 0, is gone; `codes` stays in `--json`.
