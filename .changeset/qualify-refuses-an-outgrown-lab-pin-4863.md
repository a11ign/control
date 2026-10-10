---
"@a11ign/control": patch
---

`lab:job --qualify-sha` refuses a `gate-stability` launch whose sha pins a lab tag that does not hold the script this copy of `lab-job.yml` runs, BEFORE `pending` is posted (a11ign/a11ign#4863). It asks the sha's own `layers.json` for the lab tag, fetches that tag one commit deep and reads its tree, so a lab older than the playbook (`stability-gate.mjs` only, against a playbook that runs `stability-gate.ts`) leaves no `failure` for the release to read as a regression.
