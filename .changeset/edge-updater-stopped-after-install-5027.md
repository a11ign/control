---
"@a11ign/control": patch
---

The worker role stops and disables the Edge updater again after the Edge install and before its closing refusal (a11ign/a11ign#4948, #4405). The first provision over a box that installs Edge used to end `failed=1` at "Refuse to call this provisioned unless Edge is the pinned build and the updater is off": the installer re-registers `MicrosoftEdgeUpdateTaskMachineCore` and `MicrosoftEdgeUpdateTaskMachineUA` as it runs, after the early stop. The early pair stays before the install (a11ign#4732). Revert: delete the late pair from `edge-version.yml`; the role then reads as it does today.
