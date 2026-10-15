---
"@a11ign/control": patch
---

`deploy.yml` puts every guest's core checkout on a commit the repository DECLARES, not on whatever `--ref` names (a11ign/a11ign#5515, the `deploy.yml` half). `deploy-pins.json`'s `core` is that commit (`remote` and a full 40-hex `commit`), read by `src/layer-pins.ts` and refused by name when it is a branch, a short sha or a non-GitHub remote. `fleet-playbook.ts` passes it as `a11y_expected_commit` to the core plays, `provision-role.yml` included, and no longer hands them control's own `rev-parse`. `--ref` now selects only the guest's checkout branch, so a ref whose tip does not include the pinned commit fails loudly at the merge or the assertion. Moving the core is a pull request that changes `commit` alone; `src/core-pin.test.ts` asks the core's remote for the pinned object (opt-in with `A11Y_CHECK_CORE_PIN=1`, because no test fails when the network does). Revert: restore `deploy.yml`'s own core `rev-parse` and drop `core` from `deploy-pins.json`.
