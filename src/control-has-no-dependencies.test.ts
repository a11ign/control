/**
 * THE CONTROL PLANE DECLARES NO DEPENDENCY BUT THE TWO PUBLISHED LAYERS, AND IMPORTS NOTHING ELSE BY PACKAGE NAME.
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
 * ADR 0045 (cut 9) moved the line. Control no longer keeps a copy of the fleet beside its own
 * tree: it DECLARES the two published layers at the versions `deploy-pins.json` pins, and `pnpm install` brings them
 * with the lockfile. So the guarantee is now three things, each asserted here:
 *
 *   - the declared dependencies are exactly those two packages at their pinned versions, and nothing else is declared
 *   - no module imports by package name anything but those two (and their subpaths); the walk follows relative
 *     imports across package boundaries, so a copy reached by a relative path is held to the same rule
 *   - the production closure those two bring is pinned by name and version, so a transitive move is a reviewed
 *     diff in this file rather than a surprise on the control plane
 *
 * The second is the one prose would miss: a package-name import of anything undeclared resolves on a laptop and
 * crashes on the control plane, because the resolution goes through `node_modules` that the plane does not hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const PINS: { layers: Record<string, { package: string, version: string }> } = JSON.parse(readFileSync(new URL("../deploy-pins.json", import.meta.url), "utf8"));
const LOCK = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

/** Every module in this package, so a new one cannot arrive unguarded. */
const modules = () => readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

/** The two published layers, by package name: the only names this package may declare or import. */
const LAYER_PACKAGES = Object.values(PINS.layers).map((layer: { package: string }) => layer.package);

const isLayerImport = (spec: string) => LAYER_PACKAGES.some((name) => spec === name || spec.startsWith(`${name}/`));

/** Files the walk was pointed at and could not read: a relative import that does not resolve in this checkout. Filled by the walk test. */
const unresolved: string[] = [];

test("THE DECLARED DEPENDENCIES ARE THE TWO PUBLISHED LAYERS, AT THE VERSIONS deploy-pins.json PINS", () => {
  // `../package.json` is the manifest CI LAYS at `packages/control` (`ci.yml` cuts it from the repository root's, keeping
  // `dependencies` verbatim and dropping `devDependencies`, which the core's frozen lockfile cannot hold). So the
  // `devDependencies` half of this guard cannot run here and runs in `scripts/package-manifest.test.ts` against the
  // real root manifest (a11ign/a11ign#4217).
  const pinned = Object.fromEntries(Object.values(PINS.layers).map((layer: { package: string, version: string }) => [layer.package, layer.version]));
  assert.equal(Object.keys(pinned).length, 2, "positive control: deploy-pins.json declares the two layers this package may depend on");
  assert.deepEqual(PKG.dependencies, pinned,
    "packages/control declares a dependency that is not one of the two published layers at its pin. A copy of anything else "
    + "beside the key is what ADR 0012 forbids, and a layer's version moves in deploy-pins.json as well as here.");
});

test("NOTHING BUT THE TWO LAYERS IS IMPORTED BY PACKAGE NAME, TRANSITIVELY — one hop is not a boundary", () => {
  // The failure prose would miss: a package-name import works on a laptop and CRASHES on the control plane when the
  // package is not installed there. The layers are installed there now, from the lockfile, so they may be imported;
  // nothing else may.
  //
  // TRANSITIVE, and that was learned by breaking it. This test checked only `packages/control`'s OWN imports, so when
  // `fleet-playbook.ts` began importing `check-worker-code.mjs` BY PATH — which passes a one-hop check — it dragged in
  // that file's `@a11ign/screenreader-worker` import and `fleet:deploy` died on the control plane with
  // ERR_MODULE_NOT_FOUND. It passed here the whole time, because a laptop has node_modules. A gate that does not
  // exercise what ships is not a gate, for the fifth time in this repo; the honest fix is to follow the graph.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const offenders: string[] = [];
  const layerImports = new Set<string>();
  unresolved.length = 0;
  const seen = new Set<string>();
  /** Every module reachable from packages/control, following relative imports across package boundaries. */
  const walk = (fileUrl: URL, via: string[]): void => {
    const key = fileUrl.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    let source: string;
    try { source = strip(readFileSync(fileUrl, "utf8")); } catch { unresolved.push(key); return; }
    for (const [, spec] of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      if (spec.startsWith("node:")) continue;
      if (isLayerImport(spec)) { layerImports.add(spec); continue; }
      if (!spec.startsWith(".")) {
        offenders.push(`${[...via, key.split("/").slice(-1)[0]].join(" -> ")} imports "${spec}"`);
        continue;
      }
      walk(new URL(spec, fileUrl), [...via, key.split("/").slice(-1)[0]]);
    }
  };
  for (const file of modules()) walk(new URL(file, import.meta.url), []);
  assert.deepEqual(offenders, [],
    "the control plane imports by package name only its two declared layers, so every import REACHABLE from it must resolve "
    + "from its lockfile: node: builtins, relative paths, and those two packages. The chain is shown.");
  assert.ok(layerImports.has("@a11ign/screenreader-fleet/git-safe-env"),
    "positive control: the walk reaches the fleet imports the auto-off program makes, so the empty list above is not an empty walk");
  assert.ok(seen.size > modules().length,
    `the walk followed no imports at all (${seen.size} files from ${modules().length} entry points), so it `
    + "is examining only the entry modules and the transitive claim is unproven");
});

