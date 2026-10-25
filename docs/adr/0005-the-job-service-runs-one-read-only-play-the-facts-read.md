# The fleet job service runs one read-only Ansible play: the facts read

---
Status: proposed (A11-283, written by an unattended planning run and not yet agreed by a person)
---

**Context.** Until now the job service only sent each worker's own `/capture`, and "changes nothing on any box". A box's hardware cannot be read over the worker's HTTP. Every read a box allows outside `/capture` is an Ansible play over SSH. A hand-run play is outside booking, so it can land in the middle of a capture.

**Decision.** The service gets one job kind, `facts`, which runs `ansible/facts.yml --limit <box>` from the service's own checkout under the box's `capture` lease. It writes `/etc/a11ign/fleet-facts.json` beside the inventory, and the service is that file's only writer. The play is held read-only three ways:

1. a static test of its modules and `changed_when` (`src/fleet-facts/facts-play.test.ts`);
2. the runner's assertion that the JSON callback's `changed` is 0 for the box;
3. the script's own `$Ansible.Changed = $false`.

**Why.** Booking is the only thing that keeps two takers off one box (ADR 0003), and the board already wakes an agent on a job ID. A separate unit or script would need its own booking and its own wake. Letting the service run plays in general would give a long-lived root process a write path to the fleet. Allowing one named, asserted read-only play keeps the service's promise to change nothing on any box.

**Consequences.** A second play the service runs needs its own ADR. The service's environment must resolve `ansible-playbook` and `~/.ansible/collections`, so `read.ts` defaults `HOME` to `/root`. The play runs with the JSON stdout callback and the `profile_tasks` callback off, because the config enables that one and it prints after the JSON document.
