---
"control-workspace": patch
---

control releases through `a11ign/toolchain`'s shared per-merge workflow (`kind: tag`), and the version and `CHANGELOG.md` now live at the repository root (`control-workspace`), which is the one private package that workflow tags. The tag is still `v<version>`, numbered on from `v0.1.8`; nothing a consumer lays (`src`, `ansible`, `CLAUDE.md`, `README.md`) changes. Row: a11ign/a11ign#3960.
