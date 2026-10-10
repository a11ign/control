---
"@a11ign/control": patch
---

`fleet:deploy`'s protocol guard reads `src/protocol-version.ts`, the name `screenreader-worker` v0.9.0 ships, and still accepts `protocol-version.mjs` for older layer tags (#4708). It refused "the worker layer is not checked out" with a full clone present.
