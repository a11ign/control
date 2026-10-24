// THE FLEET'S VERSIONS ARE WRITTEN ONCE: `deploy-pins.json` (A11-205).
//
// Edge, NVDA, Node and Windows were each written in the role's defaults, the bootstrap, a Renovate pattern and a TypeScript regex, and held equal by
// parity tests. This holds the other half of that: the manifest is the only source, and a second copy fails by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { parseFleetPins, parseEdgePin, readFleetPins, expectedFleetOf, installedReleaseRefusal, DRIFT_FIELDS } from "./fleet-pins.ts";
import type { FleetPins } from "./fleet-pins.ts";

const CONTROL = resolve(import.meta.dirname, "..");
const MANIFEST_TEXT = readFileSync(join(CONTROL, "deploy-pins.json"), "utf8");
const MANIFEST = JSON.parse(MANIFEST_TEXT) as FleetPins & { layers: Record<string, { version: string; integrity: string; }>; core: { commit: string; }; };
const PINS = readFleetPins(join(CONTROL, "deploy-pins.json"));

// ---- the reader ---------------------------------------------------------------------------------------------------------------------------------------

test("the real manifest is read whole: Windows release, build and KB, Edge with its bytes, NVDA, and Node with a checksum per architecture", () => {
  assert.deepEqual(Object.keys(PINS), ["windows", "edge", "nvda", "node"]);
  assert.deepEqual(Object.keys(PINS.windows), ["release", "build", "kb"]);
  assert.deepEqual(Object.keys(PINS.node.sha256).sort(), ["arm64", "x64"]);
});

/** The manifest with one value replaced, as text. `path` is dotted. */
const withValue = (path: string, value: unknown) => {
  const copy = JSON.parse(MANIFEST_TEXT) as Record<string, unknown>;
  const keys = path.split(".");
  const last = keys.pop() as string;
  const holder = keys.reduce<Record<string, unknown>>((object, key) => object[key] as Record<string, unknown>, copy);
  if (value === undefined) delete holder[last]; else holder[last] = value;
  return JSON.stringify(copy);
};

test("the negative control: the real manifest parses", () => {
  assert.ok("pins" in parseFleetPins(MANIFEST_TEXT));
});

for (const [path, bad, expected] of [
  ["windows", undefined, "declares no `windows`"],
  ["windows.release", "Windows 11", "windows.release is \"Windows 11\""],
  ["windows.build", "26300", "windows.build is \"26300\""],
  ["windows.kb", "5127648", "windows.kb is \"5127648\""],
  ["windows.kb", undefined, "windows.kb is undefined"],
  ["edge", undefined, "declares no `edge`"],
  ["edge.version", "156.0.4314", "edge.version is \"156.0.4314\""],
  ["edge.msiUrl", "http://example.test/edge.msi", "edge.msiUrl is"],
  ["edge.msiSha256", "ABC", "edge.msiSha256 is \"ABC\""],
  ["nvda", undefined, "declares no `nvda`"],
  ["nvda.version", "latest", "nvda.version is \"latest\""],
  ["node.version", "24.20.0", "node.version is \"24.20.0\""],
  ["node.sha256", undefined, "declares no `node.sha256`"],
  ["node.sha256.arm64", "0".repeat(63), "node.sha256.arm64 is"],
  ["node.sha256.x64", undefined, "node.sha256.x64 is undefined"],
] as [string, unknown, string][]) {
  test(`a manifest with ${path} ${bad === undefined ? "missing" : `set to ${JSON.stringify(bad)}`} is refused, naming it: no value is ever a default`, () => {
    const read = parseFleetPins(withValue(path, bad));
    assert.ok("refusal" in read, "refused");
    assert.ok(read.refusal.includes(expected), read.refusal);
    assert.match(read.refusal, /^deploy-pins\.json /);
  });
}

test("text that is not JSON, and JSON that is not an object, are refused", () => {
  assert.match((parseFleetPins("{") as { refusal: string }).refusal, /^deploy-pins\.json is not JSON/);
  assert.deepEqual(parseFleetPins("[]"), { refusal: "deploy-pins.json is not an object" });
});

