# The lab submits fleet jobs through a forced-command key on the control plane

---
Status: proposed (A11-263, written by an unattended planning run and not yet agreed by a person)
---

Lab's capture clients run on the lab (CT 121, under `lab:job`), and they must now submit their captures to the fleet job service on the control plane (CT 120), because A11-242 makes the service the one booked path to the boxes. The `fleet` CLI reaches the service over SSH as `root@<control plane>` (control's ADR 0002), and ADR 0012 keeps every key that can reach the control plane off the lab. We give the lab its own key, made on the lab and never copied off it. The control plane accepts that key only with `restrict,command="… src/fleet-jobs/gate.ts"`. The gate runs `remote.ts` with the arguments `controlPlaneTransport` sends, and refuses every other command.

This narrows ADR 0012 rather than reversing it. The lab still holds no fleet key, and it still cannot provision, deploy, sleep or reconfigure a box. The only new thing it can do is submit, follow, cancel and fetch capture jobs. That is less than it does today, when it POSTs `/capture` to every box directly with nothing booking them.

We rejected three other ways. An HTTP job API on the control plane would be a new listening port next to the fleet key, with no authentication scheme behind it (control ADR 0002). Running the lab's clients on the agents host would put them away from the corpus and the page server they lease. Handing the submit back to the agent would split every lab pipeline (capture, then export, then train) across agent turns.

## Consequences

- When the control plane is down, a lab capture cannot start. ADR 0012 named this failure mode and accepted the lab's independence instead. A11-242 overrides that for capture: an unbooked capture is how A11-229 and A11-230 shared boxes.
- The key is installed, read back and rotated by one Ansible play (`ansible/fleet-jobs-lab-access.yml`), from the control repository like every other change to these machines.

## Paths

- `control:src/fleet-jobs/gate.ts`
- `control:src/fleet-jobs/gate.test.ts`
- `control:ansible/fleet-jobs-lab-access.yml`
- `control:docs/adr/0004-the-lab-submits-fleet-jobs-through-a-forced-command-key.md`
