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
 *   - the production closure those two bring holds only `@a11ign/` packages and third-party NAMES listed in this file,
 *     and nothing dev-only (a test runner, bundler, compiler, linter), so a new name beside the key is a reviewed
 *     diff in this file rather than a surprise on the control plane. Versions are not listed: a patch or minor
 *     update, including Dependabot's, passes
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
  let followed = 0;
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
      followed += 1;
      walk(new URL(spec, fileUrl), [...via, key.split("/").slice(-1)[0]]);
    }
  };
  for (const file of modules()) walk(new URL(file, import.meta.url), []);
  assert.deepEqual(offenders, [],
    "the control plane imports by package name only its two declared layers, so every import REACHABLE from it must resolve "
    + "from its lockfile: node: builtins, relative paths, and those two packages. The chain is shown.");
  assert.ok(layerImports.has("@a11ign/screenreader-fleet/git-safe-env"),
    "positive control: the walk reaches the fleet imports the auto-off program makes, so the empty list above is not an empty walk");
  // Not `seen.size > modules().length`: every relative import now lands on another module of this directory (the
  // `../../worker-fleet/` ones that left it are the package imports above), so `seen` is exactly the entry set.
  assert.ok(followed > modules().length,
    `the walk followed ${followed} relative imports from ${modules().length} entry points, so it is examining `
    + "only the entry modules and the transitive claim is unproven");
});

test("every relative import the walk reaches resolves in THIS checkout", () => {
  // The walk above skips a target it cannot read, so an unresolved relative import would be invisible to it. This was a
  // todo while 13 imports in 7 modules reached `../../worker-fleet/`, which resolves only beside a sibling checkout
  // and crashed a raw one (a11ign/a11ign#5312 moved them to the published package's subpaths).
  assert.deepEqual(unresolved, []);
});

const unquote = (s: string) => s.replace(/^'|'$/g, "");

/** The lines under a top-level key of the lockfile (`importers:`, `snapshots:`), up to the next top-level key. */
function topLevel(lines: string[], key: string): string[] {
  const start = lines.indexOf(`${key}:`) + 1;
  const next = lines.findIndex((line, i) => i >= start && /^\S/.test(line));
  return lines.slice(start, next === -1 ? lines.length : next);
}

/** One dependency edge as the lockfile writes it: a name and the `version:` value it resolves to (a registry version with its peer suffix, or an alias, URL or `link:`). */
interface Edge { name: string, value: string }

/** The importer's `section:` (`dependencies:`, `optionalDependencies:` or `devDependencies:`), each dependency with the version the lock resolved it to, peer suffix and all. */
function importerSection(importers: string[], section: "dependencies" | "optionalDependencies" | "devDependencies"): Edge[] {
  const start = importers.indexOf(`    ${section}:`) + 1;
  const resolved: Edge[] = [];
  if (start === 0) return resolved;
  for (let i = start; i < importers.length && !/^ {4}\S/.test(importers[i]); i++) {
    const name = importers[i].match(/^ {6}(\S+):$/)?.[1];
    if (name) resolved.push({ name: unquote(name), value: importers[i + 2].replace(/^\s+version: /, "") });
  }
  return resolved;
}

/** Each snapshot key -> what it depends on, `optionalDependencies:` included (they install unless they fail). */
function snapshotEdges(snapshots: string[]): Map<string, Edge[]> {
  const edges = new Map<string, Edge[]>();
  let key: string | null = null;
  for (const line of snapshots) {
    const header = line.match(/^ {2}(\S.*?):( \{\})?$/);
    if (header) { key = unquote(header[1]); edges.set(key, []); continue; }
    const dep = line.match(/^ {6}(\S+): (\S+)$/);
    if (key && dep) edges.get(key)!.push({ name: unquote(dep[1]), value: dep[2] });
  }
  return edges;
}

/** A lockfile read as a graph: the production roots, the root's devDependency names, and every snapshot's edges. */
interface Lockfile { roots: Edge[], devNames: Set<string>, edges: Map<string, Edge[]> }

