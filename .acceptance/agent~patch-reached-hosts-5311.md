Row a11ign/a11ign#5311. `patch.yml --apply --limit a11y-worker-12` finished `ok=18 changed=4 failed=0`, and `fleet:patch` still exited 5 ("REACHED NO HOSTS") and skipped recording the completed window. Cause: the unit's journal starts with `[WARNING]: Unable to parse /root/control/ansible/inventory.yml` (the in-tree fallback inventory is absent; the installed one matched) and `skipping: no hosts matched`, and `deployedToNothing` read those two strings anywhere in the log.

Acceptance: `node --test src/deploy-reached-no-hosts.test.ts`

## What changed

- `src/fleet-playbook.ts`: `deployedToNothing` returns null when the PLAY RECAP has a host line with `ok=` above 0. A log with the same signatures and no ran host is still refused.
- `src/deploy-reached-no-hosts.test.ts`: the 2026-10-17 shape (warning, no-hosts line, then a recap with `ok=18`) is not refused; the same warnings with an empty recap are (positive control).
- `.changeset/a-run-with-a-host-in-its-recap-reached-hosts-5311.md`: patch.

## Evidence (measured 2026-10-17)

- `node --test src/deploy-reached-no-hosts.test.ts`: 6 pass, 0 fail.
- Not run: lint, typecheck, the rest of the suite.

Closes: none -- fixes a wrapper exit code found while running the row's play; the row stays open.