test("what a box is expected to run is the manifest's, and the worker code is DERIVED from the pinned release and not written down", async () => {
  const asked: string[] = [];
  const expected = await expectedFleetOf(PINS, async (layer) => { asked.push(layer); return "0123456789abcdef"; });
  assert.deepEqual(expected, { Windows: PINS.windows.build, Edge: PINS.edge.version, NVDA: PINS.nvda.version, "Worker code": "0123456789abcdef" });
  assert.deepEqual(asked, ["nvda-worker"], "the one hasher deploy.yml reads back, over the pinned worker layer");
  assert.deepEqual(Object.keys(expected), [...DRIFT_FIELDS]);
  assert.equal(JSON.stringify(PINS).includes("0123456789abcdef"), false);
});

test("a worker code that cannot be derived THROWS: a drift check with no expected code would pass every box", async () => {
  await assert.rejects(expectedFleetOf(PINS, async () => { throw new Error("layer \"nvda-worker\" is declared at packages/nvda-worker, and it does not exist"); }), /does not exist/);
});

test("the Edge pin alone is judged on its own: a fault in another section leaves it readable, and a fault in Edge refuses it", () => {
  const edge = parseEdgePin(withValue("nvda", "malformed"));
  assert.ok("edge" in edge);
  assert.deepEqual(edge.edge, PINS.edge);
  assert.match((parseEdgePin(withValue("edge.version", "latest")) as { refusal: string }).refusal, /^deploy-pins\.json edge\.version is "latest"/);
  assert.match((parseEdgePin(withValue("edge", undefined)) as { refusal: string }).refusal, /declares no `edge`/);
  assert.match((parseEdgePin("{") as { refusal: string }).refusal, /not JSON/);
});

// ---- the worker code is derived from the PINNED release, not whatever is installed ------------------------------------------------------------------------

/** A host root with `@a11ign/screenreader-worker` installed at `version` (or not installed, for `undefined`). */
function hostWith(version: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-pins-"));
  if (version !== undefined) {
    mkdirSync(join(root, "node_modules/@a11ign/screenreader-worker"), { recursive: true });
    writeFileSync(join(root, "node_modules/@a11ign/screenreader-worker/package.json"), JSON.stringify({ name: "@a11ign/screenreader-worker", version }));
  }
  return root;
}
const PINNED_WORKER = MANIFEST.layers["nvda-worker"].version;
const refusalOn = (root: string, checkout = false) => installedReleaseRefusal("nvda-worker", { root, checkoutAt: () => checkout });

