---
"@a11ign/control": patch
---

The package is the repository's root (a11ign/a11ign#4217): `src/`, `ansible/`, `layers.json` and `CLAUDE.md` moved up from `packages/control/`, the private `control-workspace` shell and `pnpm-workspace.yaml` are gone, the root manifest is `@a11ign/control`, and the two READMEs are one. `@a11ign/toolchain` is bumped to ^0.1.5, the release that carries `layout-check`, and `ci.yml` runs it in the job `gate` waits for. Nothing the control plane runs moves: every `packages/control/...` the code names is the path the package is LAID at in the core's checkout (`/root/a11y-witness/packages/control`), and the next row changes how the core lays it. This is the first tag cut from the flat layout.
