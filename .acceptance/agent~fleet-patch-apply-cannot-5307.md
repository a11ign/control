Row a11ign/a11ign#5307: `fleet:patch --apply` cannot be driven from control's own checkout. This PR is the HOLD-READ half, which is the whole of #5307 after product-manager's split; the remote-sync half is a11ign#5310.

Acceptance: `cd /home/agent/repos/wt-5307-control && pnpm exec node --test src/fleet-playbook.test.ts`

Closes a11ign/a11ign#5307

The hold read now passes `--repo a11ign/a11ign`. The remote sync (`controlPlaneCheckout`, `CONTROL_PLANE_CHECKOUT`) is NOT here: pointing it at the plane's `/root/control` would move every fleet play onto a directory nothing provisions yet (a11ign/a11ign#5306).

**As run (measured, 2026-10-12):** `tests 125, pass 125, fail 0` at this branch's head. The row's command as written is `cd ~/repos/control`, the primary checkout, which does not hold this change, so the path above is this worktree's. Mutation: removing `"--repo", ROWS_REPO` from the `gh` argv fails `#5307: the hold read names the repository its rows live in...` (`pass 124, fail 1`); restored from a scratchpad copy and checked byte-identical. `pnpm run typecheck`: exit 0. `pnpm test` (rstest, affected set): `VERDICT pass: 40 tests in 7 files`.
