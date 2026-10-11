Row a11ign/a11ign#4939 (from #4732, under #4405 outcome 1). The fleet's Edge pin follows forward from `152.0.4191.66` to `155.0.4283.45`, the build workers 7, 8 and 9 are on, and `edge-version.yml` stops and disables the Edge updater BEFORE it fetches, refuses or installs, so a box that stops at the Edge step has no live updater.

Closes: none -- a11ign/a11ign#4939 cannot be closed from this repository; `product-manager` closes it at merge.

Acceptance:

```bash
cd /home/agent/repos/wt-4939-control && bash -c 'L=$(mktemp -d -p /home/agent/repos) && git -C /home/agent/repos/a11y-witness worktree add --detach "${L:?}/core" b6d3cbd7616dd68d52726a5c63201f453d0ead62 >/dev/null && cd "${L:?}/core" && pnpm install --frozen-lockfile --offline >/dev/null 2>&1; rm -rf packages/control/src packages/control/ansible; cp -R /home/agent/repos/wt-4939-control/src /home/agent/repos/wt-4939-control/ansible packages/control/ && pnpm exec rstest run --config scripts/rstest/rstest.config.ts --include packages/control/src/fleet-layer/edge-pin-parity.test.ts --include packages/control/src/fleet-layer/edge-updater-before-install.test.ts --include packages/control/src/fleet-layer/provision-stamp-inputs.test.ts; rc=$?; git -C /home/agent/repos/a11y-witness worktree remove --force "${L:?}/core"; rm -rf "${L:?}"; exit $rc'
```

