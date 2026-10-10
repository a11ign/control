---
"@a11ign/control": patch
---

Control imports the lab gate by its new name (a11ign/a11ign#4786, step 3 of #4519): `src/post-qualification-status.ts` names `../../lab/src/gates/qualification-status.ts` in its import and in its two `Outcome` / `StatusPayload` type references, where it named `.mjs`. A control tree is now only as good as the lab laid beside it: it needs a core whose `layers.json` pins `lab` at v0.1.27 or later (the release whose `src/gates/` holds the `.ts`), and `ci.yml`'s `CORE_REF` moves to the merge of a11ign/a11ign#4803, which pins v0.1.27 (it named a core that lays v0.1.24, which holds only the `.mjs`). The tag this change makes is the one a11ign/a11ign#4787 pins.
