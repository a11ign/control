Hand-run: the claimer, from this branch's checkout, with `root` pointing at ~/repos/control, which holds the layer only as node_modules/@a11ign/screenreader-worker (no packages/nvda-worker). It prints the release's codeVersion(), 16 hex characters (dbe7c8cf55f930ba for 0.13.0). A checked-out layer is hashed from src/ as before and a layer with neither refuses naming both (three `#5540` tests in src/layer-checkouts.test.ts).

Acceptance:
```
node --input-type=module -e 'const m = await import("./src/layer-checkouts.ts"); const r = m.layersFrom({ manifest: m.manifestOf((await import("./src/layer-pins.ts")).readDeployPins()), root: process.env.HOME + "/repos/control" }); process.stdout.write(await r.layerCodeVersion("nvda-worker"))'
```

Mutation: none -- not run; the three cases were exercised by a standalone script, no mutant was broken.
