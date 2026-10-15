Hand-run: the claimer, in ~/repos/control, because the loader there is tsx and this host's node has no type stripping. It exits 0 in a checkout holding the layer only as node_modules/@a11ign/screenreader-worker and prints the release's codeVersion(); a checked-out layer is hashed from src/ as before; a layer with neither refuses naming both (three `#5540` tests in src/layer-checkouts.test.ts).

Acceptance:
```
cd ~/repos/control && node --import tsx --input-type=module -e 'const m = await import("./src/layer-checkouts.ts"); process.stdout.write(await m.layerCodeVersion("nvda-worker"))'
```

Mutation: none -- not run; the three cases were exercised by a standalone script, no mutant was broken.
