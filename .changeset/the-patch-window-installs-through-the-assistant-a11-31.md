---
"@a11ign/control": patch
---

`ansible/patch.yml` moves a box across a Windows release through Microsoft's Installation Assistant (A11-31): a box whose `CurrentBuild` is below the target's has the Assistant fetched and its signature checked, runs it detached, waits for Setup's own `SetupPhasePostFinalize`, and is restarted once by the play's `win_reboot`. `win_updates` no longer asks for `Upgrades` (it marks the update installed without running Setup), and `UsoClient.exe StartInstall`, the BCD wait, the `staged but not switched` refusal, the pre-download and the 7200 s restart guess are removed. The restart carries its own `timeout`. A pass with no target, or a box on the target's release, is unchanged. Proven live on 11 boxes by the same route run from a scratch play; the edited `patch.yml` itself is proven on worker 14 (see the PR).