test("an installed worker release that is not the pinned one refuses the expectation, naming both and the install that fixes it", () => {
  const root = hostWith("0.13.12");
  try {
    assert.match(refusalOn(root) ?? "", /^@a11ign\/screenreader-worker@0\.13\.12 is installed here and deploy-pins\.json pins 0\.13\.13, so the worker code a box should serve cannot be derived: run `pnpm install --frozen-lockfile`$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the pinned release installed, no install at all, or a checkout of the layer are all left to the hasher (the controls for the case above)", () => {
  const root = hostWith(PINNED_WORKER);
  const bare = hostWith(undefined);
  const stale = hostWith("0.0.1");
  try {
    assert.equal(refusalOn(root), null, "the pinned release is installed");
    assert.equal(refusalOn(bare), null, "nothing installed: layerCodeVersion names what is missing");
    assert.equal(refusalOn(stale, true), null, "a checkout is hashed as it stands, whatever is installed");
  } finally { for (const dir of [root, bare, stale]) rmSync(dir, { recursive: true, force: true }); }
});

// ---- the manifest is the only source -------------------------------------------------------------------------------------------------------------------

/** Every file whose CODE could carry a version: the playbooks and role, and the control plane's TypeScript (not its tests). `scripts/renovate-pins.test.ts` reads the Renovate config, which the core's lay does not carry. */
function codeFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(join(CONTROL, "ansible"));
  walk(join(CONTROL, "src"));
  const relevant = (path: string) => {
    const rel = relative(CONTROL, path);
    if (/\.test\.ts$/.test(rel)) return false;
    if (rel.startsWith("src/")) return rel.endsWith(".ts");
    if (rel.startsWith("ansible/")) return /\.(ya?ml|ps1|py|j2|sh|service|timer|cfg|json)$/.test(rel);
    return true;
  };
  return found.filter(relevant).sort();
}

/** The lines of a file that are not wholly a comment: a comment may tell the history of a pin, and is not a copy of it. */
function codeLines(path: string, text: string): string[] {
  const comment = /\.(ts)$/.test(path) ? /^\s*(\/\/|\/\*|\*)/ : /^\s*#/;
  return text.split("\n").filter((line) => !comment.test(line));
}

/** The manifest's own values, each of which may be written in exactly one file. */
const PINNED_VALUES: { label: string; pattern: RegExp; }[] = (() => {
  const exact = (value: string) => new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.])`);
  const { windows, edge, nvda, node } = PINS;
  return [
    ["windows.build", windows.build], ["windows.kb", windows.kb],
    ["edge.version", edge.version], ["edge.msiUrl", edge.msiUrl], ["edge.msiSha256", edge.msiSha256],
    ["nvda.version", nvda.version], ["node.version", node.version], ["node.sha256.x64", node.sha256.x64], ["node.sha256.arm64", node.sha256.arm64],
    ...Object.entries(MANIFEST.layers).flatMap(([name, layer]) => [[`layers.${name}.version`, layer.version], [`layers.${name}.integrity`, layer.integrity]]),
    ["core.commit", MANIFEST.core.commit],
  ].map(([label, value]) => ({ label, pattern: exact(value) }));
})();

/** A literal that LOOKS like a box version, whether or not the manifest holds it today: the next stray copy is not one of the values above. */
const VERSION_SHAPES: { label: string; pattern: RegExp; }[] = [
  { label: "an Edge version", pattern: /(?<![\w.])1\d\d\.0\.\d{4}\.\d+(?![\w.])/ },
  { label: "a Node version", pattern: /(?<![\w.])v2\d\.\d+\.\d+(?![\w.])/ },
  { label: "a Windows build", pattern: /(?<![\w.])2\d{4}\.\d{4,5}(?![\w.])/ },
  { label: "a KB number", pattern: /(?<![\w.])KB\d{6,8}(?![\w.])/ },
];

/** What a file's code holds of the fleet's versions, as `label` strings. */
function copiesIn(path: string, text: string): string[] {
  const found: string[] = [];
  for (const line of codeLines(path, text)) {
    for (const { label, pattern } of [...PINNED_VALUES, ...VERSION_SHAPES]) if (pattern.test(line)) found.push(`${label}: ${line.trim().slice(0, 120)}`);
  }
  return found;
}

test("NO VERSION IS WRITTEN IN TWO PLACES: no playbook, role file or control-plane source carries a value the manifest holds", () => {
  const files = codeFiles();
  assert.ok(files.length > 100, `the scan reads the code (${files.length} files), so an empty list cannot pass it`);
  const copies = files.flatMap((path) => copiesIn(path, readFileSync(path, "utf8")).map((copy) => `${relative(CONTROL, path)} — ${copy}`));
  assert.deepEqual(copies, [], "a version of the fleet is written outside deploy-pins.json; derive it from the manifest, or declare the exception in this test");
});

test("the scan is not blind: it finds a stray Edge, Node, Windows, KB or manifest value, and it reads past a comment that only tells history", () => {
  const stray = (text: string) => copiesIn("ansible/roles/worker/defaults/main.yml", text);
  assert.equal(stray('worker_edge_version: "157.0.4400.1"\n').length, 1, "a stray Edge literal is found");
  assert.equal(stray(`worker_edge_version: "${PINS.edge.version}"\n`).length > 0, true, "so is the manifest's own Edge, written a second time");
  assert.equal(stray(`worker_node_sha256: ${PINS.node.sha256.x64}\n`).length > 0, true);
  assert.equal(stray('worker_node_version: "v24.99.0"\n').length, 1);
  assert.equal(stray("patch_target_build: 26400.1234\n").length, 1);
  assert.equal(stray("accept_list: [KB5199999]\n").length, 1);
  assert.deepEqual(stray(`# FOLLOWED FORWARD to ${PINS.edge.version} on 2026-10-24\n`), [], "a comment is history, not a copy");
  assert.deepEqual(stray('worker_edge_version: "{{ worker_fleet_pins.edge.version }}"\n'), [], "and a derivation is not a copy");
  const ts = (text: string) => copiesIn("src/x.ts", text);
  assert.equal(ts(`const EDGE = "${PINS.edge.version}";\n`).length > 0, true);
  assert.deepEqual(ts(` * the pin was ${PINS.edge.version}\n// ${PINS.edge.version}\n`), []);
});

