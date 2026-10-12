---
"@a11ign/control": patch
---

`patch.yml` downloads the feature update before the install on a target pass (a11ign/a11ign#5314): a box with nothing staged used to meet the update at the install, where WUA failed the download with HRESULT 0 and left nothing for a switch to commit. The new `win_updates` task is `state: downloaded` on the Upgrades category alone, and a verdict fails the box by name when that pre-download failed, quoting WUA's own `Download result` lines from the module's log. A pre-download that did not fail, including one that finds the update already downloaded, passes through unchanged, and `--check` runs neither task.
