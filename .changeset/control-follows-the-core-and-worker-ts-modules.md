---
"@a11ign/control": patch
---

#4575: control follows the core and the nvda-worker layer to their `.ts` modules. `layer-checkouts.ts`'s `layerCodeVersion` imports the layer's `code-version.ts` (it imported `code-version.mjs`, which no current `screenreader-worker` tag holds, so every `layerCodeVersion("nvda-worker")` threw), and `lab-job.ts` documents the same name. CI lays this package over a11ign at `f3b5c5f59` (after the core's install, whose `prepare` re-lays the pinned tag; `git add -f`, because the core now gitignores `/packages/control`; linted with `--no-ignore` and typechecked with `"exclude": []`, because the core excludes it from both).