function parseLockfile(lock: string): Lockfile {
  const lines = lock.split("\n");
  const importers = topLevel(lines, "importers");
  return {
    roots: [...importerSection(importers, "dependencies"), ...importerSection(importers, "optionalDependencies")],
    devNames: new Set(importerSection(importers, "devDependencies").map((edge) => edge.name)),
    edges: snapshotEdges(topLevel(lines, "snapshots")),
  };
}

const keyOf = (edge: Edge) => `${edge.name}@${edge.value}`;

/** `@a11ign/judge@0.5.1(@a11ign/scorer@0.3.3)` -> `@a11ign/judge@0.5.1`: the peer suffix says which copy, not which package. */
const withoutPeers = (key: string) => key.replace(/\(.*$/, "");

/** A version the registry serves, with or without a peer suffix. An alias (`other@1.0.0`), a URL or a `link:` is a different package under this name. */
const REGISTRY_VALUE = /^\d+\.\d+\.\d+[^:\s(]*(\(.*)?$/;

interface Reach {
  /** Every package name the lock reaches, with the shortest chain of `name@version` that brings it (`a -> b -> c`). */
  chains: Map<string, string>;
  /** Edges that are not a registry version, so the name they are written under says nothing about the code. */
  foreign: string[];
}

/**
 * Walks the lock from the importer's production dependencies. An edge `skipEdge` names is not followed, so what is
 * reached only through it is absent from `chains`.
 */
function productionReach(lock: Lockfile, skipEdge: (from: string, to: string) => boolean = () => false): Reach {
  const reach: Reach = { chains: new Map(), foreign: [] };
  const seen = new Set<string>();
  const queue = lock.roots.map((edge): [Edge, string, string[]] => [edge, "", []]);
  for (let head = 0; head < queue.length; head++) {
    const [edge, from, via] = queue[head];
    const chain = [...via, withoutPeers(keyOf(edge))];
    if (skipEdge(from, edge.name)) continue;
    if (!REGISTRY_VALUE.test(edge.value)) { reach.foreign.push(`"${edge.name}" is brought in as "${edge.value}", not a registry version, via ${chain.join(" -> ")}.`); continue; }
    if (seen.has(keyOf(edge))) continue;
    seen.add(keyOf(edge));
    if (!reach.chains.has(edge.name)) reach.chains.set(edge.name, chain.join(" -> "));
    for (const next of lock.edges.get(keyOf(edge)) ?? []) queue.push([next, edge.name, chain]);
  }
  return reach;
}

/**
 * THE INVARIANTS. A name decides, never a version, so an ordinary update (a patch, a minor, a root devDependency whose
 * version lands in a peer suffix) passes, and a new name does not.
 *
 * Third-party packages the control plane may hold beside the fleet key, each with why. Adding a name is a change to this
 * list: that diff is the review ADR 0012 asks for.
 */
const APPROVED_THIRD_PARTY: Record<string, string> = {
  "@guidepup/guidepup": "the screen-reader driver @a11ign/screenreader-worker imports; its version moves with the fleet's NVDA pin (ADR 0033)",
  "plist": "@guidepup/guidepup's only dependency, a property-list parser",
  "@xmldom/xmldom": "plist's XML parser",
  "xmlbuilder": "plist's XML writer",
};

/** Root `devDependencies` are dev-only by construction; these are the tool families that are dev-only wherever they appear. */
const DEV_ONLY_SCOPES = ["@rstest/", "@rspack/", "@rsbuild/", "@rslib/", "@typescript/", "@types/", "@eslint/", "@typescript-eslint/", "@changesets/"];
const DEV_ONLY_NAMES = ["typescript", "eslint", "typescript-eslint", "vitest", "jest", "esbuild", "webpack", "rollup", "vite", "prettier", "tsx"];

const isDevOnly = (name: string, lock: Lockfile) =>
  lock.devNames.has(name) || DEV_ONLY_NAMES.includes(name) || DEV_ONLY_SCOPES.some((scope) => name.startsWith(scope));

/**
 * THE ONE KNOWN LEAK, AND WHEN IT STOPS BEING EXEMPT. `@a11ign/screenreader-fleet` 0.11.0 depends on
 * `@a11ign/toolchain`, whose required peer `@rstest/core` brings the test runner, rspack and the TypeScript compiler
 * to the control plane beside the fleet key (what ADR 0012 forbids). It is not fixable here: A11-205 freezes the layer
 * pins, so they cannot move now. What is reached ONLY through that one edge is exempt from the no-dev-only invariant while
 * the layers are at the versions below; its third-party names are still held to a list (`KNOWN_LEAK_THIRD_PARTY`), so a
 * new one fails. A second route to `@a11ign/toolchain` from anywhere else puts it and everything below it back in the
 * closure, unexempt. When the deliberate fleet upgrade moves either pin the exemption lapses, and a leak that is still
 * there fails, so it is fixed upstream before the new pin lands and is never approved by default.
 */
const KNOWN_LEAK_EDGE = { from: "@a11ign/screenreader-fleet", to: "@a11ign/toolchain" };
const KNOWN_LEAK_LAYER_PINS: Record<string, string> = {
  "@a11ign/screenreader-fleet": "0.11.0",
  "@a11ign/screenreader-worker": "0.13.13",
};
/** Third-party names that arrive only through the leak (the runner's and the compiler's own dependencies). Not approved for anywhere else. */
const KNOWN_LEAK_THIRD_PARTY: Record<string, string> = {
  "@emnapi/core": "a dependency of @rspack/binding-wasm32-wasi and @napi-rs/wasm-runtime",
  "@emnapi/runtime": "a dependency of @rspack/binding-wasm32-wasi and @napi-rs/wasm-runtime",
  "@emnapi/wasi-threads": "a dependency of @emnapi/core",
  "@napi-rs/wasm-runtime": "a dependency of @rspack/binding-wasm32-wasi",
  "@swc/helpers": "a dependency of @rspack/core and @rsbuild/core",
  "@tybys/wasm-util": "a dependency of @napi-rs/wasm-runtime",
  "assertion-error": "a dependency of @types/chai",
  "cjs-module-lexer": "a dependency of @rstest/core",
  "tslib": "a dependency of @emnapi/*, @swc/helpers and @tybys/wasm-util",
};

/** The leak names this lockfile may exempt: empty once a layer is at any version but the ones recorded above. */
function knownLeak(lock: Lockfile, layerPins: Record<string, string>): Set<string> {
  const pinned = Object.entries(KNOWN_LEAK_LAYER_PINS).every(([name, version]) => layerPins[name] === version);
  if (!pinned) return new Set();
  const direct = productionReach(lock, (from, to) => from === KNOWN_LEAK_EDGE.from && to === KNOWN_LEAK_EDGE.to).chains;
  return new Set([...productionReach(lock).chains.keys()].filter((name) => !direct.has(name)));
}

/** Each way the lockfile's production closure breaks the two invariants, as a message that names the package and the chain. */
function closureViolations(lockText: string, layerPins: Record<string, string>): string[] {
  const lock = parseLockfile(lockText);
  const leak = knownLeak(lock, layerPins);
  const reach = productionReach(lock);
  const violations = [...reach.foreign];
  for (const [name, chain] of reach.chains) {
    if (isDevOnly(name, lock) && !leak.has(name)) {
      violations.push(`"${name}" is a dev-only package (a test runner, bundler, compiler, linter or type package) in the production closure, via ${chain}.`);
    } else if (!name.startsWith("@a11ign/") && !isDevOnly(name, lock) && !(name in APPROVED_THIRD_PARTY) && !(leak.has(name) && name in KNOWN_LEAK_THIRD_PARTY)) {
      violations.push(`"${name}" is a third-party package nobody has approved for the control plane, via ${chain}.`);
    }
  }
  return violations;
}

const HOW_TO_APPROVE = "The invariants: every package in the production closure of the two layers is from the @a11ign/ scope or is named in "
  + "APPROVED_THIRD_PARTY, and none is dev-only. A version change passes. To approve a new third-party NAME, add it to APPROVED_THIRD_PARTY "
  + "in src/control-has-no-dependencies.test.ts with the reason it may sit beside the fleet SSH key: that diff is the review ADR 0012 asks for. "
  + "A dev-only package is not approved here; remove it from the production closure.";

const LAYER_PINS = Object.fromEntries(Object.values(PINS.layers).map((layer: { package: string, version: string }) => [layer.package, layer.version]));

test("THE PRODUCTION CLOSURE OF THE TWO LAYERS HOLDS ONLY @a11ign/ PACKAGES AND APPROVED THIRD-PARTY NAMES, AND NOTHING DEV-ONLY, IN THE LOCKFILE THIS PACKAGE INSTALLS FROM", () => {
  const lock = parseLockfile(LOCK);
  const closure = [...productionReach(lock).chains.keys()];
  assert.ok(closure.includes("@guidepup/guidepup") && closure.length > LAYER_PACKAGES.length,
    "positive control: the walk reaches what the layers depend on, not only the two layers, so the invariants below are not checked over a closure of two");
  const leak = knownLeak(lock, LAYER_PINS);
  assert.ok(leak.has("@rstest/core") && leak.has(KNOWN_LEAK_EDGE.to),
    "positive control: the known toolchain leak is in the lockfile and exempt while the layers are at their recorded pins, "
    + "so the exemption is not an empty set that exempts nothing, and the lockfile's closure is not clean for the wrong reason");
  assert.deepEqual(closureViolations(LOCK, LAYER_PINS), [], HOW_TO_APPROVE);
});

const fixture = (name: string) => readFileSync(new URL(`./control-has-no-dependencies.fixtures/${name}`, import.meta.url), "utf8");

/** `text` with `from` replaced by `to` everywhere, proving it was there: a fixture edit that changes nothing would pass for the wrong reason. */
const replaced = (text: string, from: string, to: string) => {
  assert.ok(text.includes(from), `fixture edit: "${from}" is not in the baseline`);
  return text.replaceAll(from, to);
};

/** The baseline with `name@version` made a dependency of the snapshot whose header line is `parentHeader`. */
const withDependency = (text: string, parentHeader: string, name: string, version: string) =>
  `${replaced(text, `${parentHeader}\n    dependencies:\n`, `${parentHeader}\n    dependencies:\n      ${name}: ${version}\n`)}\n  ${name}@${version}: {}\n`;

test("fixtures: the baseline lockfile passes, and holds the leak the invariants exempt", () => {
  const baseline = fixture("baseline.yaml");
  assert.deepEqual(closureViolations(baseline, LAYER_PINS), []);
  const leak = knownLeak(parseLockfile(baseline), LAYER_PINS);
  assert.deepEqual([...leak].sort(), ["@a11ign/toolchain", "@rspack/core", "@rstest/core"]);
});

test("a patch bump of an existing dependency passes, and so does a root devDependency moving through a peer suffix", () => {
  const baseline = fixture("baseline.yaml");
  const bumped = replaced(replaced(baseline, "@xmldom/xmldom': 0.9.12", "@xmldom/xmldom': 0.9.13"), "@xmldom/xmldom@0.9.12", "@xmldom/xmldom@0.9.13");
  const devBumped = replaced(bumped, "0.12.3", "0.12.4");
  assert.notEqual(devBumped, baseline);
  assert.deepEqual(closureViolations(devBumped, LAYER_PINS), []);
});

test("an unapproved production dependency fails, naming the package, its chain and how to approve it", () => {
  const lock = withDependency(fixture("baseline.yaml"), "  '@a11ign/screenreader-worker@0.13.13':", "left-pad", "1.3.0");
  const violations = closureViolations(lock, LAYER_PINS);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /"left-pad" is a third-party package nobody has approved/);
  assert.match(violations[0], /@a11ign\/screenreader-worker@0\.13\.13 -> left-pad@1\.3\.0/);
  assert.match(HOW_TO_APPROVE, /add it to APPROVED_THIRD_PARTY/);
});

test("a dev-only package that leaks into production not through the toolchain fails, naming the package and its chain", () => {
  const lock = withDependency(fixture("baseline.yaml"), "  '@a11ign/screenreader-worker@0.13.13':", "vitest", "3.0.0");
  const violations = closureViolations(lock, LAYER_PINS);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /"vitest" is a dev-only package/);
  assert.match(violations[0], /@a11ign\/screenreader-worker@0\.13\.13 -> vitest@3\.0\.0/);
});

test("a package the root also lists as a devDependency is dev-only in production, whatever its name", () => {
  const lock = withDependency(fixture("baseline.yaml"), "  '@a11ign/screenreader-worker@0.13.13':", "tsx", "4.23.15");
  assert.match(closureViolations(lock, LAYER_PINS).join("\n"), /"tsx" is a dev-only package/);
});

test("a dev-only package that the toolchain brings is exempt only while the layers are at the recorded pins", () => {
  const baseline = fixture("baseline.yaml");
  const movedPin = { ...LAYER_PINS, "@a11ign/screenreader-fleet": "0.12.0" };
  const violations = closureViolations(baseline, movedPin);
  assert.match(violations.join("\n"), /"@rstest\/core" is a dev-only package.* via @a11ign\/screenreader-fleet@0\.11\.0 -> @a11ign\/toolchain@0\.5\.0 -> @rstest\/core@0\.12\.3/);
  assert.match(violations.join("\n"), /"@rspack\/core" is a dev-only package/);
});

test("a dev-only package reached through the toolchain AND another way is not exempt", () => {
  const lock = withDependency(fixture("baseline.yaml"), "  '@a11ign/screenreader-worker@0.13.13':", "@rstest/core", "0.12.3");
  assert.match(closureViolations(lock, LAYER_PINS).join("\n"), /"@rstest\/core" is a dev-only package.* via @a11ign\/screenreader-worker@0\.13\.13 -> @rstest\/core@0\.12\.3/);
});

test("a new third-party name that arrives through the toolchain's leak fails, though the leak's dev-only packages do not", () => {
  const lock = withDependency(fixture("baseline.yaml"), "  '@rstest/core@0.12.3':", "left-pad", "1.3.0");
  const violations = closureViolations(lock, LAYER_PINS);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /"left-pad" is a third-party package nobody has approved.* via @a11ign\/screenreader-fleet@0\.11\.0 -> @a11ign\/toolchain@0\.5\.0 -> @rstest\/core@0\.12\.3 -> left-pad@1\.3\.0/);
});

