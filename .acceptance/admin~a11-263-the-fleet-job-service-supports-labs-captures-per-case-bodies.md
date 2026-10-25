A11-263 (https://linear.app/a11ign/issue/A11-263/the-fleet-job-service-supports-labs-captures-per-case-bodies-same-box), step 1 of 4. The fleet job service takes jobs of cases: a body per case, cases held to one box (a good/bad pair, a page's repeats), `skipWhen`, and `fleet job recapture` for named cases of a finished job under the same lease rules (A11-244).

What the change does: `src/fleet-jobs/` (`cases.ts` new; the plan, runner, manifest, store, remote half, CLI, views and fake fleet), `docs/fleet-jobs.md`, and two new test files, `cases.test.ts` and `recapture.test.ts`. Lab's clients move in steps 3 and 4; the lab's route to the service is step 2.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
# A pair on one box, a body per case, a re-capture after a failed evidence check (on the pair's box, as <case>.a2.json), the re-capture queueing behind a held box, skipWhen, a restart moving or failing a group, a store version 2 refused by a version-1 reader, and the CLI's refusals.
node --import tsx --test --test-concurrency=1 src/fleet-jobs/cases.test.ts src/fleet-jobs/recapture.test.ts
# Everything the page job did before still does.
node --import tsx --test --test-concurrency=1 src/fleet-jobs/*.test.ts src/fleet-leases/*.test.ts
pnpm typecheck
pnpm test
```

**What the block shows:** every group of a case job sits on one box, good before bad; each worker is asked with exactly its case's body plus `url`; a rejected `bad` is re-captured by `fleet job recapture` on the box its `good` was taken on, as `x.bad.a2.json`, and the new manifest names `recaptureOf`; a re-capture queues while another job holds its box; a group whose `skipWhen` matches sends nothing and writes no record; a version-2 request is failed by name by a reader that accepts only version 1; page jobs are unchanged.

**Live check before merge** (the chairman session, from the agents host; the standing approval of 2026-10-17 covers the Ansible play): put this branch on the control plane, run two case jobs of two public pages each, then re-capture one case. A pass is both manifests showing each group on one box, and the re-capture's case on the box of its group in the source job, with `recaptureOf` set.

```bash
set -euo pipefail
set -a; . ~/.config/a11ign/fleet.env; set +a
BRANCH=admin/a11-263-the-fleet-job-service-supports-labs-captures-per-case-bodies
OUT="${TMPDIR:-/tmp}/a11-263-live"; mkdir -p "$OUT"
pnpm run fleet:jobs-install -- -e fleet_jobs_ref="$BRANCH"
cat > "$OUT/cases.json" <<'JSON'
{ "cases": [
  { "id": "ex-com.one", "url": "https://example.com/", "body": { "steps": 40, "probeTables": true }, "group": "ex-com" },
  { "id": "ex-com.two", "url": "https://example.com/", "body": { "steps": 40 }, "group": "ex-com" },
  { "id": "ex-org.one", "url": "https://example.org/", "body": { "steps": 40, "probeForms": true }, "group": "ex-org" },
  { "id": "ex-org.two", "url": "https://example.org/", "body": { "steps": 40 }, "group": "ex-org" } ] }
JSON
ID=$(pnpm run --silent fleet -- capture submit --cases "$OUT/cases.json" --boxes 2 --label A11-263)
pnpm run --silent fleet -- job wait "$ID" --timeout 60m
pnpm run --silent fleet -- job status "$ID" --json
pnpm run --silent fleet -- job fetch "$ID" --to "$OUT"
RE=$(pnpm run --silent fleet -- job recapture "$ID" --cases ex-com.two --label A11-263)
pnpm run --silent fleet -- job wait "$RE" --timeout 60m
pnpm run --silent fleet -- job status "$RE" --json
pnpm run --silent fleet -- job fetch "$RE" --to "$OUT"
# the boxes: each group on one, and the re-captured case on its group's box
OUT="$OUT" node -e 'for (const id of process.argv.slice(1)) { const m = require(process.env.OUT + "/" + id + "/manifest.json"); console.log(id, m.recaptureOf, m.captures.map((c) => `${c.case}.a${c.attempt}@${c.box}:${c.status}`).join(" ")); }' "$ID" "$RE"
# afterwards, put the service back on main once the pull request is merged: pnpm run fleet:jobs-install
```

This step changes the service and its CLI only; lab's clients are not moved yet, so nothing else submits case jobs until step 3.
