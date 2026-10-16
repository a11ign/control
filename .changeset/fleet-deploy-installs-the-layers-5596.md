---
"@a11ign/control": patch
---

`fleet:deploy` installs the plane's locked layers itself when `node_modules/` lags a merged pin (a11ign/control#5596, after #5155 and #5556): where the plane's lockfile declares the released layer and `node_modules/` holds the release before it, the play runs `pnpm install --frozen-lockfile` in the plane's checkout once, says so on stdout, reads again, and refuses if the layers still disagree. Every other lag stays a refusal or a note: no release installed, a lockfile that names none, and a plane whose own lockfile is behind the declaration (`src/layer-checkouts.ts`, `src/fleet-playbook.ts`).
