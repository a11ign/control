---
"@a11ign/control": patch
---

Control's rstest config and `control-unit-drift` are TypeScript (a11ign/a11ign#4268, the pilot of ADR 0043's conversion): converted by `@a11ign/toolchain`'s `js-to-ts` script, the one residue (three `@typedef`s) fixed by hand, and the `.mjs` baseline lowered from 23 to 21. The other twenty-one `.mjs` stay: each is named by a deployed unit, an Ansible task or a core `package.json` script, or is imported by one, and the host's Node has no type stripping, so a `.mjs` importing a `.ts` would not start.
