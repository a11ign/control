Row a11ign/a11ign#5307: `fleet:patch --apply` cannot be driven from control's own checkout. This PR is the HOLD-READ half only.

Closes: none -- half 1 of 2. The hold read now passes `--repo a11ign/a11ign`. Half 2 (the remote sync and the plane's checkout directory) is held: `/root/control` is not provisioned on the plane, and changing the shared `CONTROL_PLANE_CHECKOUT` to point there would move every fleet play onto a directory that does not exist. It waits on a11ign/a11ign#5306's step.

Acceptance:

```bash
cd /home/agent/repos/wt-5307-control && pnpm exec node --test src/fleet-playbook.test.ts
```

**As run (measured, 2026-10-12):** `tests 125, pass 125, fail 0` at this branch's head. The row's command as written is `cd ~/repos/control`, the primary checkout, which does not hold this change, so the path above is this worktree's. The new case `#5307: the hold read names the repository...` was run BEFORE the fix and failed on the `gh` argv (`issue list --state open --label fleet-gated --json number,body --limit 100`, no `--repo`), then passes after it. `pnpm run typecheck`: exit 0. `pnpm test` (rstest, affected set): pass.
