A11-252 (https://linear.app/a11ign/issue/A11-252/replace-lockfile-and-dependency-list-snapshot-tests-with-invariants), control's part. `src/control-has-no-dependencies.test.ts` no longer snapshots the lockfile's production closure by `name@version`. It asserts two invariants over package NAMES: every package in the two layers' production closure is `@a11ign/*` or named in `APPROVED_THIRD_PARTY`, and none is dev-only. A version change, including a root devDependency moving through a peer suffix (control#131), passes.

Acceptance:

```bash
pnpm install --frozen-lockfile
pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "src/control-has-no-dependencies.test.ts"
pnpm run typecheck
```

**What the block shows:** 16 tests pass. On the real lockfile the closure holds only `@a11ign/*`, the four approved names, and the toolchain leak (exempt from the no-dev-only invariant only along the one edge `@a11ign/screenreader-fleet` → `@a11ign/toolchain`, and only while the layer pins are `@a11ign/screenreader-fleet` 0.11.0 and `@a11ign/screenreader-worker` 0.13.13; its third-party names are held to a list). On fixtures: a patch bump and a root-devDependency peer-suffix bump pass; an unapproved `left-pad` fails naming the package and its chain; a `vitest` under the worker layer fails; a moved layer pin makes the toolchain leak fail; a new third-party name inside the leak fails; a second route to the toolchain fails; an alias, URL or `link:` dependency fails; a root `optionalDependencies` entry is checked. CI runs the same file inside the core's lay (`ci.yml`), where the control#131 re-run proves the real lockfile.
