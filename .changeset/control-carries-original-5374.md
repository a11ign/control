---
"@a11ign/control": patch
---

Six control test files (`worker-fleet-carried`, `display-mode`, `fleet-consistency`, `fleet-env`, `worker-port`, `fleet-playbook`) now take the screenreader-fleet originals from `@a11ign/screenreader-fleet` package exports instead of `../../worker-fleet/src/`, and the package is a pinned devDependency at 0.9.0. The carried copy reads dotted paths and reports `edgeUpdaterGuard.state` (a11ign/a11ign#5021). Two references in these files remain and are blocked on a ruling (a11ign/a11ign#5374): the display-mode harness, which no published tarball ships, and the protocol guard, which the 0.9.0 pin does not export.
