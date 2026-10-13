Closes a11ign/a11ign#5410 (a11ign#5306: a rebuilt control plane had no `/root/control` and no `pnpm`).

Acceptance:

```bash
node --test src/control-host-install-checkout.test.ts src/control-host-install-run.test.ts
```

**As run here (2026-10-13), in this worktree:** `tests 11`, `pass 11`, `fail 0`. The first file reads the playbook's text (6 tests); the second RUNS it under `ansible-playbook` against localhost, with control's repository a local fixture on branch `main`, corepack a recording stub, and the host value, checkout and loader in a temporary directory (5 tests). The row's literal form, `cd ~/repos/control && node --test ...`, cannot pass until this merges: the primary checkout `~/repos/control` is detached at c868ee5 and does not have the test files yet.

Execution test, what it asserts: a control pinning `pnpm@10.34.5` runs to the end, and corepack is asked, in order, for `enable`, `prepare pnpm@10.34.5 --activate`, and `pnpm install --frozen-lockfile --ignore-scripts --prod`, the install from the checkout's directory; the checkout holds control's files; the host value reads back. A manifest pinning `pnpm@latest`, or none, fails the assert naming "not an exact pnpm version", and corepack is never called. The valid-pin run is the positive control for those two refusals.

Mutation:

- Pre-change playbook (`git show origin/main:ansible/control-host-install.yml`) swapped in: 5 of 6 text tests red. The no-global-npm test stays green there because it passes vacuously on a playbook with no npm at all.
- `--ignore-scripts` removed from the install argv: the text install test goes red, and the execution test's first case goes red (4 of 5 green, the stub log shows the install without the flag).
- Each mutation restored byte-identical (checked with `diff` against a saved copy).

Where the execution test runs: it SKIPS, with the reason named, when `ansible-playbook` or `/usr/bin/node` is absent. In CI the `ansible` job installs `ansible-core` and runs only `--syntax-check`; the `checks` job runs the core's rstest config and does not install ansible. So the execution test may skip in CI. It runs green in this worktree.

Also run: `node --test` on `control-runs-under-tsx.test.ts` (5/5), `control-plane-host.test.ts` (17/17), `control-has-no-dependencies.test.ts` (5/5), `fleet-dispatch.test.ts` (29/29), `fleet-playbook.test.ts` (125/125); `pnpm run test` (45 tests in 8 files, pass; its rstest include is `scripts/**/*.test.ts`, so it does not reach `src/`); `pnpm run typecheck` (clean); `pnpm run layout-check` (ok). `ansible-playbook --syntax-check` exits 0. Control has no `lint` or `verify` script, so neither was run.

Not verified on this box: `corepack enable` as root (the plane runs as root; this worker runs as uid 1000, where `/usr/bin/pnpm` symlink creation fails with EACCES, so the enable step was dropped from a scratch copy for the real run; the execution test stubs corepack, so it does not exercise the real enable). `/opt/a11y-tsx` is absent here, so the loader assertion fails in a real run, as it did before this change.
