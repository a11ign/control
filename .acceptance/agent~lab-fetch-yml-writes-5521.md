Row a11ign/a11ign#5521: `lab-fetch.yml` wrote the fetched artifact above the control checkout. Its destination was `{{ playbook_dir }}/../../../runs/fetched/`, which is `/` from any checkout the playbook runs in; the destination is now `{{ playbook_dir }}/../runs/fetched/`, the checkout root.

Acceptance:

```bash
! grep -q '{{ playbook_dir }}/../../../runs/fetched' ansible/lab-fetch.yml
```

The row's own command is `grep -c` (it prints `0`); `grep -c` exits 1 on zero matches, so the same check is written here as `! grep -q`, which exits 0 exactly when the old expression is gone.
