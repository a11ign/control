---
"@a11ign/control": patch
---

`fleet:provision` (and every playbook that pins layers) no longer refuses in the control plane's remote sync for a layer control holds as a published dependency (a11ign/a11ign#5445). `layerMoveShell` ended in a refusal naming `/root/control/packages/<path>`, a directory the plane's plain clone (a11ign/a11ign#5312) never holds, so the sync stopped before the playbook on `nvda-worker` and `screenreader-fleet`. A layer whose `deploy-pins.json` entry declares a `package` and `version` is now judged by the release installed under `node_modules/<package>/`: accepted when `package.json` names the declared version, refused (exit 4) naming the layer, the release and what the directory holds when it does not or when nothing is installed. A clone and a laid tree are moved and judged as before, and a layer declaring no release still refuses.
