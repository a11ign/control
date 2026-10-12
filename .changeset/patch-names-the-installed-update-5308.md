---
"@a11ign/control": patch
---

`patch.yml` names each update it installed, by title and KB, after the install (a11ign/a11ign#5308, #4405 item 1): a feature update printed only as a count of "1" could not be told from a cumulative update. No task is added to the install, the switch or the reboot; the new task is a `debug` loop over the installed entries of `win_updates`' `updates`, and prints nothing when none installed.
