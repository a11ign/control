# control

The control plane: the machine that holds the fleet SSH key and dispatches work to the fleet and to the lab. Moved here from
[`a11ign/a11ign`](https://github.com/a11ign/a11ign) with its history (`packages/control`, 375 commits). It has **no dependency of any
kind** (ADR 0012 in `a11ign/a11ign`), and `packages/control/` keeps the monorepo's path so that what reaches a sibling by relative path still does.

| | |
|---|---|
| [`packages/control`](packages/control) | `@a11ign/control`, **AGPL-3.0-or-later**. See its README. |

The root [`LICENSE`](LICENSE) is the core's, byte for byte (`control` shipped none of its own).

**This code reconfigures real Windows machines over SSH.** Read `SECURITY.md` in `a11ign/a11ign` before running any of it.

## It is not self-contained

`packages/control` reaches `packages/worker-fleet`, `packages/lab`, the core's `scripts/` and `guards` by relative path. CI (`.github/workflows/ci.yml`)
therefore lays it over a checkout of `a11ign/a11ign` at the commit in `CORE_REF` and runs the core's eslint, tsc and rstest config on it. To do the same
by hand:

```bash
git clone https://github.com/a11ign/a11ign core && git -C core checkout <CORE_REF>
rm -rf core/packages/control && cp -R packages/control core/packages/control && cp tsconfig.control.json core/
cd core && pnpm install --frozen-lockfile
pnpm exec eslint packages/control && pnpm exec tsc --noEmit -p tsconfig.control.json
pnpm exec rstest run --config scripts/rstest/rstest.config.mjs --include "packages/control/**/*.test.ts"
```

Bumping `CORE_REF` is a pull request: the only way the core's changes reach this repository. `pnpm test` here runs only this repository's own checks (the workflows).

`main` takes pull requests only, each with one approving review, through the merge queue.

## Releasing

A change that should be released carries a changeset (`pnpm exec changeset`); **merging it is the release**. The changeset names `control-workspace`, the root package, which carries the version and the `CHANGELOG.md`. `.github/workflows/release.yml` calls a11ign/toolchain's shared per-merge workflow (`kind: tag`), which cuts the tag
`v<version>` and a GitHub Release carrying the CHANGELOG entry: no registry, no token. A consumer pins a tag. **The first tag, `v0.1.0`, is cut by hand**, once,
on the merge of the pull request that added the workflow, because the workflow reads what the last tag consumed and so needs one.
