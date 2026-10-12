Row a11ign/a11ign#5223 (part of #5153, item 1). Region is `renovate.json` (new) and `ansible/roles/worker/defaults/main.yml` (a comment only). No `fleet:*`, `lab:*`, `worker:*` or capture command was run (resource ban). **This PR deploys nothing**: a worker reaches a bumped pin only through a `fleet:deploy` the fleet's owner runs.

Acceptance: `bash -c 'npx --yes --package renovate renovate-config-validator renovate.json && grep -c worker_edge_version renovate.json'`

**As run (measured, 2026-10-12, in this worktree):** `Config validated successfully against 1 file(s)`, then `3`.

**Lookup, measured with `renovate --platform=local` (RENOVATE_DRY_RUN=lookup) against a copy with the shared preset removed (the local platform cannot resolve `local>` presets) and `enabled: true`:**
- On the real file: `microsoft-edge-stable` current `155.0.4283.45`, `updates: []` -- matches `edgeupdates.microsoft.com` read directly (`jq`: the three highest Stable x64 Windows versions are 154.0.4258.53, 154.0.4258.62, 155.0.4283.45). `node` current `24.20.0`, update `v24.21.0` (minor).
- Positive control, the pin edited to `154.0.4258.53` in a scratch copy: updates `154.0.4258.62` (patch) and `155.0.4283.45` (major). So the custom datasource's jsonata transform returns releases; the empty list above is a reading, not a failure.

**Not yet measured:** a dry run by the real engine in `a11ign/.github` (`renovate.yml`, Octo STS). `enabled` is `false` in this PR as the row requires; flipping it, and quoting that run, is Done-when 2 and stays open on the row.

**Pins left to a human, with reason:** `worker_display_driver_version` (Intel publishes no machine-readable feed; url and checksum were hashed by a person, #1782); `worker_edge_msi_url`/`worker_edge_msi_sha256` and `worker_node_sha256` (companions of the two managed pins, not derivable from the version, so a bump PR is version-only, red under the pin-parity tests until a person completes it, and its automerge is off).

**Scope:** `enabledManagers: ["custom.regex"]`, so enabling the config does not also turn on npm/actions bumps that `.github/dependabot.yml` already covers.

Closes a11ign/a11ign#5223
