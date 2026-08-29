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

test("NOTHING IS IMPORTED BY PACKAGE NAME, TRANSITIVELY — one hop is not a boundary", () => {
  // The failure prose would miss: a package-name import works on a laptop and CRASHES on the control
  // plane. `../../worker-fleet/src/cli-flags.mjs` resolves from a raw checkout; the export path does not.
  //
  // TRANSITIVE, and that was learned by breaking it. This test checked only `packages/control`'s OWN
  // imports, so when `fleet-playbook.mjs` began importing `check-worker-code.mjs` BY PATH — which passes
  // a one-hop check — it dragged in that file's `@a11y-witness/nvda-worker` import and `fleet:deploy`
  // died on the control plane with ERR_MODULE_NOT_FOUND. It passed here the whole time, because a laptop
  // has node_modules. A gate that does not exercise what ships is not a gate, for the fifth time in this
  // repo; the honest fix is to follow the graph, not to check the first hop and trust the rest.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const offenders: string[] = [];
  const seen = new Set<string>();
  /** Every module reachable from packages/control, following relative imports across package boundaries. */
  const walk = (fileUrl: URL, via: string[]): void => {
    const key = fileUrl.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    let source: string;
    try { source = strip(readFileSync(fileUrl, "utf8")); } catch { return; }
    for (const [, spec] of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) {
        offenders.push(`${[...via, key.split("/").slice(-1)[0]].join(" -> ")} imports "${spec}"`);
        continue;
      }
      walk(new URL(spec, fileUrl), [...via, key.split("/").slice(-1)[0]]);
    }
  };
  for (const file of modules()) walk(new URL(file, import.meta.url), []);
  assert.deepEqual(offenders, [],
    "the control plane runs from a raw git checkout with no `npm install`, so every import REACHABLE from "
    + "it must resolve without one: node: builtins and relative paths only. The chain is shown.");
  assert.ok(seen.size > modules().length,
    `the walk followed no imports at all (${seen.size} files from ${modules().length} entry points), so it `
    + "is examining only the entry modules and the transitive claim is unproven");
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  // The count assertion this repo puts on every discovery walk. An empty set would satisfy both tests
  // above in perfect silence — which is how a guarantee becomes a comment.
  assert.ok(modules().length >= 2,
    `only found ${modules().length} module(s) in packages/control; the walk is broken, not the package clean`);
});
