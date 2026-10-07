---
"@a11ign/control": patch
---

`CLAUDE.md` documents `pnpm run lab:status -e job=…` and `pnpm run lab:stop -e job=…` without the `--`: pnpm 10 forwards a literal `--` to `ansible-playbook`, which reads it as the end of its options (`the playbook: -e could not be found`). Row: a11ign/a11ign#3924.