// ---- the role derives from the manifest ------------------------------------------------------------------------------------------------------------------

const DEFAULTS_PATH = join(CONTROL, "ansible/roles/worker/defaults/main.yml");
/** The role's defaults as `key: value` for each top-level key whose value is on one line: all this file reads, so the YAML parser (not a dependency here) is not needed. */
const DEFAULTS: Record<string, string> = Object.fromEntries(readFileSync(DEFAULTS_PATH, "utf8").split("\n").flatMap((line) => {
  const match = /^([a-z][a-z0-9_]*):\s+(.+?)\s*$/.exec(line);
  return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, "$2")]] : [];
}));

test("the role's Edge and Node pins are DERIVED from the manifest, key by key", () => {
  assert.equal(DEFAULTS.worker_fleet_pins, "{{ lookup('file', playbook_dir ~ '/../deploy-pins.json') | from_json }}", "read the way worker_layer_checkouts reads layers.json");
  assert.deepEqual(
    ["worker_edge_version", "worker_edge_msi_url", "worker_edge_msi_sha256", "worker_node_version", "worker_node_sha256"].map((key) => DEFAULTS[key]),
    ["{{ worker_fleet_pins.edge.version }}", "{{ worker_fleet_pins.edge.msiUrl }}", "{{ worker_fleet_pins.edge.msiSha256 }}",
      "{{ worker_fleet_pins.node.version }}", "{{ worker_fleet_pins.node.sha256 }}"]);
});

test("every manifest path the role derives from exists in the manifest", () => {
  const manifest = JSON.parse(MANIFEST_TEXT) as Record<string, unknown>;
  const derived = [...String(readFileSync(DEFAULTS_PATH, "utf8")).matchAll(/worker_fleet_pins\.([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
  assert.ok(derived.length >= 5);
  for (const path of derived) {
    const value = path.split(".").reduce<unknown>((holder, key) => (holder as Record<string, unknown> | undefined)?.[key], manifest);
    assert.notEqual(value, undefined, `defaults/main.yml derives worker_fleet_pins.${path} and deploy-pins.json has no such key`);
  }
});

// The fleet's `stamp-provision-revision.ps1` hashes `defaults/main.yml` into `provisionRevision` (a capture cache key) and does not hash the manifest, and
// no box reports its display driver. So the driver's version is the one that cannot move into the manifest without a bump changing no cache key. Control
// cannot read the stamp (ADR 0012); `provision-stamp-inputs.test.ts` restates that the defaults file is hashed.
test("the ONE declared exception: the Intel display driver stays in the role's defaults, and nothing else version-shaped does", () => {
  assert.deepEqual(Object.keys(DEFAULTS).filter((key) => /^worker_display_driver_/.test(key)).sort(),
    ["worker_display_driver_path", "worker_display_driver_sha256", "worker_display_driver_url", "worker_display_driver_version"]);
  assert.match(DEFAULTS.worker_display_driver_version, /^\d+\.\d+\.\d+\.\d+$/);
  // The exception is exactly this: a version-shaped value in defaults that is NOT the driver's would be a second one.
  const driver = new Set(["worker_display_driver_version", "worker_display_driver_url", "worker_display_driver_sha256", "worker_display_driver_path"]);
  const others = Object.entries(DEFAULTS).filter(([key]) => !driver.has(key)).flatMap(([key, value]) =>
    VERSION_SHAPES.filter(({ pattern }) => pattern.test(JSON.stringify(value))).map(({ label }) => `${key} holds ${label}`));
  assert.deepEqual(others, []);
});
