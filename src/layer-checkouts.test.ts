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
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { layerPinTag, layersFrom, releaseTag } from "./layer-checkouts.ts";
import { workerSourceDirty } from "../../worker-fleet/src/code-drift.ts";
import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.ts";
import { withGitSandbox } from "../../../scripts/test-support/git-sandbox.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

/**
 * THE LAYER IS NOT IN THIS TREE (#3447): it lives in `a11ign/screenreader-worker`, and a host holds a checkout of it. A copy of the
 * PUBLISHED package stands in for that checkout, placed at the path `layers.json` declares in a root of its own, so these tests
 * run the real resolver over the real manifest and the real worker files, and name no path into the tree they are in.
 */
const MANIFEST = JSON.parse(read("packages/control/layers.json"));
const PUBLISHED = dirname(createRequire(import.meta.url).resolve("@a11ign/screenreader-worker/package.json"));
const CHECKOUT = mkdtempSync(join(tmpdir(), "layer-checkout-"));
cpSync(PUBLISHED, join(CHECKOUT, MANIFEST.layers["nvda-worker"].path), { recursive: true, filter: (src) => !/(^|\/)node_modules(\/|$)/.test(src.slice(PUBLISHED.length)) });
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
  "packages/worker-fleet/src/check-worker-code.ts",
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

test("layers.json declares nvda-worker and screenreader-fleet and NOTHING else, listed by hand", () => {
  const manifest = JSON.parse(read("packages/control/layers.json"));
  assert.deepEqual(Object.keys(manifest.layers), ["nvda-worker", "screenreader-fleet"]);
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
  assert.deepEqual(walk(join(layerSourceDir("nvda-worker"), "code-version.mjs")), []);
  assert.ok(seen.size >= 2, "the walk reached code-version.mjs and its sibling worker-files.mjs");
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

/** A laid tree as `scripts/lay-layer.mjs` leaves it: `src/` and `.layer-ref`, and no `.git`. */
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

const pinnedAt = (layer: string, version: string) =>
  layerPinTag(`importers:\n\n  .:\n    dependencies:\n      '@a11ign/${layer}':\n        specifier: ^${version}\n        version: ${version}\n`, layer);

test("#4363 layerPinTag names the tag the layer's repository made: v<semver> from its first flat version, <package>@<version> before it", () => {
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
const CORE_LAY_LAYER = join(REPO, "scripts/lay-layer.mjs");

/** Why the agreement test cannot run here, or `false` when it can: a core older than `releaseTag` (what `ci.yml`'s `CORE_REF` may still pin) has no first copy to compare with. */
function noFirstCopy(): string | false {
  if (!existsSync(CORE_LAY_LAYER)) return `${CORE_LAY_LAYER} is not reachable from this checkout, so there is no first copy to compare the second with`;
  if (!/export function releaseTag\(/.test(readFileSync(CORE_LAY_LAYER, "utf8"))) return `${CORE_LAY_LAYER} does not export releaseTag (a core older than a11ign/a11ign #4119), so there is no first copy to compare the second with`;
  return false;
}

test("#4363 BARE_TAGS_FROM is a second copy of the core's, and releaseTag agrees with scripts/lay-layer.mjs's over every boundary", {
  skip: noFirstCopy(),
}, async () => {
  const theirs = (await import(pathToFileURL(CORE_LAY_LAYER).href)) as { releaseTag: (name: string, version: string) => string; };
  const versions = ["0.0.1", "0.2.9", "0.2.0", "0.3.0", "0.3.1", "0.4.0", "0.5.0", "0.5.2", "0.5.3", "0.5.4", "0.6.0", "1.0.0", "2.0.0", "0.3.0-rc.1"];
  for (const name of ["@a11ign/screenreader-worker", "@a11ign/screenreader-fleet", "@a11ign/scorer"]) {
    for (const version of versions) assert.equal(releaseTag(name, version), theirs.releaseTag(name, version), `${name}@${version}`);
  }
  assert.equal(theirs.releaseTag("@a11ign/screenreader-fleet", "0.5.3"), "v0.5.3", "positive control: the core's own function was reached and does flatten");
});
