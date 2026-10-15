---
"@a11ign/control": patch
---

The lab job's post-install pin assertion (`ansible/tasks/run-job.yml`) judges a laid layer by the `version` the install put under `node_modules/<package>/package.json`, against its `deploy-pins.json` version, instead of by its tag's commit. At the core commit in use the install does not re-lay a laid tree (a11ign/a11ign#5546), so the tree keeps its old tag and the assertion refused a lab that was on its pin (a11ign/a11ign#5548, a11ign/a11ign#5155). A clone keeps the commit assertion, and the reading has the guest's shape (`ansible/deploy.yml`). Revert: restore the single "Read each layer AFTER the install" task and the pin assertion's previous `that:` in `ansible/tasks/run-job.yml`, and drop the "Which release deploy-pins.json names for each layer" set_fact; the lab then judges a laid tree by its commit again.
