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
