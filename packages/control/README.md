# `@a11y-witness/control`

**Private. Never published.** The control plane: the one machine that holds the fleet SSH key and can
provision, deploy, wake and sleep the ten bare-metal capture workers. See
[ADR 0012](../../docs/adr/0012-control-plane-split.md) for why this is a separate credential domain from
`lab` (the corpus/training machine) rather than one box doing both.

**No `dependencies`, and that is enforced, not aspirational.** `control-has-no-dependencies.test.ts`
asserts the `package.json` dependency lists are empty — the credential that can reconfigure twelve
Windows boxes must not sit behind npm's transitive dependency surface. The ADR made this claim in prose
first and it was violated on both machines it described before anyone checked.

```
src/
  fleet-playbook.mjs   drives Ansible against the fleet: provision, deploy, wake/sleep
  lab-pipeline.mjs     sequences ordered stages (deploy -> capture -> gates) as one unit
  lab-job.mjs          dispatches one named long-running job on the lab, over Ansible
  fleet-status.mjs     what every worker is doing right now
  fleet-discover.mjs   scans the subnet against inventory.yml, reports drift
  fleet-wake.mjs       power the fleet on (Wake-on-LAN) or check it answered

ansible/               the playbooks themselves, and packages/control/ansible/README.md is the map:
                        why SSH and not WinRM, why the fleet is defined once in inventory.yml
```

Exports two entry points other packages import: `./fleet-playbook` and `./lab-pipeline`.

## Reaching the control plane itself

`fleet-playbook.mjs` and `lab-pipeline.mjs` both SSH into the control-plane machine to run Ansible there —
that machine holds the fleet key, so the command has to run on it rather than merely be issued from
wherever you are. Two variables name that connection, each with a default baked in for this
deployment's own control host:

- `A11Y_CONTROL_HOST` — the control plane's address.
- `A11Y_PVE_KEY` — the SSH private key used to reach it. Defaults to a key under `~/.ssh/`.

Both are overridable, and both are deliberately undocumented **as specific values** anywhere public: this
repo is meant to be generic, and one deployment's control-host address and key filename are not the
project's — the same reason the tailnet ACL and `*.local.yml` are gitignored. If you are standing up your
own control plane, set both to point at it; if you are working in this checkout against an existing one,
you already have — or need to be given — the values, and they do not belong in git.
