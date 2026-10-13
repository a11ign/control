Closes a11ign/a11ign#5410 (a11ign#5306: a rebuilt control plane had no `/root/control` and no `pnpm`).

Acceptance:

```bash
node --test src/control-host-install-checkout.test.ts
```

**As run here (2026-10-13), in this worktree:** `tests 6`, `pass 6`, `fail 0`. The row's literal form, `cd ~/repos/control && node --test ...`, cannot pass until this merges: the primary checkout `~/repos/control` is detached at c868ee5 and does not have the test file yet.

Mutation:

- Pre-change playbook (`git show origin/main:ansible/control-host-install.yml`) swapped in: 5 of 6 red. The no-global-npm test stays green there because it passes vacuously on a playbook with no npm at all.
- `--ignore-scripts` removed from the install argv: only the install test goes red.
- Both mutations were restored byte-identical (checked with `diff`).

Also run: `node --test` on `control-runs-under-tsx.test.ts` (5/5), `control-plane-host.test.ts` (17/17), `control-has-no-dependencies.test.ts` (5/5), `fleet-dispatch.test.ts` (29/29), `fleet-playbook.test.ts` (125/125); `pnpm run test` (45 tests in 8 files, pass); `pnpm run typecheck` (clean); `pnpm run layout-check` (ok). `ansible-playbook --syntax-check` exits 0. Control has no `lint` or `verify` script, so neither was run.

Not verified on this box: `corepack enable` as root (the plane runs as root; this worker runs as uid 1000, where `/usr/bin/pnpm` symlink creation fails with EACCES, so the enable step was dropped from a scratch copy for the real run). `/opt/a11y-tsx` is absent here, so the loader assertion fails, as it did before this change.
