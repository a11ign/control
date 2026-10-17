A11-31 (https://linear.app/a11ign/issue/A11-31/the-staged-25h2-is-never-committed-setup-ran-with-predownload-on). `ansible/collect-logs.yml` now fetches Setup's own Panther logs, `C:\$WINDOWS.~BT\Sources\Panther\setupact.log` and `setuperr.log`, through Ansible, so a feature update's install phase can be read from the control plane. The fetch is read-only on the guest and does not fail the play on a box with no Panther directory. `patch.yml` is unchanged: no route has yet been shown to switch a box (see the PR body).

Acceptance: `node --test src/collect-logs-setup.test.ts`

**As run (2026-10-17, worktree of this branch):** `tests 3, pass 3, fail 0` for the change. The same file run against the base `collect-logs.yml` (from `git show HEAD~1:ansible/collect-logs.yml`): `pass 1, fail 2` (the two fetch assertions), so the test fails without the change. Live: `pnpm run fleet:logs -- --limit=a11y-worker-2 --ref=admin/a11-31-...` ran `PLAY RECAP ok=6 failed=0`; the Setup fetch task returned `ok` for `setuperr.log`, and no Panther file reached the control plane, consistent with a box that never staged an upgrade.

Refs A11-31 (not closed: done-when 1 and 2 are open)
