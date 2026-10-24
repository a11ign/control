A11-205 (https://linear.app/a11ign/issue/A11-205/freeze-the-fleet-nothing-on-a-box-ever-upgrades-by-itself-upgrades-are), step 1 of 5. The fleet's versions were written in the role's defaults, the bootstrap, a Renovate pattern and a TypeScript regex, and `fleet:status` compared boxes only with each other, so a fleet that drifted together read as clean.

What the change does: `deploy-pins.json` gains `windows`, `edge`, `nvda` and `node` and is the one place they are written. The worker role derives its Edge and Node installs from it. `fleet:status` compares each reachable box's Windows build, Edge, NVDA and worker code with it and exits 3 on any difference, naming the box, the field, what the box has and what the manifest wants.

Acceptance:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
node --test src/fleet-pins.test.ts src/fleet-status.test.ts scripts/renovate-pins.test.ts
pnpm typecheck
pnpm test
# The role reads the manifest: the derived Edge and Node render to the manifest's values.
(cd ansible && ANSIBLE_CONFIG=ansible.cfg ansible localhost -i localhost, -c local --playbook-dir . -e @roles/worker/defaults/main.yml -m ansible.builtin.debug -a 'msg={{ [worker_edge_version, worker_node_version] }}')
# The live reading, read-only, from the control plane: every box against the manifest; exits 3 while any box differs (a11y-worker-5's Windows, any box not yet on the pinned worker code).
pnpm run fleet:status | grep -E 'fleet (OFF THE MANIFEST|on the manifest)'
```

**What the block shows:** the manifest is read whole and each malformed value is refused by name; the manifest is the only source of a version (no playbook, role file or control-plane source carries one, and a planted stray Edge, Node, Windows build or KB literal is caught); the role's pins are derived keys of the manifest; Renovate's managers extract the manifest's current Edge and Node; one box off the manifest on each of Windows, Edge, NVDA and worker code fails with its line, an unreported field fails, a fleet whose boxes all agree with each other but not with the manifest fails, an unreachable box is no reading, an unreadable manifest fails with its reason, and a fleet on the manifest exits 0.

**After merge:** Chairman session: `pnpm run fleet:status` names every box that is not on the manifest; the first reading lists the boxes still on the old worker code until the `fleet:deploy` rollout A11-204 listed has run, and a11y-worker-5's Windows build until the chairman decides what becomes of that box.

Refs A11-205
