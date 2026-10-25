# Fleet jobs are reached over the control plane's SSH, not an HTTP API

---
Status: proposed (A11-243, written by an unattended planning run and not yet agreed by a person)
---

The fleet job service (A11-243) runs on the control plane, and agents on another host need to
submit, watch and fetch jobs. We reach it by running its own CLI on the control plane over the SSH
route every control command already uses (`sshToControlPlane`). The store is a set of files on disk,
and each file has one writer.

We chose this over an HTTP job API. That API would be a new listening port on the one machine that
holds the fleet key, and it would need an authentication scheme this project does not have: the
workers have none, and `ansible/README.md` rejects an `/admin/update` route for the same reason. SSH
is already authenticated, already present on the agents host (`A11Y_PVE_KEY`), and already audited.
Every caller goes through the `fleet` CLI, so a later move to another transport changes the CLI and
nothing that calls it.

## Consequences

- A call costs one SSH round trip. `wait` therefore polls every 15 s, and does not hold a stream
  open.
- The remote half of the CLI runs from the service's own checkout, so the store is only ever read
  by code of the same version as the service that writes it.

