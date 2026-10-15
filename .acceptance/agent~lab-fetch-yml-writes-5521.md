Row a11ign/a11ign#5521: `lab-fetch.yml` wrote the fetched artifact above the control checkout. Its destination was `{{ playbook_dir }}/../../../runs/fetched/`, which is `/` from any checkout the playbook runs in; the destination is now `{{ playbook_dir }}/../runs/fetched/`, the checkout root.

The row's own command is `grep -c '{{ playbook_dir }}/../../../runs/fetched' ansible/lab-fetch.yml`, which prints `0` on this branch and `1` on `origin/main`. `grep -c` exits 1 on zero matches, and an acceptance job needs an executable command with exit 0, so the executable form here is the test that pins the destination under the checkout root (with a positive control that the old expression is refused).

Acceptance:

```bash
node --test scripts/lab-fetch-destination.test.ts
```
