---
"@a11ign/control": patch
---

The fleet playbook enters the control plane's checkout at `/root/control` (`CONTROL_PLANE_CHECKOUT = "control"`, the path `ansible/patch-schedule.yml` names as `patch_checkout`, a11ign/a11ign#5306) and runs Ansible from its `ansible/` directory, not `packages/control/ansible`, which that checkout does not have. The playbook unit's `--working-directory` and the patch target probe both use the one `ANSIBLE_ON_THE_PLANE` path, so `fleet:patch --apply` no longer fails on the remote sync or the probe (a11ign/a11ign#5310). Revert: restore `CONTROL_PLANE_CHECKOUT = "a11y-witness"` and `packages/control/ansible` in `fleet-playbook.ts`.
