A11-252 (https://linear.app/a11ign/issue/A11-252/replace-lockfile-and-dependency-list-snapshot-tests-with-invariants), control's part. `src/control-has-no-dependencies.test.ts` no longer snapshots the lockfile's production closure by `name@version`. It asserts two invariants over package NAMES: every package in the two layers' production closure is `@a11ign/*` or named in `APPROVED_THIRD_PARTY`, and none is dev-only. A version change, including a root devDependency moving through a peer suffix (control#131), passes.

Acceptance:

```bash
pnpm install --frozen-lockfile
pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include "src/control-has-no-dependencies.test.ts"
pnpm run typecheck
```

**What the block shows:** 16 tests pass. On the real lockfile the closure holds only `@a11ign/*`, the four approved names, and the toolchain leak (exempt from the no-dev-only invariant only along the one edge `@a11ign/screenreader-fleet` → `@a11ign/toolchain`, and only while the layer pins are `@a11ign/screenreader-fleet` 0.11.0 and `@a11ign/screenreader-worker` 0.13.13; its third-party names are held to a list). On fixtures: a patch bump and a root-devDependency peer-suffix bump pass; an unapproved `left-pad` fails naming the package and its chain; a `vitest` under the worker layer fails; a moved layer pin makes the toolchain leak fail; a new third-party name inside the leak fails; a second route to the toolchain fails; an alias, URL or `link:` dependency fails; a root `optionalDependencies` entry is checked. CI runs the same file inside the core's lay (`ci.yml`), where the control#131 re-run proves the real lockfile.

**Done-when, "control#131 passes on a re-run" (before merge).** control#131's own `gate` can only go green once its base holds the new test, so the proof before merge is a rehearsal of exactly that run:

- **Rehearsal, run in control's CI:** pull request a11ign/control#145 (closed unmerged) was this branch plus control#131's `pnpm-lock.yaml`, byte for byte, and the one line of its `package.json` that #131 changes (`@rstest/core` `^0.12.3` → `^0.12.4`). Its `checks` job (the core's lay, eslint, tsc and the whole suite, `control-has-no-dependencies.test.ts` included) and `gate` both passed: https://github.com/a11ign/control/actions/runs/40188494109. On the base (the old test, without this change) the same lockfile fails: 1 of 5 tests.
- **Rerunnable by anyone with `gh` access, from a checkout of this branch** (it works in a scratch copy and removes it); a pass prints `VERDICT pass: 16 tests in 1 file`:

```text
#!/usr/bin/env bash
# Runs this checkout's control-has-no-dependencies test against control#131's own lockfile, in a scratch copy, and removes the copy.
set -euo pipefail
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
head_ref="$(gh pr view 131 -R a11ign/control --json headRefName --jq .headRefName)"
git archive HEAD | tar -x -C "$work"
gh api -H "Accept: application/vnd.github.raw" "repos/a11ign/control/contents/pnpm-lock.yaml?ref=${head_ref}" > "$work/pnpm-lock.yaml"
gh api -H "Accept: application/vnd.github.raw" "repos/a11ign/control/contents/package.json?ref=${head_ref}" > "$work/package.json"
ln -s "$PWD/node_modules" "$work/node_modules"
cd "$work"
pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include src/control-has-no-dependencies.test.ts 2>&1 | grep -E "VERDICT"
```

- **After merge,** the owner is A11-256 (today's open Dependabot pull requests): `@dependabot rebase` on control#131 by an identity with push access, then its `checks` and `gate` should be green. That step needs no change to this branch; it is listed so the owner is named, and it is not a merge condition.
