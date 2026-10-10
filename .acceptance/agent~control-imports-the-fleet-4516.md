Closes a11ign/a11ign#4516. Region: `src/`, `.changeset/control-imports-the-fleet-ts.md`, `README.md`.

Acceptance:

```bash
cd /home/agent/repos/wt-4516-control && bash -c '! git grep -nE "worker-fleet/src/[a-z-]+[.]mjs" -- src'
cd /home/agent/repos/wt-4516-control && npx tsc --noEmit
cd /home/agent/repos/wt-4516-control && npx rstest run --config scripts/rstest/rstest.config.*
```
