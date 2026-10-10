---
"@a11ign/control": minor
---

`fleet:patch` (`fleet-playbook.ts --playbook=patch.yml`) is the patch window as a command (a11ign/a11ign#4446, under #4405): dry (`--check`) unless `--apply`, behind the link and hold gates, refusing a busy box, a box that cannot be asked, a `Fleet-hold-until:` in the future, and a `--limit` naming more than one box without `--apply`. A completed `--apply` writes `runs/fleet-patch-last-run.json` (`{"lastRunAt": <epoch ms>}`), the file `fleet-watch` reads. `ansible/patch-schedule.yml` installs `a11y-fleet-patch-window.{service,timer}`: the unit passes `--apply --scheduled`, takes its window from playbook variables (`patch_window_days` 28, retry, weekday, hours), retries a refusal each day, and on the last day prints `fleet-health: patch-window-missed` and fails. `a11y-fleet-auto-off` now keeps boxes powered while `patch` runs.
