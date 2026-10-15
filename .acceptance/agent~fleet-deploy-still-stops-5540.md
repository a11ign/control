Acceptance:
```
cd ~/repos/control && node --import tsx --input-type=module -e 'const m = await import("./src/layer-checkouts.ts"); process.stdout.write(await m.layerCodeVersion("nvda-worker"))'
```
Exits 0 in a checkout holding the layer only as node_modules/@a11ign/screenreader-worker and prints the release's codeVersion(); a checked-out layer is hashed from src/ as before; a layer with neither refuses naming both. Pinned by three `#5540` tests in src/layer-checkouts.test.ts.
