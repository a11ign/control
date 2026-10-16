/**
 * ONE PLACE SAYS WHERE A LAYER'S CODE LIVES (ADR 0039 item 6a, #3394).
 *
 * The control plane's readers of the worker's code version used to reach `nvda-worker`'s source by a
 * relative path, and `git status`/`git show` for it in whatever repository they ran in. In a second
 * repository each would read the wrong tree and print a hash anyway. This pins the resolver, and pins that
 * the five readers no longer name the path.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { installedLayersJudged, installedLayersRead, layersFrom, manifestOf, releaseTag, layerSourceDir as realLayerSourceDir } from "./layer-checkouts.ts";
import { parseDeployPins, pinnedTag, readDeployPins } from "./layer-pins.ts";
import { workerSourceDirty } from "@a11ign/screenreader-fleet/code-drift";
import { sandboxGitEnv } from "./git-safe-env.ts";
import { withGitSandbox } from "@a11ign/toolchain/lib/git-sandbox";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

/**
 * THE LAYER IS NOT IN THIS TREE (#3447): it lives in `a11ign/screenreader-worker`, and a host holds a checkout of it. A copy of the
 * LAID layer stands in for that checkout, placed at the path `deploy-pins.json` declares in a root of its own, so these tests run the real
 * resolver over the real declaration and the real worker files. It is the laid layer and no longer the published package because, from
 * v0.9.0 (#4516), the package ships `dist/` alone and a host's checkout holds `src/*.ts`: the shape the resolver reads is the laid one.
 */
const MANIFEST = manifestOf(readDeployPins());
const LAID = resolve(REPO, MANIFEST.layers["nvda-worker"].path);
const CHECKOUT = mkdtempSync(join(tmpdir(), "layer-checkout-"));
cpSync(LAID, join(CHECKOUT, MANIFEST.layers["nvda-worker"].path), { recursive: true });
after(() => rmSync(CHECKOUT, { recursive: true, force: true }));
const { layerRoot, layerSourceDir, layerCodeVersion } = layersFrom({ manifest: MANIFEST, root: CHECKOUT });

/**
 * The layer's own hasher and file list, reached THROUGH the resolver: this test names no path into the layer,
 * so it is not an edge of its own and does not change when the layer moves.
 */
const fromLayer = (file: string) => import(pathToFileURL(join(layerSourceDir("nvda-worker"), file)).href);

/** The operator-side readers of the worker's code version. A reader added later belongs here. `deploy-worker.mjs` was the sixth, until screenreader-fleet 0.4.0 removed it (#3803). */
const FIVE_READERS = [
  "packages/control/src/fleet-playbook.ts",
  "packages/control/src/lab-job.ts",
  "packages/control/ansible/deploy.yml",
  "packages/worker-fleet/src/code-drift.ts",
  // Through the resolver, so this list names no path into screenreader-fleet (#5346).
  join(realLayerSourceDir("screenreader-fleet"), "check-worker-code.ts"),
];

/** Comments out: a path named in PROSE is not a path that is read. `//`, block and `#` comments. */
function codeLines(source: string): string[] {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l));
}

/** Where the literal survives in code: the scan the readers are held to, returned as a value to be tested. */
const namingTheWorkerPath = (source: string) => codeLines(source).filter((l) => l.includes("nvda-worker/src"));

