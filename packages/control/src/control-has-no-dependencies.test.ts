/**
 * THE CONTROL PLANE RUNS FROM A RAW GIT CHECKOUT, WITH NO `npm install`.
 *
 * ADR 0012's argument is not tidiness: *"the credential able to reconfigure the entire fleet would sit next
 * to the largest supply-chain surface in the system. A compromised transitive dependency in the capture
 * pipeline could reach the SSH key and, from there, twelve Windows boxes that auto-log-in to unlocked
 * desktops."*
 *
 * It made that claim in prose, and on 2026-08-29 it was found VIOLATED ON BOTH MACHINES IT DESCRIBES — 56 MB
 * and 121 packages beside the key on the control plane, and 103 MB beside a second key on the operator's
 * laptop. The document was accurate about the intent and described a system that did not exist, which is
 * worse than no document because it is read as a guarantee.
 *
 * So the guarantee is a test. Two things follow from "no `node_modules`", and both are asserted here:
 *
 *   - no third-party dependency may be DECLARED, because installing one is what puts the surface there
 *   - no module may be IMPORTED BY PACKAGE NAME, because that resolution goes through `node_modules` and
 *     would simply fail on the machine this package exists to run on
 *
 * The second is the one prose would miss. `@a11y-witness/worker-fleet/cli-flags` looks harmless and is not:
 * it works on a laptop, and on the control plane it is a crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Every module in this package, so a new one cannot arrive unguarded. */
const modules = () => readdirSync(HERE).filter((f) => f.endsWith(".mjs"));

test("NO THIRD-PARTY DEPENDENCIES ARE DECLARED — the whole reason this package is separate", () => {
  for (const field of ["dependencies", "devDependencies"] as const) {
    assert.deepEqual(PKG[field] ?? {}, {},
      `packages/control declares ${field}. Installing one puts npm's transitive surface beside the key `
      + "that reconfigures twelve auto-logging-in Windows boxes — which is exactly what ADR 0012 forbids "
      + "and exactly what was found on that machine.");
  }
});

test("NOTHING IS IMPORTED BY PACKAGE NAME, because that needs node_modules and there is none", () => {
  // The failure prose would miss: a package-name import works on a laptop and CRASHES on the control
  // plane. `../../worker-fleet/src/cli-flags.mjs` resolves from a raw checkout; the export path does not.
  const offenders: string[] = [];
  for (const file of modules()) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [, spec] of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (spec.startsWith("node:") || spec.startsWith(".")) continue;
      offenders.push(`${file} imports "${spec}"`);
    }
  }
  assert.deepEqual(offenders, [],
    "the control plane runs from a raw git checkout with no `npm install`, so every import must resolve "
    + "without one: node: builtins and RELATIVE paths only");
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  // The count assertion this repo puts on every discovery walk. An empty set would satisfy both tests
  // above in perfect silence — which is how a guarantee becomes a comment.
  assert.ok(modules().length >= 2,
    `only found ${modules().length} module(s) in packages/control; the walk is broken, not the package clean`);
});
