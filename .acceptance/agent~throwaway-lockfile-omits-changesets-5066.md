Draft-because: throwaway proof for a11ign/control#59, do not review and do not merge. Its base is #59's branch, so the diff is the one lockfile change, and it is closed once its check run is read.

`pnpm-lock.yaml` here omits the `@changesets/cli` importer, so `pnpm install --frozen-lockfile` fails (measured locally: `specifiers in the lockfile don't match specifiers in package.json`) and the `release-dry-run` job of #59 must be RED on this pull request (a11ign/a11ign#5066, Done-when 2).

Closes: none -- a throwaway that proves a11ign/control#59's job goes red; it merges nothing and closes no row

Acceptance:

```bash
grep -q "^lockfileVersion" pnpm-lock.yaml
```

Outside-Region: pnpm-lock.yaml — the throwaway's whole content

🤖 Generated with [Claude Code](https://claude.com/claude-code)