/** A layer at a second path, holding every file the hasher reads, each with `body` as its content. */
async function fixtureRepo(body: string): Promise<string> {
  const { WORKER_FILES } = await fromLayer("worker-files.ts");
  const root = mkdtempSync(join(tmpdir(), "layer-checkouts-"));
  for (const file of WORKER_FILES as string[]) {
    const target = join(root, "elsewhere", "src", file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return root;
}

test("deploy-pins.json declares nvda-worker and screenreader-fleet and NOTHING else, listed by hand", () => {
  const parsed = parseDeployPins(read("packages/control/deploy-pins.json"));
  assert.ok("pins" in parsed, "the real declaration parses");
  assert.deepEqual(Object.keys(parsed.pins.layers), ["nvda-worker", "screenreader-fleet"]);
  assert.equal(typeof parsed.pins.layers["nvda-worker"].path, "string");
});

test("layerSourceDir(\"nvda-worker\") is the directory workerSourceDir() names (today, the same one)", async () => {
  const { workerSourceDir } = await fromLayer("code-version.ts");
  assert.equal(layerSourceDir("nvda-worker"), workerSourceDir());
  assert.equal(layerSourceDir("nvda-worker"), `${join(layerRoot("nvda-worker"), "src")}/`);
});

test("layerCodeVersion is the hash the worker's own hasher gives over that directory", async () => {
  const { codeVersion, workerSourceDir } = await fromLayer("code-version.ts");
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

test("#3761: layerDeclaration names a declared layer WITHOUT its directory existing -- what a missing-clone refusal needs", () => {
  const root = mkdtempSync(join(tmpdir(), "layer-checkouts-"));
  try {
    const remote = "https://example.invalid/thing.git";
    const { layerDeclaration, layerRoot: rootOf } = layersFrom({ manifest: { layers: { thing: { path: "not/here", remote } } }, root });
    assert.deepEqual(layerDeclaration("thing"), { name: "thing", path: "not/here", remote, package: undefined, dir: join(root, "not/here") });
    const named = layersFrom({ manifest: { layers: { thing: { path: "not/here", remote, package: "other" } } }, root });
    assert.equal(named.layerDeclaration("thing").package, "other", "a declared package is carried, for the reader of a lockfile pin");
    assert.throws(() => rootOf("thing"), /does not exist/, "layerRoot still refuses: only the declaration is lenient");
    assert.throws(() => layerDeclaration("ghost"), /layer "ghost" is not declared/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("POSITIVE CONTROL: a layer at a second path gives a different codeVersion from the real one", async () => {
  const root = await fixtureRepo("a fixture, not the worker\n");
  const { codeVersion } = await fromLayer("code-version.ts");
  try {
    const fixture = layersFrom({ manifest: { layers: { "nvda-worker": { path: "elsewhere" } } }, root });
    const there = codeVersion(fixture.layerSourceDir("nvda-worker"));
    assert.match(there, /^[0-9a-f]{16}$/);
    assert.notEqual(there, await layerCodeVersion("nvda-worker"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/**
 * A layer whose `src/` holds only the named hasher files, each returning `answer` as its codeVersion (#4516): the two spellings the resolver
 * reads, one fixture each. `.mjs` is the nvda-worker tags before v0.9.0 and a host may still hold one; it is a fallback and no other reader copies it.
 */
function hasherLayer(files: string[], answer: string): string {
  const root = mkdtempSync(join(tmpdir(), "layer-checkouts-"));
  mkdirSync(join(root, "elsewhere", "src"), { recursive: true });
  for (const file of files) writeFileSync(join(root, "elsewhere", "src", file), `export const codeVersion = () => ${JSON.stringify(`${answer} from ${file}`)};\n`);
  return root;
}

const hashOf = (root: string) => layersFrom({ manifest: { layers: { "nvda-worker": { path: "elsewhere" } } }, root }).layerCodeVersion("nvda-worker");

test("#4516 a layer holding code-version.ts ONLY is hashed by it", async () => {
  const root = hasherLayer(["code-version.ts"], "ts-only");
  try { assert.equal(await hashOf(root), "ts-only from code-version.ts"); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#4516 a layer holding code-version.mjs ONLY (an .mjs-era tag a host may still hold) is hashed by it", async () => {
  const root = hasherLayer(["code-version.mjs"], "mjs-only");
  try { assert.equal(await hashOf(root), "mjs-only from code-version.mjs"); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#4516 a layer holding BOTH is hashed by the .ts: the fallback is only a fallback", async () => {
  const root = hasherLayer(["code-version.mjs", "code-version.ts"], "both");
  try { assert.equal(await hashOf(root), "both from code-version.ts"); } finally { rmSync(root, { recursive: true, force: true }); }
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

test("layer-checkouts.ts reaches only node: modules and the control plane's own relative ones (control has no node_modules)", () => {
  const file = resolve(REPO, "packages/control/src/layer-checkouts.ts");
  const found = specifiers(read("packages/control/src/layer-checkouts.ts"));
  assert.ok(found.length >= 3, `expected the imports to be found, got ${found.length}`);
  assert.deepEqual(nonNodeImports(file), []);
  // The positive control: the relative import is followed, and a package name in it WOULD be named.
  assert.ok(found.includes("./control-plane-checkout.ts"), "the relative import this walk exists to follow");
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
  assert.deepEqual(walk(join(layerSourceDir("nvda-worker"), "code-version.ts")), []);
  assert.ok(seen.size >= 2, "the walk reached code-version.ts and its sibling worker-files.ts");
});

test("none of the five readers still names nvda-worker/src on a line of code", () => {
  assert.equal(FIVE_READERS.length, 5);
  for (const file of FIVE_READERS) {
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

// ---- the control plane's move over a laid layer, and over a release that is only a tag (#4150) ---------------------------

const MOVE_LAYER = "fixture-layer";
const MOVE_PATH = "packages/fixture-layer-4150";
const REFUSED = 4;
const TAG = "v1.2.3";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git",
  ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
  { cwd, env: sandboxGitEnv(), encoding: "utf8" }).trim();

/**
 * A layer repository whose release commit is held by a tag ONLY: `branchTip` is on `main`, and `released` is a version commit made on
 * a detached head, the shape `screenreader-worker` v0.4.0 has (one ahead of main, two behind). The control plane's core is a bare
 * directory of its own, so no path in it is the real control plane's.
 */
function layerFixture({ annotated }: { annotated: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "layer-move-4150-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin");
  mkdirSync(origin);
  gitIn(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "f"), "one\n");
  gitIn(origin, "add", "f");
  gitIn(origin, "commit", "-qm", "one");
  gitIn(origin, "checkout", "-q", "--detach");
  writeFileSync(join(origin, "f"), "release\n");
  gitIn(origin, "commit", "-qam", "version commit");
  const released = gitIn(origin, "rev-parse", "HEAD");
  if (annotated) gitIn(origin, "tag", "-a", "-m", "release", TAG, released);
  else gitIn(origin, "tag", TAG, released);
  gitIn(origin, "checkout", "-q", "main");
  writeFileSync(join(origin, "f"), "two\n");
  gitIn(origin, "commit", "-qam", "two");
  const branchTip = gitIn(origin, "rev-parse", "HEAD");
  const core = join(root, "core");
  mkdirSync(join(core, MOVE_PATH), { recursive: true });
  const manifest = { layers: { [MOVE_LAYER]: { path: MOVE_PATH, remote: origin } } };
  const move = layersFrom({ manifest, root: core }).layerCheckoutMove;
  return { origin, core, layerDir: join(core, MOVE_PATH), released, branchTip, move };
}

/** A laid tree as `scripts/lay-layer.ts` leaves it: `src/` and `.layer-ref`, and no `.git`. */
function lay(layerDir: string, ref: string) {
  mkdirSync(join(layerDir, "src"), { recursive: true });
  writeFileSync(join(layerDir, ".layer-ref"), `${ref}\n`);
}

/** The control plane's shell run against a stand-in checkout: the absolute path it names is swapped for the fixture's. */
function runMove(command: string, core: string) {
  const local = command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, core);
  assert.ok(!local.includes(CONTROL_PLANE_CHECKOUT_PATH), "the swap left the real control-plane path in the command");
  return spawnSync("bash", ["-c", `true${local}`], { env: { ...sandboxGitEnv(), PATH: process.env.PATH }, encoding: "utf8" });
}

for (const annotated of [false, true]) {
  test(`a LAID layer whose .layer-ref tag resolves to the pin is accepted, and does not exit ${REFUSED} (${annotated ? "annotated" : "lightweight"} tag)`, () => {
    const { core, layerDir, released, move } = layerFixture({ annotated });
    lay(layerDir, TAG);
    const run = runMove(move({ [MOVE_LAYER]: released }), core);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(layerDir, ".git")), false, "a laid tree is judged and never turned into a clone");
  });
}

test("a LAID layer whose tag resolves to another commit REFUSES, naming the layer, the .layer-ref and the pin", () => {
  const { core, layerDir, branchTip, released, move } = layerFixture({ annotated: false });
  lay(layerDir, TAG);
  const run = runMove(move({ [MOVE_LAYER]: branchTip }), core);
  assert.equal(run.status, REFUSED, run.stderr);
  assert.match(run.stderr, new RegExp(`layer ${MOVE_LAYER} is laid at \\S+${MOVE_PATH}`));
  assert.match(run.stderr, new RegExp(`\\.layer-ref names the tag ${TAG}, which is ${released}`));
  assert.match(run.stderr, new RegExp(`the pin is ${branchTip}`));
});

test("a LAID layer whose tag the remote does not have, or whose .layer-ref holds no tag, REFUSES", () => {
  const { core, layerDir, released, move } = layerFixture({ annotated: false });
  lay(layerDir, "v9.9.9");
  const absent = runMove(move({ [MOVE_LAYER]: released }), core);
  assert.equal(absent.status, REFUSED, absent.stderr);
  assert.match(absent.stderr, /which is not on /);
  lay(layerDir, "../escape");
  const notATag = runMove(move({ [MOVE_LAYER]: released }), core);
  assert.equal(notATag.status, REFUSED, notATag.stderr);
  assert.match(notATag.stderr, /does not hold a tag/);
});

test("POSITIVE CONTROL: a layer path with neither a .git nor a .layer-ref beside src/ still REFUSES, however the pin reads", () => {
  const { core, layerDir, released, move } = layerFixture({ annotated: false });
  const refusesIn = (why: string) => {
    const run = runMove(move({ [MOVE_LAYER]: released }), core);
    assert.equal(run.status, REFUSED, `${why}: ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`layer ${MOVE_LAYER} is declared at ${MOVE_PATH}`));
    assert.match(run.stderr, /does not stand in for it/);
  };
  refusesIn("an empty directory");
  mkdirSync(join(layerDir, "src"));
  refusesIn("the core's own src/ and no .layer-ref");
  rmSync(join(layerDir, "src"), { recursive: true });
  writeFileSync(join(layerDir, ".layer-ref"), `${TAG}\n`);
  refusesIn("a .layer-ref and no src/");
});

// ---- a PUBLISHED layer on a plane that holds no `packages/<layer>` (#5445) -------------------------------------------------

const PUBLISHED_PACKAGE = "@a11ign/fixture-layer";
const PUBLISHED_VERSION = "1.2.3";
const HALF_LAID_REFUSAL = /neither a git checkout nor a laid tree/;

/**
 * The plane as #5445 measured it: a plain clone whose `packages/` does not exist, with the layer's release installed under
 * `node_modules/` (or not, or at another version), and a manifest that declares the release the way `deploy-pins.json` does.
 */
function planeFixture({ installed }: { installed: string | null }) {
  const { origin, core } = layerFixture({ annotated: false });
  rmSync(join(core, "packages"), { recursive: true });
  if (installed !== null) {
    const dir = join(core, "node_modules", PUBLISHED_PACKAGE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `{\n  "name": "${PUBLISHED_PACKAGE}",\n  "version": "${installed}"\n}\n`);
  }
  const layer = { path: MOVE_PATH, remote: origin, package: PUBLISHED_PACKAGE, version: PUBLISHED_VERSION };
  const move = layersFrom({ manifest: { layers: { [MOVE_LAYER]: layer } }, root: core }).layerCheckoutMove;
  return { core, command: move({ [MOVE_LAYER]: "a".repeat(40) }) };
}

test("#5445 the sync command for the REAL declaration never holds the half-laid refusal, because both layers are published dependencies", () => {
  const manifest = manifestOf(readDeployPins());
  const names = Object.keys(manifest.layers);
  assert.deepEqual(names.sort(), ["nvda-worker", "screenreader-fleet"], "the positive control: the declaration this guards holds the two layers the row names");
  const pins = Object.fromEntries(names.map((name) => [name, "b".repeat(40)]));
  const command = layersFrom({ manifest, root: tmpdir() }).layerCheckoutMove(pins);
  assert.doesNotMatch(command, HALF_LAID_REFUSAL);
  for (const name of names) {
    assert.ok(command.includes(`${CONTROL_PLANE_CHECKOUT_PATH}/node_modules/${manifest.layers[name].package}/package.json`), `${name} is judged by its installed release`);
  }
});

test("#5445 a plane with no packages/ and the declared release installed passes the sync", () => {
  const { core, command } = planeFixture({ installed: PUBLISHED_VERSION });
  assert.doesNotMatch(command, HALF_LAID_REFUSAL);
  assert.equal(existsSync(join(core, "packages")), false, "the fixture is a plane that holds no packages/");
  const run = runMove(command, core);
  assert.equal(run.status, 0, run.stderr);
});

test("#5445 a plane whose installed release is another one, or none, REFUSES naming the layer, the release and what it holds", () => {
  const behind = planeFixture({ installed: "1.2.2" });
  const wrong = runMove(behind.command, behind.core);
  assert.equal(wrong.status, REFUSED, wrong.stderr);
  assert.match(wrong.stderr, new RegExp(`layer ${MOVE_LAYER} is the published dependency ${PUBLISHED_PACKAGE}@${PUBLISHED_VERSION}`));
  assert.match(wrong.stderr, /holds 1\.2\.2/);
  const absent = planeFixture({ installed: null });
  const none = runMove(absent.command, absent.core);
  assert.equal(none.status, REFUSED, none.stderr);
  assert.match(none.stderr, /holds no installed version: run pnpm install --frozen-lockfile/);
});

test("#5445 a layer that declares a release no pattern accepts is refused before any command is built", () => {
  const bad = { path: MOVE_PATH, remote: "https://example.test/x.git", package: "@a11ign/x", version: "^1.2.3" };
  const { layerCheckoutMove } = layersFrom({ manifest: { layers: { [MOVE_LAYER]: bad } }, root: tmpdir() });
  assert.throws(() => layerCheckoutMove({ [MOVE_LAYER]: "a".repeat(40) }), /not an @a11ign\/<name> package at an exact x\.y\.z/);
});

test("a CLONED layer is moved to a release whose commit is only a tag, because the move fetches tags", () => {
  const { core, layerDir, origin, released, branchTip, move } = layerFixture({ annotated: true });
  rmSync(layerDir, { recursive: true });
  gitIn(core, "clone", "-q", "--branch", "main", origin, layerDir);
  assert.equal(gitIn(layerDir, "rev-parse", "HEAD"), branchTip);
  // `clone` fetches every tag; a clone made BEFORE the release was tagged is what the control plane's `nvda-worker` was (it sat at 629ff79).
  gitIn(layerDir, "tag", "-d", TAG);
  gitIn(layerDir, "gc", "-q", "--prune=now");
  assert.throws(() => gitIn(layerDir, "cat-file", "-e", `${released}^{commit}`), "the clone starts without the release commit");
  const command = move({ [MOVE_LAYER]: released });
  assert.match(command, /git fetch --quiet --tags origin/);
  const run = runMove(command, core);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(gitIn(layerDir, "rev-parse", "HEAD"), released);
});

test("the move's refusal no longer points at a script that does not exist", () => {
  const { move } = layerFixture({ annotated: false });
  assert.doesNotMatch(move({ [MOVE_LAYER]: "a".repeat(40) }), /bootstrap-control-plane\.sh/);
});

test("a remote that could close the quotes it is placed in is refused before any command is built", () => {
  const manifest = { layers: { [MOVE_LAYER]: { path: MOVE_PATH, remote: "https://example.test/x.git' ; rm -rf / ; '" } } };
  const { layerCheckoutMove } = layersFrom({ manifest, root: tmpdir() });
  assert.throws(() => layerCheckoutMove({ [MOVE_LAYER]: "a".repeat(40) }), /not a plain https URL or path/);
});

// ---------------------------------------------------------------------------------------------------------
// #4363: the tag a layer's repository made, `v<semver>` from the package's first flat version
// ---------------------------------------------------------------------------------------------------------

const pinnedAt = (layer: string, version: string) => pinnedTag(
  { layers: { [layer]: { package: `@a11ign/${layer}`, version, integrity: "sha512-x", path: `packages/${layer}`, remote: "https://example.invalid/x.git" } } }, layer);

test("#4363 pinnedTag names the tag the layer's repository made: v<semver> from its first flat version, <package>@<version> before it", () => {
  assert.deepEqual(pinnedAt("screenreader-worker", "0.5.0"), { tag: "v0.5.0" }, "the pin the lockfile holds today: the remote has v0.5.0 and no @a11ign/screenreader-worker@0.5.0");
  assert.deepEqual(pinnedAt("screenreader-worker", "0.3.0"), { tag: "v0.3.0" }, "the first flat version is itself flat");
  assert.deepEqual(pinnedAt("screenreader-worker", "0.2.0"), { tag: "@a11ign/screenreader-worker@0.2.0" }, "the one older tag the remote holds");
  assert.deepEqual(pinnedAt("screenreader-fleet", "0.5.2"), { tag: "@a11ign/screenreader-fleet@0.5.2" }, "the fleet's last scoped release");
  assert.deepEqual(pinnedAt("screenreader-fleet", "0.5.3"), { tag: "v0.5.3" }, "the fleet's first flat one: a patch apart from the line above");
  assert.deepEqual(pinnedAt("screenreader-fleet", "0.6.0"), { tag: "v0.6.0" }, "a later minor");
  assert.deepEqual(pinnedAt("screenreader-fleet", "1.0.0"), { tag: "v1.0.0" }, "a later major, whatever its minor and patch");
  assert.deepEqual(pinnedAt("scorer", "0.5.0"), { tag: "@a11ign/scorer@0.5.0" }, "a package with no flat release keeps the scoped form");
});

/** The core's file, reachable only from inside a core checkout (`packages/control` laid beside `scripts/`), and exporting `releaseTag` only from the core's #4119 on. */
const CORE_LAY_LAYER = join(REPO, "scripts/lay-layer.ts");

/** Why the agreement test cannot run here, or `false` when it can: a core older than `releaseTag` (what `ci.yml`'s `CORE_REF` may still pin) has no first copy to compare with. */
function noFirstCopy(): string | false {
  if (!existsSync(CORE_LAY_LAYER)) return `${CORE_LAY_LAYER} is not reachable from this checkout, so there is no first copy to compare the second with`;
  if (!/export function releaseTag\(/.test(readFileSync(CORE_LAY_LAYER, "utf8"))) return `${CORE_LAY_LAYER} does not export releaseTag (a core older than a11ign/a11ign #4119), so there is no first copy to compare the second with`;
  return false;
}

test("#4363 BARE_TAGS_FROM is a second copy of the core's, and releaseTag agrees with scripts/lay-layer.ts's over every boundary", {
  skip: noFirstCopy(),
}, async () => {
  const theirs = (await import(pathToFileURL(CORE_LAY_LAYER).href)) as { releaseTag: (name: string, version: string) => string; };
  const versions = ["0.0.1", "0.2.9", "0.2.0", "0.3.0", "0.3.1", "0.4.0", "0.5.0", "0.5.2", "0.5.3", "0.5.4", "0.6.0", "1.0.0", "2.0.0", "0.3.0-rc.1"];
  for (const name of ["@a11ign/screenreader-worker", "@a11ign/screenreader-fleet", "@a11ign/scorer"]) {
    for (const version of versions) assert.equal(releaseTag(name, version), theirs.releaseTag(name, version), `${name}@${version}`);
  }
  assert.equal(theirs.releaseTag("@a11ign/screenreader-fleet", "0.5.3"), "v0.5.3", "positive control: the core's own function was reached and does flatten");
});

// ---- a PUBLISHED layer answers layerCodeVersion from its release, with no checkout (#5540) ---------------------------------------

/** A plane holding the layer only as `node_modules/<package>/dist/code-version.mjs`, whose no-argument `codeVersion()` answers `stamp`. */
function releaseOnlyPlane(stamp: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "layer-release-"));
  if (stamp !== null) {
    const dist = join(root, "node_modules", PUBLISHED_PACKAGE, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "code-version.mjs"), `export const codeVersion = (dir) => ${JSON.stringify(stamp)} + (dir === undefined ? "" : "-hashed");\n`);
  }
  return root;
}

const publishedLayer = { path: "packages/nvda-worker", package: PUBLISHED_PACKAGE, version: PUBLISHED_VERSION };
const codeVersionOn = (root: string, layer: { path: string; package?: string; version?: string; }) => layersFrom({ manifest: { layers: { "nvda-worker": layer } }, root }).layerCodeVersion("nvda-worker");

test("#5540 a published layer with no packages/<layer> checkout answers with the release's own stamp", async () => {
  const root = releaseOnlyPlane("dbe7c8cf55f930ba");
  try { assert.equal(await codeVersionOn(root, publishedLayer), "dbe7c8cf55f930ba"); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#5540 a layer that HAS a checkout is hashed from src/ even when it declares a release", async () => {
  const root = hasherLayer(["code-version.ts"], "checkout");
  try {
    assert.equal(await codeVersionOn(root, { ...publishedLayer, path: "elsewhere" }), "checkout from code-version.ts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#5540 a layer declaring neither a checkout nor an installed release refuses, naming both", async () => {
  const undeclared = releaseOnlyPlane(null);
  try {
    await assert.rejects(codeVersionOn(undeclared, { path: "packages/nvda-worker" }), /does not exist: check it out there/);
    await assert.rejects(codeVersionOn(undeclared, publishedLayer), new RegExp(`packages/nvda-worker.*${PUBLISHED_PACKAGE} is not installed`));
  } finally { rmSync(undeclared, { recursive: true, force: true }); }
});

// #5556 / #5155: the plane's installed layers, judged from a read of a plane held as a directory. The move's own tests are in fleet-playbook.test.ts.
const WORKER = MANIFEST.layers["nvda-worker"];
const FLEET = MANIFEST.layers["screenreader-fleet"];
assert.ok(WORKER.version && FLEET.version, "the positive control: the declaration holds two published releases");
const judgedRoots: string[] = [];
after(() => { for (const root of judgedRoots) rmSync(root, { recursive: true, force: true }); });

/** The lockfile's shape for the two importer entries, with the transitive `screenreader-worker@0.9.0` entry pnpm writes beside them. */
const lockfile = ({ worker, fleet }: { worker: string; fleet: string }) => [
  "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:",
  "      '@a11ign/screenreader-fleet':", `        specifier: ${fleet}`, `        version: ${fleet}(@a11ign/scorer@0.3.3)(typescript@7.0.2)`,
  "      '@a11ign/screenreader-worker':", `        specifier: ${worker}`, `        version: ${worker}`,
  "    devDependencies:", "      '@a11ign/toolchain':", "        specifier: ^0.1.7", "        version: 0.1.7", "",
  "packages:", "", `  '@a11ign/screenreader-worker@${worker}':`, "    resolution: {}", "  '@a11ign/screenreader-worker@0.9.0':", "    resolution: {}", "",
].join("\n");

type Plane = { installed?: { worker?: string; fleet?: string }; locked?: { worker: string; fleet: string }; clone?: boolean };

/** A plane as a directory: `node_modules/<package>/package.json` at the installed releases, a `pnpm-lock.yaml`, and optionally a clone at a layer's path. */
function planeOf({ installed = {}, locked, clone = false }: Plane) {
  const core = mkdtempSync(join(tmpdir(), "plane-5556-"));
  judgedRoots.push(core);
  for (const [layer, version] of [[WORKER, installed.worker], [FLEET, installed.fleet]] as const) {
    if (version === undefined) continue;
    const dir = join(core, "node_modules", layer.package as string);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `{\n  "name": "${layer.package}",\n  "version": "${version}"\n}\n`);
  }
  if (locked) writeFileSync(join(core, "pnpm-lock.yaml"), lockfile(locked));
  if (clone) mkdirSync(join(core, WORKER.path, ".git"), { recursive: true });
  return core;
}

/** The read, run for real against the fixture, and what it printed. */
function readOf(core: string): string {
  const command = installedLayersRead(MANIFEST);
  const local = command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, core);
  const run = spawnSync("bash", ["-c", local], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

const judged = (core: string) => installedLayersJudged(MANIFEST, readOf(core));
const BOTH = { worker: WORKER.version as string, fleet: FLEET.version as string };
/** The declared worker release as regex source: the refusals quote it, and a pin bump must move these assertions with it rather than break them. */
const DECLARED = BOTH.worker.replaceAll(".", "\\.");

test("#5556 positive control: HEAD resolves the declared worker and 0.13.0 is installed -> refused, naming both numbers and the remedy, and REPAIRABLE", () => {
  const { refusal, notes, repairable } = judged(planeOf({ installed: { worker: "0.13.0", fleet: BOTH.fleet }, locked: BOTH }));
  assert.ok(refusal, "the plane that stopped the canary must be reported");
  assert.match(refusal, new RegExp(String.raw`layer nvda-worker \(@a11ign\/screenreader-worker\): installed 0\.13\.0 under \/root\/control\/node_modules, the plane's lockfile resolves ${DECLARED}, deploy-pins\.json declares ${DECLARED}`));
  assert.match(refusal, /the repair is pnpm install --frozen-lockfile in \/root\/control, which fleet:deploy runs once/);
  assert.doesNotMatch(refusal, /screenreader-fleet/, "the layer that is in step is not named");
  assert.deepEqual(notes, []);
  assert.equal(repairable, true);
});

test("#5556 the read prints the importer's release, not the transitive 0.9.0 entry beside it", () => {
  const out = readOf(planeOf({ installed: BOTH, locked: BOTH }));
  assert.match(out, new RegExp(`^nvda-worker ${BOTH.worker} ${BOTH.worker}$`, "m"));
  assert.match(out, new RegExp(`^screenreader-fleet ${BOTH.fleet} ${BOTH.fleet}$`, "m"), "a version with peer suffixes is read as its release");
});

test("#5556 installed layers equal to the declaration are not reported", () => {
  assert.deepEqual(judged(planeOf({ installed: BOTH, locked: BOTH })), { refusal: null, notes: [], repairable: false });
});

test("#5556 no installed release, with HEAD on the declared lockfile, is refused as 'no release is installed' and REPAIRABLE: the frozen install lays what the lockfile names", () => {
  const { refusal, repairable } = judged(planeOf({ installed: { fleet: BOTH.fleet }, locked: BOTH }));
  assert.match(refusal ?? "", new RegExp(String.raw`no release is installed under \/root\/control\/node_modules, the plane's lockfile resolves ${DECLARED}`));
  assert.match(refusal ?? "", /the repair is pnpm install --frozen-lockfile in \/root\/control/);
  assert.equal(repairable, true);
});

test("#5556 no release installed AND the lockfile names none is NOT repairable: an install has nothing it can lay", () => {
  const { refusal, repairable } = judged(planeOf({ installed: { fleet: BOTH.fleet }, locked: { worker: "none", fleet: BOTH.fleet } }));
  assert.match(refusal ?? "", /fleet:deploy does not install for this/);
  assert.equal(repairable, false);
});

test("#5556 a plane whose own lockfile is behind is a NOTE, never a refusal: the move is what brings it forward", () => {
  const behind = { worker: "0.13.0", fleet: "0.10.2" };
  const { refusal, notes, repairable } = judged(planeOf({ installed: behind, locked: behind }));
  assert.equal(refusal, null, "refusing here would make the move, and so the install after it, unreachable");
  assert.equal(notes.length, 2);
  assert.equal(repairable, false, "an install here would lay the OLD lockfile");
  assert.match(notes[0], new RegExp(String.raw`installed 0\.13\.0 .* resolves 0\.13\.0, deploy-pins\.json declares ${DECLARED}: the plane's checkout is behind`));
});

test("#5155 a lag BESIDE a layer behind its own lockfile is NOT repairable: an install before the move would lay the old lockfile for that layer too", () => {
  const mixed = judged(planeOf({ installed: { worker: "0.13.0", fleet: "0.10.2" }, locked: { worker: BOTH.worker, fleet: "0.10.2" } }));
  assert.equal(mixed.repairable, false, "the repairable lag is not repaired while another layer is behind");
  assert.match(mixed.refusal ?? "", new RegExp(String.raw`layer nvda-worker .*installed 0\.13\.0 .* resolves ${DECLARED}`), "the lag is still named");
  assert.doesNotMatch(mixed.refusal ?? "", /the repair is pnpm install/);
  assert.equal(mixed.notes.length, 1, "the layer behind is a note, as it is alone");
  assert.match(mixed.notes[0], /layer screenreader-fleet .*installed 0\.10\.2 .* resolves 0\.10\.2/);
});

test("#5556 a layer held as a clone is judged by the move's own branch, not by node_modules", () => {
  const { refusal, notes } = judged(planeOf({ installed: { fleet: BOTH.fleet }, locked: BOTH, clone: true }));
  assert.deepEqual({ refusal, notes }, { refusal: null, notes: [] });
});

test("#5556 a layer the read printed no line for is refused, not read as in step", () => {
  const { refusal } = installedLayersJudged(MANIFEST, "");
  assert.match(refusal ?? "", /returned no line for it/);
});

test("#5556 an unreadable plane (no lockfile entry, no installed release) is refused, never read as merely behind", () => {
  const { refusal, notes } = judged(planeOf({}));
  assert.deepEqual(readOf(planeOf({})).trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")), ["none none", "none none"], "the read really printed the unknown state");
  assert.match(refusal ?? "", /the lockfile names no release for it \(or could not be read\)/);
  assert.deepEqual(notes, []);
  const { refusal: halfRead } = judged(planeOf({ installed: { worker: "0.13.0", fleet: BOTH.fleet } }));
  assert.match(halfRead ?? "", /installed 0\.13\.0 under .* the plane's lockfile resolves no release/, "an unreadable lockfile alone is also unknown");
});

test("#5556 an unreadable lockfile is refused even where the installed release equals the declaration", () => {
  const core = planeOf({ installed: BOTH });
  assert.deepEqual(readOf(core).trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")), [`${BOTH.worker} none`, `${BOTH.fleet} none`], "the read really printed installed-equals-declared beside an unknown lockfile");
  const { refusal, notes } = judged(core);
  assert.match(refusal ?? "", new RegExp(String.raw`layer nvda-worker .* installed ${DECLARED} under .* the plane's lockfile resolves no release, deploy-pins\.json declares ${DECLARED}: the lockfile names no release for it \(or could not be read\)`));
  assert.match(refusal ?? "", /layer screenreader-fleet/, "each layer whose lockfile cannot be read is named");
  assert.deepEqual(notes, []);
  assert.deepEqual(judged(planeOf({ installed: BOTH, locked: BOTH })), { refusal: null, notes: [], repairable: false }, "the same installed layers WITH a readable lockfile are in step");
});
