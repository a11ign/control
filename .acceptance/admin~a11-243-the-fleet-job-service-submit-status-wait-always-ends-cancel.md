A11-243 (https://linear.app/a11ign/issue/A11-243/the-fleet-job-service-submit-status-wait-always-ends-cancel-and). The fleet job service: `fleet capture submit` returns a job ID at once and the job runs in a service on the control plane; `fleet job status|wait|cancel|list|fetch` follow it by ID; `wait` always ends; results are in a fixed place per job with a manifest; the store survives a restart of the service.

What the change does: `src/fleet-jobs/` (the store, the plan, the runner, the service, the remote half and the CLI), `ansible/fleet-jobs-install.yml` and `ansible/files/a11y-fleet-jobs.service` (the service from its own checkout, read back through its heartbeat), `pnpm run fleet` and `pnpm run fleet:jobs-install`, and `docs/fleet-jobs.md`.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# The tests the ticket names, against fake workers and the real service as a child process: submit, status, wait done, wait timeout, cancel, a restart mid-job (SIGKILL and SIGTERM), a caller that exits or is killed while its job runs on.
node --test --test-concurrency=1 src/fleet-jobs/*.test.ts src/control-runs-under-tsx.test.ts src/control-plane-fleet.test.ts src/control-owned/no-scheduled-install.test.ts
pnpm typecheck
pnpm test
(cd ansible && ANSIBLE_CONFIG=ansible.cfg ansible-playbook --syntax-check -i inventory.example.yml fleet-jobs-install.yml)
```

**What the block shows:** `submit` prints a job ID before the captures have run; `status` shows `queued` then `running` with progress per box and an estimate; `wait` exits 0, 1, 3 and 124 and cannot be called without a bounded `--timeout`; a hung or failing poll still ends at the deadline; two jobs never hold one box; a service killed with captures in flight resumes the job with one record per page and pass, the interrupted ones noting the re-capture; a graceful stop re-captures nothing; a caller that exits or is killed does not stop its job; the results and the manifest are readable through `fetch`; the unit names the plane's loader and the service's own checkout, and the playbook ships it in the shape `control-unit-drift` reads.

**Live check before merge** (the chairman session, from the agents host; the standing approval of 2026-10-17 covers the Ansible play): put the branch on the plane, submit a real two-page, two-box, two-pass job, wait on it, read it back and fetch it. A pass is `fleet job wait` exiting 0, `status --json` showing `"state":"done"` with 4 of 4 captures, `manifest.json` naming two boxes with their builds, and `fetch` copying 4 records and the manifest.

```bash
set -euo pipefail
set -a; . ~/.config/a11ign/fleet.env; set +a
BRANCH=admin/a11-243-the-fleet-job-service-submit-status-wait-always-ends-cancel
pnpm run fleet:jobs-install -- -e fleet_jobs_ref="$BRANCH"
printf 'https://example.com/\nhttps://example.org/\n' > "${TMPDIR:-/tmp}/a11-243-pages.txt"
ID=$(pnpm run --silent fleet -- capture submit --pages "${TMPDIR:-/tmp}/a11-243-pages.txt" --boxes 2 --passes 2 --label A11-243)
pnpm run --silent fleet -- job wait "$ID" --timeout 30m
pnpm run --silent fleet -- job status "$ID" --json
pnpm run --silent fleet -- job fetch "$ID" --to "${TMPDIR:-/tmp}/a11-243-results"
```

**After merge, run by the chairman session:** `pnpm run fleet:jobs-install` (the default ref, `main`) puts the service back on `main`; it passes when the play's read-back says `a11y-fleet-jobs.service is running at <main's commit>`. The ticket's After-merge line, that an agent's next fleet capture goes through the service, follows from A11-246 moving the callers.

Refs A11-243
