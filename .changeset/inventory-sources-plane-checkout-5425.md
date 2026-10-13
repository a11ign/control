---
"@a11ign/control": patch
---

The in-tree inventory fallback is `ansible/inventory.yml` under the control plane's checkout (`/root/control`), the directory `ansible.cfg` sits in, not `packages/control/ansible/inventory.yml`, which that checkout does not have (a11ign/a11ign#5425). The installed `/etc/a11ign/inventory.yml` is still read first, so a plane with the durable copy is unaffected. Revert: restore `packages/control/ansible/` in `inventorySources` in `src/control-plane-fleet.ts`.
