Row a11ign/a11ign#5556 (found on the a11ign#5155 canary). Region is `src/fleet-playbook.ts` and `src/layer-checkouts.ts`, plus a new test file, one line of `src/fleet-playbook.test.ts` and a changeset. Fleet: no. No `fleet:*`, `lab:*`, `training:capture*`, `pnpm run worker:*`, `evidence:check`, `gate:stability` or `capture:check` was run; the plane was not reached, and the read is exercised by running its shell against a directory fixture.

Acceptance: `bash -c 'git grep -q frozen-lockfile -- src/fleet-playbook.ts'`

**As run (measured, 2026-10-15):** the Acceptance exits 0 at this head. `pnpm run typecheck` clean. `pnpm test` reports `failedFiles: 0, failedTests: 0`. `pnpm exec tsx --test src/layer-installed-lag.test.ts`: 12 pass, 0 fail.

**Done-when 1 and 3:** `installedLayersRefusal` (called by `moveControlPlane`, before its `ssh` of the move) reads each published layer's installed release and the lockfile's importer entry, and refuses naming both and the declared release. Positive control in `src/layer-installed-lag.test.ts`: lockfile 0.13.1, installed 0.13.0.

**Done-when 2:** the remedy is `pnpm install --frozen-lockfile` in `/root/control`. It is a write to the control plane that `ceo` has not covered (a11ign#5155 is `answer:ceo`), so this change reports the lag and does not make the install, per product-manager's promotion comment. `fleet:status` was not extended (outside the Region).

**Mutations (restored by copy-back, diffed byte-identical):**
- Refusal never fires (`row.locked === published.version` replaced by `false`): the 0.13.0/0.13.1 positive control and the no-installed-release case fail, and no other.
- Refusal always fires (replaced by `true`): the lockfile-behind note case and the notes case fail, and no other.
- Review rework (reviewer-control-111): the unknown-state branch (`row.locked === "none"`) made dead: the `none none` judgement test and the `none none` move test fail, and no other. `moveControlPlane` made not to read: the lagging, in-step and unreadable move tests and the #5515 positive control fail, and no other.

**Review rework:** an unreadable plane (`none none`) now refuses instead of reading as behind, and the ordering is tested by RUNNING `moveControlPlane` with a recording `ssh` (the read is its first command, the move its second, and the move is never asked when the layers lag) rather than by reading `main`'s text. `src/fleet-playbook.test.ts`'s #5515 positive control now answers the read.

Closes a11ign/a11ign#5556