test("a second route to the toolchain, from anywhere but the fleet layer, brings the toolchain and what it holds back as dev-only", () => {
  const lock = replaced(fixture("baseline.yaml"),
    "  '@a11ign/screenreader-worker@0.13.13':\n    dependencies:\n",
    "  '@a11ign/screenreader-worker@0.13.13':\n    dependencies:\n      '@a11ign/toolchain': 0.5.0(@rstest/core@0.12.3)\n");
  const violations = closureViolations(lock, LAYER_PINS).join("\n");
  assert.match(violations, /"@a11ign\/toolchain" is a dev-only package/);
  assert.match(violations, /"@rstest\/core" is a dev-only package/);
});

test("a dependency that is an alias, a URL or a link is refused, whatever name it is written under", () => {
  const baseline = fixture("baseline.yaml");
  const under = (dependency: string) => replaced(baseline, "  '@a11ign/screenreader-worker@0.13.13':\n    dependencies:\n", `  '@a11ign/screenreader-worker@0.13.13':\n    dependencies:\n      ${dependency}\n`);
  assert.match(closureViolations(under("'@a11ign/helper': evil-pkg@1.0.0"), LAYER_PINS).join("\n"), /"@a11ign\/helper" is brought in as "evil-pkg@1\.0\.0", not a registry version/);
  assert.match(closureViolations(under("plist: https://evil.example/plist.tgz"), LAYER_PINS).join("\n"), /"plist" is brought in as "https:\/\/evil\.example\/plist\.tgz"/);
  assert.match(closureViolations(under("'@a11ign/local': link:../../evil"), LAYER_PINS).join("\n"), /"@a11ign\/local" is brought in as "link:\.\.\/\.\.\/evil"/);
});

test("a root optionalDependency is in the production closure, because pnpm install --prod installs it", () => {
  const baseline = fixture("baseline.yaml");
  const lock = `${replaced(baseline, "    devDependencies:\n", "    optionalDependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n    devDependencies:\n")}\n  left-pad@1.3.0: {}\n`;
  assert.match(closureViolations(lock, LAYER_PINS).join("\n"), /"left-pad" is a third-party package nobody has approved/);
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  // The count assertion this repo puts on every discovery walk. An empty set would satisfy the tests
  // above in perfect silence — which is how a guarantee becomes a comment.
  assert.ok(modules().length >= 2,
    `only found ${modules().length} module(s) in packages/control; the walk is broken, not the package clean`);
});
