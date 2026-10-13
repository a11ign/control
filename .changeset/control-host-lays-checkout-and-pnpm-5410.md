---
"@a11ign/control": patch
---

The control-host install playbook (`ansible/control-host-install.yml`) also lays control's own checkout at `/root/control` from `origin/main`, the pnpm that control's `packageManager` field pins (refusing anything but an exact version), and control's production dependencies from the lockfile alone (`pnpm install --frozen-lockfile --ignore-scripts --prod`), so a rebuilt control plane has the working directory and pnpm its units name (a11ign/a11ign#5410, a11ign/a11ign#5306). The loader assertion still runs last and installs nothing. Revert: delete the checkout, pin-read, pin-assert, corepack and install tasks and the `control_repo_url` and `control_checkout` vars; the playbook then lays only the host value again.
