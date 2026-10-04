/**
 * ONE PLACE SAYS WHERE A LAYER'S CODE LIVES (ADR 0039 item 6a, #3394).
 *
 * The control plane's readers of the worker's code version used to reach `nvda-worker`'s source by a
 * relative path, and `git status`/`git show` for it in whatever repository they ran in. In a second
 * repository each would read the wrong tree and print a hash anyway. This pins the resolver, and pins that
 * the six readers no longer name the path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { layersFrom, layerRoot, layerSourceDir, layerCodeVersion } from "./layer-checkouts.mjs";
import { workerSourceDirty } from "../../worker-fleet/src/code-drift.mjs";
import { withGitSandbox } from "../../../scripts/test-support/git-sandbox.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

/**
 * The layer's own hasher and file list, reached THROUGH the resolver: this test names no path into the layer,
 * so it is not an edge of its own and does not change when the layer moves.
 */
const fromLayer = (file: string) => import(pathToFileURL(join(layerSourceDir("nvda-worker"), file)).href);

/** The operator-side readers of the worker's code version. A reader added later belongs here. */
const SIX_READERS = [
  "packages/control/src/fleet-playbook.mjs",
  "packages/control/src/lab-job.mjs",
  "packages/control/ansible/deploy.yml",
  "packages/worker-fleet/src/code-drift.mjs",
  "packages/worker-fleet/src/check-worker-code.mjs",
  "packages/worker-fleet/src/deploy-worker.mjs",
];

/** Comments out: a path named in PROSE is not a path that is read. `//`, block and `#` comments. */
function codeLines(source: string): string[] {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l));
}

/** Where the literal survives in code: the scan the readers are held to, returned as a value to be tested. */
const namingTheWorkerPath = (source: string) => codeLines(source).filter((l) => l.includes("nvda-worker/src"));

