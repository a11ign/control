---
"@a11ign/control": patch
---

`fleet-watch` no longer exits QUIET when the control host's auto-off refusal could not be read (a11ign/a11ign#4734, #4714's shape one reader over). `readRefusalOrSay` answers a refusal, `null` (read, refused nothing) or `UNREAD`, and `exitCodeFor` makes an unread refusal `CANNOT_ASK` unless something else is ATTENTION.
