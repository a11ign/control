---
"@a11ign/control": patch
---

`src/fleet-layer/` no longer exists (a11ign/a11ign#5345, step 2 of ruling B on #5335). Its tests that read control's own files live in `src/control-owned/`, a sibling, so every `../..` read keeps its depth; the ones whose destination had merged (a11ign/screenreader-fleet #41, a11ign/lab #105, core #5357) are deleted from control rather than kept as a second copy. Four worker-text tests, the doctor `LIVE` judge-package test and the worker-index half of `no-win32-imports` have no merged destination and stay in `src/control-owned/` until their owner rows land.
