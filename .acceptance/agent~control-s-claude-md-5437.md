Row a11ign/a11ign#5437: control's CLAUDE.md says a checkout installs before the write plays. Names no workflow, and it is a prose change to CLAUDE.md, so it is routed to `ceo` by the engineer brief; the gate's reviewer decides.

Acceptance:

```bash
grep -n 'pnpm install --frozen-lockfile' CLAUDE.md
```

The row's own command names `~/repos/control/CLAUDE.md`, the primary checkout; this file is the same file at the repo root, so CI can run it. It is a reading of the file, and the behaviour is the install itself. Positive control: the grep finds nothing on `origin/main` (`grep -c frozen-lockfile` is 0), and finds the install line on this branch.

## Behaviour, before and after (in a fresh worktree with no `node_modules`)

- Before `pnpm install --frozen-lockfile`: `node --input-type=module -e "await import('@a11ign/screenreader-fleet/git-safe-env')"` fails with `ERR_MODULE_NOT_FOUND`. That is the row's failure, with the same cause.
- After the install: the same import exits 0. This is the row's Done-when 2, run in the worktree rather than the primary checkout.

## What changed

- `CLAUDE.md`: the fleet commands block gets `pnpm install --frozen-lockfile` as its first line. A paragraph after the block says why: the write plays import the two declared layers, and a checkout holds them only after the install.
