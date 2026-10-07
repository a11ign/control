---
"control-workspace": patch
---

`lab:job --qualify-sha` refuses a `gate-stability` launch with no `-e worker=<n>` BEFORE `pending` is posted, so a launch the playbook would refuse leaves no `qualification` status on the sha (a stray `failure` stays counted by the release's regression read, #3988).