test("every relative import the walk reaches resolves in THIS checkout (the gap is named, not hidden)", { todo: "13 imports in 7 modules (fleet-playbook, lab-pipeline, lab-job, fleet-converge, qualification-run, post-qualification-status, lab-failed-units) reach ../../worker-fleet/, which resolves only beside a sibling checkout. A raw control checkout has no such path, so the walk skips it and these crash there. Fixed by the next row that moves them to the published package subpaths." }, () => {
  // The walk above skips a target it cannot read, so an unresolved relative import is invisible to it. Here it is a
  // todo: visible in every run, not a failure, because the seven modules are outside this row's region.
  assert.deepEqual(unresolved, []);
});

const unquote = (s: string) => s.replace(/^'|'$/g, "");

/** The lines under a top-level key of the lockfile (`importers:`, `snapshots:`), up to the next top-level key. */
function topLevel(lines: string[], key: string): string[] {
  const start = lines.indexOf(`${key}:`) + 1;
  const next = lines.findIndex((line, i) => i >= start && /^\S/.test(line));
  return lines.slice(start, next === -1 ? lines.length : next);
}

/** The importer's `dependencies:` (not `devDependencies:`): name -> the version the lock resolved it to, peer suffix and all. */
function importerDependencies(importers: string[]): Map<string, string> {
  const start = importers.indexOf("    dependencies:") + 1;
  const end = importers.indexOf("    devDependencies:");
  const resolved = new Map<string, string>();
  for (let i = start; i < end; i++) {
    const name = importers[i].match(/^ {6}(\S+):$/)?.[1];
    if (name) resolved.set(unquote(name), importers[i + 2].replace(/^\s+version: /, ""));
  }
  return resolved;
}

