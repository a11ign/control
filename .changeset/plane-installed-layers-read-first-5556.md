---
"@a11ign/control": patch
---

A fleet write reads the control plane's installed layers before it moves the plane (a11ign/a11ign#5556). A merged pin bump reaches the plane's checkout by `git merge --ff-only` and nothing installs afterwards, so its `node_modules/` could hold `@a11ign/screenreader-worker@0.13.0` under a lockfile resolving `0.13.1`, and the move's own layer judgement refused only after the merge, spending the first write of a covered run. The command now asks first, read-only, and refuses with exit 2 naming the installed release, the one the plane's lockfile resolves and the one `deploy-pins.json` declares, with `pnpm install --frozen-lockfile` in `/root/control` as the remedy. That install is a write to the control plane and is not made by this change. A plane whose own lockfile is behind the declaration is a note and not a refusal, because the move is what brings it forward.
