---
"@a11ign/control": patch
---

A fleet play refused for a failed hold read names the cause (a11ign/a11ign#5586): when `agent-org gate-snapshot-read` fails, the refusal quotes the child's first non-empty stderr line with its exit status (cut at 200 characters and marked), instead of Node's `Node.js v24.21.0` footer. The refusal still refuses; a read that succeeds, or prints unparseable stdout, is unchanged (`src/fleet-playbook.ts`).