/** Each snapshot key -> the `name@version` it depends on, `optionalDependencies:` included (they install unless they fail). */
function snapshotEdges(snapshots: string[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  let key: string | null = null;
  for (const line of snapshots) {
    const header = line.match(/^ {2}(\S.*?):( \{\})?$/);
    if (header) { key = unquote(header[1]); edges.set(key, []); continue; }
    const dep = line.match(/^ {6}(\S+): (\S+)$/);
    if (key && dep) edges.get(key)!.push(`${unquote(dep[1])}@${dep[2]}`);
  }
  return edges;
}

/** Every package the lock reaches from the importer's production dependencies, peer suffixes dropped, sorted. */
function productionClosure(lock: string): string[] {
  const lines = lock.split("\n");
  const edges = snapshotEdges(topLevel(lines, "snapshots"));
  const roots = [...importerDependencies(topLevel(lines, "importers"))].map(([name, version]) => `${name}@${version}`);
  const reached = new Set<string>();
  const visit = (key: string): void => {
    if (reached.has(key)) return;
    reached.add(key);
    for (const next of edges.get(key) ?? []) visit(next);
  };
  roots.forEach(visit);
  return [...new Set([...reached].map((key) => key.replace(/\(.*$/, "")))].sort();
}

/**
 * The production closure as `pnpm-lock.yaml` held it when the layers were declared here (a11ign/a11ign#5312): everything
 * `pnpm install --prod` brings to the control plane for the two layers. Moving one is a change to this list, reviewed.
 */
const PRODUCTION_CLOSURE = [
    "@a11ign/evidence@0.3.2", "@a11ign/judge@0.5.1", "@a11ign/scorer@0.3.3", "@a11ign/screenreader-fleet@0.10.2",
    "@a11ign/screenreader-worker@0.13.0", "@a11ign/screenreader-worker@0.9.0", "@a11ign/toolchain@0.5.0",
    "@emnapi/core@1.11.3", "@emnapi/runtime@1.11.3", "@emnapi/wasi-threads@1.2.3", "@guidepup/guidepup@0.31.0",
    "@napi-rs/wasm-runtime@1.1.6", "@rsbuild/core@2.2.12", "@rspack/binding-darwin-arm64@2.2.8",
    "@rspack/binding-darwin-x64@2.2.8", "@rspack/binding-linux-arm64-gnu@2.2.8",
    "@rspack/binding-linux-arm64-musl@2.2.8", "@rspack/binding-linux-ppc64-gnu@2.2.8",
    "@rspack/binding-linux-riscv64-gnu@2.2.8", "@rspack/binding-linux-riscv64-musl@2.2.8",
    "@rspack/binding-linux-s390x-gnu@2.2.8", "@rspack/binding-linux-x64-gnu@2.2.8",
    "@rspack/binding-linux-x64-musl@2.2.8", "@rspack/binding-wasm32-wasi@2.2.8",
    "@rspack/binding-win32-arm64-msvc@2.2.8", "@rspack/binding-win32-ia32-msvc@2.2.8",
    "@rspack/binding-win32-x64-msvc@2.2.8", "@rspack/binding@2.2.8", "@rspack/core@2.2.8", "@rstest/core@0.12.3",
    "@swc/helpers@0.5.23", "@tybys/wasm-util@0.10.4", "@types/chai@5.2.3", "@types/deep-eql@4.0.2",
    "@typescript/typescript-aix-ppc64@7.0.2", "@typescript/typescript-darwin-arm64@7.0.2",
    "@typescript/typescript-darwin-x64@7.0.2", "@typescript/typescript-freebsd-arm64@7.0.2",
    "@typescript/typescript-freebsd-x64@7.0.2", "@typescript/typescript-linux-arm64@7.0.2",
    "@typescript/typescript-linux-arm@7.0.2", "@typescript/typescript-linux-loong64@7.0.2",
    "@typescript/typescript-linux-mips64el@7.0.2", "@typescript/typescript-linux-ppc64@7.0.2",
    "@typescript/typescript-linux-riscv64@7.0.2", "@typescript/typescript-linux-s390x@7.0.2",
    "@typescript/typescript-linux-x64@7.0.2", "@typescript/typescript-netbsd-arm64@7.0.2",
    "@typescript/typescript-netbsd-x64@7.0.2", "@typescript/typescript-openbsd-arm64@7.0.2",
    "@typescript/typescript-openbsd-x64@7.0.2", "@typescript/typescript-sunos-x64@7.0.2",
    "@typescript/typescript-win32-arm64@7.0.2", "@typescript/typescript-win32-x64@7.0.2", "@xmldom/xmldom@0.9.12",
    "assertion-error@2.0.1", "cjs-module-lexer@2.3.0", "plist@4.0.0", "tslib@2.8.1", "typescript@7.0.2",
    "xmlbuilder@15.1.1",
];

test("THE PRODUCTION CLOSURE OF THE TWO LAYERS IS PINNED, NAME AND VERSION, IN THE LOCKFILE THIS PACKAGE INSTALLS FROM", () => {
  const closure = productionClosure(LOCK);
  assert.ok(closure.includes("@guidepup/guidepup@0.31.0") && closure.length > LAYER_PACKAGES.length,
    "positive control: the walk reaches what the layers depend on, not only the two layers, so the pin below is not a closure of two");
  assert.deepEqual(closure, PRODUCTION_CLOSURE,
    "the lockfile's production closure for the two layers moved. Every name here reaches the control plane; review the change, "
    + "then update this list in the same pull request.");
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  // The count assertion this repo puts on every discovery walk. An empty set would satisfy the tests
  // above in perfect silence — which is how a guarantee becomes a comment.
  assert.ok(modules().length >= 2,
    `only found ${modules().length} module(s) in packages/control; the walk is broken, not the package clean`);
});
