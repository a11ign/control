Row a11ign/a11ign#5521: `lab-fetch.yml` wrote the fetched artifact above the control checkout. Its destination was `{{ playbook_dir }}/../../../runs/fetched/`, which is `/` from any checkout the playbook runs in; the destination is now `{{ playbook_dir }}/../runs/fetched/`, the checkout root.

The row's own command is `grep -c '{{ playbook_dir }}/../../../runs/fetched' ansible/lab-fetch.yml`, which prints `0` on this branch and `1` on `origin/main`. `grep -c` exits 1 on zero matches, and an acceptance job needs an executable command with exit 0, so the executable form here renders the real set_fact task through ansible (`ansible/check-lab-fetch-destination.py`), checks the path it computes lands under the checkout root, and refuses the old expression as a positive control. It needs ansible-core, as the `ansible` job of ci.yml installs.

Acceptance:

```bash
python3 ansible/check-lab-fetch-destination.py
```
