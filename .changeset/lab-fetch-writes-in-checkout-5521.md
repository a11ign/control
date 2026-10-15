---
"@a11ign/control": patch
---

`lab:fetch` writes the artifact under the control checkout that ran it (`runs/fetched/` beside `ansible/`), not three directories above it. The old destination climbed to `/` from every checkout (a11ign/a11ign#5521).
