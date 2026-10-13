---
"@a11ign/control": patch
---

Control's Region test files take the screenreader-fleet originals from `@a11ign/screenreader-fleet` package exports instead of `../../worker-fleet/src/`, and the package is a pinned devDependency at 0.9.0. The carried copy keeps the reading the old pin carries; the `edgeUpdaterGuard.state` re-carry (a11ign/a11ign#5021) returns with the pin bump (a11ign/a11ign#5312). The display-mode runtime harness and the `.ps1` reads are gone: no published tarball ships the harness, and the stamp test reads the script from the package. One reference remains: `protocol-guard` is imported by path in `fleet-playbook.test.ts`, blocked on the pin bump to 0.11.0 (a11ign/a11ign#5312).
