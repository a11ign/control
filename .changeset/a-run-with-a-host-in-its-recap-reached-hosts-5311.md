---
"@a11ign/control": patch
---

`deployedToNothing` no longer calls a run that reached no hosts when the PLAY RECAP shows a host that ran tasks (`ok=<n>`, n above 0): `patch.yml --limit a11y-worker-12` finished `ok=18 failed=0` and the wrapper exited 5 because the log also carried the absent in-tree inventory's `Unable to parse` warning and a `skipping: no hosts matched`, which also left the completed patch window unrecorded (a11ign/a11ign#5311). A log with those signatures and no ran host in the recap is still refused (`src/fleet-playbook.ts`, `src/deploy-reached-no-hosts.test.ts`).
