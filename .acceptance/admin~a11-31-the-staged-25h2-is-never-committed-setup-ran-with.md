A11-31 (https://linear.app/a11ign/issue/A11-31/the-staged-25h2-is-never-committed-setup-ran-with-predownload-on). Two changes on this branch.

1. `ansible/collect-logs.yml` fetches Setup's Panther logs (`setupact.log`, `setuperr.log`) through Ansible, read-only on the guest.
2. `ansible/patch.yml` carries the route that switched the fleet: a box below the target's `CurrentBuild` runs Microsoft's Windows 11 Installation Assistant detached, waits for `SetupPhasePostFinalize` in Setup's own log (written after the launch), and is restarted once by `win_reboot`. The steps that did not work are removed: `win_updates` with `Upgrades`, `UsoClient.exe StartInstall`, the BCD wait, the `staged but not switched` refusal, the pre-download, and the plain restart with its 7200 s guess.

Acceptance:

```bash
node --test src/control-owned/patch-playbook.test.ts src/control-owned/patch-update-naming.test.ts src/fleet-patch.test.ts src/collect-logs-setup.test.ts
```

**What the block shows:** the route's order (space, fetch with the signature check, detached launch, wait on Setup's log, close the connection, one restart), that the removed steps stay removed (no `UsoClient`, `bcdedit`, `Upgrades`, `downloaded`), and, through the real `ansible-playbook` templating, that a box below the target's `CurrentBuild` takes the route, a box on it or above it, an unreadable box, or a run with no target does not, and that the restart fires for a feature pass or an install Windows asked a restart for, and for nothing else. It cannot show that Setup commits on a real box; the live readings below do.

**Live readings (2026-10-18, A11-31 on Linear):** 11 of 13 boxes switched by this route run from scratch plays (workers 2, 3, 4, 7, 8, 9, 10, 12, 13, 15, 16; worker 6 earlier, restarted by a different step), each read back at `26300.9711`, policy restored, smoke-captured. The edited `patch.yml` itself is run once on worker 14: its reading is in the PR body.

Refs A11-31 (not closed until the proof below is posted)
