---
"@a11ign/control": minor
---

`src/fleet-converge.ts`: one scripted run takes the fleet lock as operation `wake`, wakes every box, runs `deploy.yml` and `provision-role.yml` (with the `--layer-ref` pair resolved from the control plane's laid tags) and `fleet:status`, retries the two known transient causes (an `UNREACHABLE` box after a wake, and a re-enabled Edge updater) up to 3 attempts per box, and reports one result in `runs/fleet-converge-last-run.json`, on a row with `--row=<n>`. The orchestrator is woken once, only for an unknown failure or a known cause that exhausted its attempts. Without `--apply` it only reads and prints the plan (a11ign/a11ign#5023, #4405 item 5). Revert: delete the file; nothing else imports it.