**As run (measured, 2026-10-11, at this branch's head):** `VERDICT pass: 16 tests in 3 files`, the files being the three the row names. **The row's own command cannot pass, and the reason is not this change.** It reads `/home/agent/repos/control`, the primary checkout, which holds `main` at 3ae20b1 (126 commits behind) in the pre-flat `packages/` layout, so it never sees this branch; and in a bare worktree of this repository the tests cannot find their files either (`ENOENT: ... open '/home/agent/packages/control/ansible/roles/worker/defaults/main.yml'`, measured at `origin/main` e6283db before any edit), because `src/` is written for the LAID path `packages/control/` beside `packages/worker-fleet`, which `ci.yml`'s `checks` job provides by laying this package over the core at `CORE_REF` (b6d3cbd76, fleet layer v0.7.3, lab v0.1.28). The command above is that lay, run from this branch. `product-manager` owns the row's Acceptance.

## What changed

- `ansible/roles/worker/defaults/main.yml`: `worker_edge_version` `152.0.4191.66` -> `155.0.4283.45`, `worker_edge_msi_url` and `worker_edge_msi_sha256` with it (hash lower-cased from the index's `46DB09D1…`), and a "FOLLOWED FORWARD" paragraph naming a11ign#4732 and the measured cause. `worker_edge_allow_downgrade` stays `false`.
- `ansible/roles/worker/tasks/edge-version.yml`: the two updater tasks ("Stop and disable EVERY Edge-updater scheduled task", "the updater's services") move from after "Complete the launcher rename" to directly after "What it would do", so they precede "Fetch the pinned installer", the mid-capture refusal, the downgrade refusal, "Install it" and the rename. The row names "Install it"; the position is earlier than that on purpose, because every step from the download to the rename can stop the role at the Edge step, and the downgrade refusal does so by design on any box already newer than the pin, which is what a drifted box is (reasoned from the file, not a reading of a box). It also makes the refusal's own sentence "with the updater already stopped" true. "Refuse to call this provisioned" stays last and unchanged.
- `src/fleet-layer/edge-updater-before-install.test.ts` (new): reads the file's top-level `- name:` lines (no YAML parser: this package has no dependencies, ADR 0012), asserts the order against every step that can stop the role, and carries its negative control, the same assertion on the file with the blocks put back.
- `src/fleet-layer/edge-pin-parity.test.ts`: see the next section.
- `.changeset/the-fleet-s-edge-pin-follows-forward-to-155.md` (patch).

## The version taken, and why

Queried 2026-10-11 from `https://edgeupdates.microsoft.com/api/products?view=enterprise`: the highest Stable x64 Windows MSI is `155.0.4283.45`, published 2026-10-08T18:58Z, sha256 `46db09d14b85a0df8bca87fbe9c3224ccf54f97d776bedc2eebf4b0c2ccbf5b4`, the build the row named at filing. **A later-published Stable row exists, `152.0.4191.122` (2026-10-08T23:00Z): it is an older-branch patch, and a box on 155 cannot be brought to it without `ALLOWDOWNGRADE`, which the role keeps off.** "Newest" here is the highest version, the one boxes 7, 8 and 9 already run.

## The bootstrap copy (the row's item 4): it could NOT be green in control alone, and this is which assertion fails and at which pin

With only the pin moved, at `CORE_REF` (fleet layer **v0.7.3**, whose `bootstrap-windows-worker.ps1` line 432 reads `'152.0.4191.66'`), measured:

- `the bootstrap pins the SAME Edge build the role does` FAILS: "the role pins Edge 155.0.4283.45 and the bootstrap does not mention it".
- `the bootstrap fetches the SAME MSI, verified by the SAME hash` FAILS: "worker_edge_msi_url differs between the role and the bootstrap".
- The other 12 tests of the three files pass, including the stop-before-install assertion on the bootstrap, the rename, the rollback and `provisionRevision` covering `defaults/main.yml`.

I did not widen the Region. `edge-pin-parity.test.ts` is inside it, so it changes "only as far as that needs": `BOOTSTRAP_LAG`, one declared earlier pin (version, URL and hash TOGETHER, `152.0.4191.66`) that the two failing assertions also accept, plus a test that FAILS once the bootstrap carries the role's whole pin with the lag still declared, so the allowance cannot outlive the thing it excuses. All five original tests and their assertions are kept; what is added is the lag, a whole-pin test and the stale-lag test. **What this makes order-independent:** the bootstrap row can land and be released in either order relative to this one; when a core that lays it becomes `CORE_REF`, that bump pull request deletes `BOOTSTRAP_LAG` or its `edge-pin-parity` goes red by name. **`product-manager` still needs to file the bootstrap change** (`a11ign/screenreader-fleet`, `src/provisioning/bootstrap-windows-worker.ps1`: `$EdgeVersion`, the MSI URL and the SHA256 to the three values above): until it lands, a box built from the bootstrap comes up on 152 and its first `fleet:provision` has to follow it forward, which the role does.

## Mutation

Each against the laid copy in a scratch core worktree (the files re-copied from this branch before each run, so nothing was restored by `git checkout`); unmutated: `16 pass` in the 3 files.

- Updater blocks put back after the install (the defect itself): fails `the updater's tasks and services come BEFORE every Edge step…` and the negative control (which reports "the mutation changed nothing"), and no other test.
- Order assertion never fires (`> at(step) + 1000`): fails only `control: the same assertion FAILS on the file…`; the live-file test stays green, as a never-firing check does.
- Order assertion always fires (`<` for `>`): fails the live-file test and the negative control.
- `BOOTSTRAP_LAG` undefined: fails the version assertion and the URL/hash assertion at v0.7.3, and nothing else (this is the state without the lag).
- `acceptedPins` accepting anything, and `carriesWhole` using `some` for `every`: each fails only `control: the lag accepts exactly its own whole pin and nothing else`.
- `lagIsStale` never fires: fails only the same control.
- Bootstrap laid with the role's whole pin, lag still declared: fails only `a declared bootstrap lag is deleted…`. **The same, with the lag deleted: `16 pass`**, which is the marker stopping when the remedy is applied.

## Run here

In the laid tree at `CORE_REF`: `eslint --no-ignore packages/control` 0 errors (the warnings are `no-magic-numbers`, the package's existing ones; the two files this diff touches report none); `tsc --noEmit -p tsconfig.control.json` clean; every `packages/control/**/*.test.ts`: `VERDICT pass: 1232 tests in 74 files`. No fleet, no lab, no worker command was run.

## Not done here, and not claimed

- **No box was touched.** The live window (a whole-fleet `fleet:provision` ending `failed=0` for all 15, workers 7, 8 and 9 reading the new `browserVersion` in `/health`) is its own VERIFY row. Workers 7, 8 and 9 are already on 155; the rest of the fleet moves to 155 when it runs, which is a `browserVersion` change for every box and costs no cache by the same argument as the 151 and 152 moves (not re-measured here for 155).
- The bootstrap is unchanged (above).
- **The ansible syntax check** (`ansible-playbook --syntax-check`, `check-modules.py`) is CI's `ansible` job: not run here, though the diff moves two tasks and edits no module option.

platform: the vendor's own enterprise index for the version, URL and hash, and the file's own top-level `- name:` lines for the order, where a YAML parser would have been a dependency this package forbids (ADR 0012); nothing built.