/** A layer at a second path, holding every file the hasher reads, each with `body` as its content. */
async function fixtureRepo(body: string): Promise<string> {
  const { WORKER_FILES } = await fromLayer("worker-files.mjs");
  const root = mkdtempSync(join(tmpdir(), "layer-checkouts-"));
  for (const file of WORKER_FILES as string[]) {
    const target = join(root, "elsewhere", "src", file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("layers.json declares nvda-worker and NOTHING else, listed by hand", () => {
  const manifest = JSON.parse(read("packages/control/layers.json"));
  assert.deepEqual(Object.keys(manifest.layers), ["nvda-worker"]);
  assert.equal(typeof manifest.layers["nvda-worker"].path, "string");
});

test("layerSourceDir(\"nvda-worker\") is the directory workerSourceDir() names (today, the same one)", async () => {
  const { workerSourceDir } = await fromLayer("code-version.mjs");
  assert.equal(layerSourceDir("nvda-worker"), workerSourceDir());
  assert.equal(layerSourceDir("nvda-worker"), `${join(layerRoot("nvda-worker"), "src")}/`);
});

test("layerCodeVersion is the hash the worker's own hasher gives over that directory", async () => {
  const { codeVersion, workerSourceDir } = await fromLayer("code-version.mjs");
  const hash = await layerCodeVersion("nvda-worker");
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(hash, codeVersion(workerSourceDir()));
});

test("an UNDECLARED layer is refused by name, and nothing falls back to the monorepo path", () => {
  assert.throws(() => layerSourceDir("ghost"),
    (e: Error) => /layer "ghost" is not declared/.test(e.message) && /nvda-worker/.test(e.message)
      && !e.message.includes("/src"));
  // `Object.prototype` names are not layers either.
  assert.throws(() => layerRoot("constructor"), /layer "constructor" is not declared/);
});

test("a declared layer whose path is ABSENT is refused, naming the layer and the path", () => {
  const root = mkdtempSync(join(tmpdir(), "layer-checkouts-"));
  try {
    const { layerSourceDir: from } = layersFrom({ manifest: { layers: { thing: { path: "not/here" } } }, root });
    assert.throws(() => from("thing"),
      (e: Error) => e.message.includes('layer "thing"') && e.message.includes("not/here")
        && e.message.includes(join(root, "not/here")) && !e.message.includes("nvda-worker"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("POSITIVE CONTROL: a layer at a second path gives a different codeVersion from the real one", async () => {
  const root = await fixtureRepo("a fixture, not the worker\n");
  const { codeVersion } = await fromLayer("code-version.mjs");
  try {
    const fixture = layersFrom({ manifest: { layers: { "nvda-worker": { path: "elsewhere" } } }, root });
    const there = codeVersion(fixture.layerSourceDir("nvda-worker"));
    assert.match(there, /^[0-9a-f]{16}$/);
    assert.notEqual(there, await layerCodeVersion("nvda-worker"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** `from "..."` and dynamic `import("...")` literals of a source, comments out. */
const specifiers = (source: string) =>
  [...codeLines(source).join("\n").matchAll(/(?:\bfrom\s+|\bimport\()"([^"]+)"/g)].map((m) => m[1]);

/** Every import reachable from `file`, as the offenders: anything that is neither `node:` nor a relative module that is itself clean. */
const nonNodeImports = (file: string, seen = new Set<string>()): string[] => {
  if (seen.has(file)) return [];
  seen.add(file);
  return specifiers(readFileSync(file, "utf8")).flatMap((s) =>
    s.startsWith("node:") ? [] : s.startsWith(".") ? nonNodeImports(resolve(dirname(file), s), seen) : [`${file} imports "${s}"`]);
};

test("layer-checkouts.mjs reaches only node: modules and the control plane's own relative ones (control has no node_modules)", () => {
  const file = resolve(REPO, "packages/control/src/layer-checkouts.mjs");
  const found = specifiers(read("packages/control/src/layer-checkouts.mjs"));
  assert.ok(found.length >= 3, `expected the imports to be found, got ${found.length}`);
  assert.deepEqual(nonNodeImports(file), []);
  // The positive control: the relative import is followed, and a package name in it WOULD be named.
  assert.ok(found.includes("./control-plane-checkout.mjs"), "the relative import this walk exists to follow");
});

test("the hasher the resolver reaches imports only node: and relative modules, as the static import used to prove", () => {
  // The static import this replaced put code-version.mjs in `control-has-no-dependencies.test.ts`'s walk. A
  // dynamic one is outside it, so the check that walk made for this file is made here, from the resolved path.
  const seen = new Set<string>();
  const walk = (file: string): string[] => {
    if (seen.has(file)) return [];
    seen.add(file);
    return specifiers(readFileSync(file, "utf8")).flatMap((s) =>
      s.startsWith("node:") ? [] : s.startsWith(".") ? walk(resolve(dirname(file), s)) : [`${file} imports "${s}"`]);
  };
  assert.deepEqual(walk(join(layerSourceDir("nvda-worker"), "code-version.mjs")), []);
  assert.ok(seen.size >= 2, "the walk reached code-version.mjs and its sibling worker-files.mjs");
});

test("none of the six readers still names nvda-worker/src on a line of code", () => {
  assert.equal(SIX_READERS.length, 6);
  for (const file of SIX_READERS) {
    assert.ok(existsSync(resolve(REPO, file)), `${file} is listed and is not there`);
    assert.deepEqual(namingTheWorkerPath(read(file)), [], `${file} reads the worker by a path it guessed`);
  }
});

test("the scan above notices a literal in code, and ignores one in a comment (both directions)", () => {
  assert.equal(namingTheWorkerPath('const d = resolve("x/nvda-worker/src");').length, 1);
  assert.equal(namingTheWorkerPath("// x/nvda-worker/src is where it was\n/* nvda-worker/src */").length, 0);
  assert.equal(namingTheWorkerPath("      # nvda-worker/src, in a playbook comment").length, 0);
});

test("workerSourceDirty reads the directory it is GIVEN, not a monorepo path", () => {
  withGitSandbox((sandbox) => {
    mkdirSync(join(sandbox.dir, "src"));
    mkdirSync(join(sandbox.dir, "other"));
    writeFileSync(join(sandbox.dir, "src", "a.txt"), "one\n");
    writeFileSync(join(sandbox.dir, "other", "b.txt"), "one\n");
    sandbox.run(["add", "."]);
    sandbox.commit("init");
    const src = join(sandbox.dir, "src");
    assert.equal(workerSourceDirty(src), "", "clean");
    writeFileSync(join(sandbox.dir, "other", "b.txt"), "two\n");
    assert.equal(workerSourceDirty(src), "", "a change OUTSIDE the directory is not this directory's");
    writeFileSync(join(src, "a.txt"), "two\n");
    assert.match(workerSourceDirty(src), /src\/a\.txt/);
  });
  assert.throws(() => (workerSourceDirty as (d?: string) => string)(), /needs the worker source directory/);
});
