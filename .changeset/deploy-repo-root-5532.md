---
"@a11ign/control": patch
---

`fleet:deploy`'s first task resolves the control checkout as its root (`playbook_dir/..`) and imports `./src/layer-checkouts.ts`, instead of climbing to `/` and importing `./packages/control/src/...` (a11ign/a11ign#5532).
