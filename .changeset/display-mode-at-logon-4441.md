---
"@a11ign/control": patch
---

#4441: the display mode is re-asserted and read back at every logon. `tasks.yml` registers `a11y-display-mode-logon`, a logon-triggered `interactive_token` task that runs `set-display-mode.ps1` with `worker_display_mode`'s width and height and exits with the read-back's verdict; `display.yml`'s provision-time task is unchanged, and the report task prints the new task's registration.
