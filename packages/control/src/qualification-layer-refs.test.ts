/**
 * #3920: THE LAYERS A QUALIFIED RUN IS PINNED TO COME FROM THE SHA'S OWN LOCKFILE.
 *
 * `lab-layer-checkouts.yml` refuses a job whose `layer_refs` does not name every layer that lives in its own repository, and
 * nothing in the `--qualify-sha` path supplied them, so every qualified run refused, posted `failure` and was re-run into the same
 * refusal (four `failure` statuses on one sha, none about the gate). `ceo` ruled where they come from: the lockfile AT the sha,
 * resolved to a commit on each layer's remote, by the poster, never typed by an operator, and a tag the remote lacks is a refusal.
 *
 * The git here is REAL: a layer repository carrying an annotated and a lightweight tag, and a core repository whose commits carry
 * the lockfiles, so `show`, `ls-remote` and the peeling of an annotated tag are the shipped ones and not a stand-in for them.
 */
// no-token: none -- local git repositories in a temp directory, no `gh`, no network, no ansible.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.mjs";
import { layerDeclaration, layerPinTag, separateLayers } from "./layer-checkouts.mjs";
import { layerRefsFor, packageOfLayer, qualificationRequest, withLayerRefs } from "./qualification-run.mjs";

const SHA = "308b2de5bbd8a1f0c4e7d9b3a6f2e1d0c9b8a7f6";
const FULL_SHA = /^[0-9a-f]{40}$/;

const scratch: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "qualification-layer-refs-"));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, env: sandboxGitEnv(), encoding: "utf8" }).trim();

/** A repository with two commits, an ANNOTATED tag on the first and a LIGHTWEIGHT one on the second. */
function layerRepository({ package: name, annotated, lightweight }: { package: string, annotated: string, lightweight: string }) {
  const dir = join(newDir(), `${name}.git`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "f"), "one\n");
  git(dir, "add", "f");
  git(dir, "commit", "-qm", "one");
  const first = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "f"), "two\n");
  git(dir, "commit", "-qam", "two");
  const second = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "-a", "-m", "annotated", `@a11ign/${name}@${annotated}`, first);
  git(dir, "tag", `@a11ign/${name}@${lightweight}`, second);
  return { dir, first, second };
}

/** A lockfile in the shape `pnpm` writes it: the root importer's entries, two spaces deeper each level. */
const lockfileWith = (pins: Record<string, string>) => [
  "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:",
  ...Object.entries(pins).flatMap(([name, version]) => [`      '@a11ign/${name}':`, `        specifier: ^${version}`, `        version: ${version}`]),
  "",
].join("\n");

/** A core repository whose one commit carries `lockfile`, and the `git` that reads it, as the poster's own is bound to a checkout. */
function coreAt(lockfile: string) {
  const dir = join(newDir(), "core");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "pnpm-lock.yaml"), lockfile);
  git(dir, "add", "pnpm-lock.yaml");
  git(dir, "commit", "-qm", "lockfile");
  const sha = git(dir, "rev-parse", "HEAD");
  const run = (args: string[]) => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { sha, dir, git: run };
}

/** Two layers as `layers.json` declares them (the layer's key is NOT always its package: `nvda-worker` is `screenreader-worker`). */
function fixtureLayers() {
  const worker = layerRepository({ package: "screenreader-worker", annotated: "0.2.0", lightweight: "0.3.0" });
  const fleet = layerRepository({ package: "screenreader-fleet", annotated: "0.5.0", lightweight: "0.5.1" });
  return {
    worker, fleet,
    layers: [{ name: "nvda-worker", remote: worker.dir }, { name: "screenreader-fleet", remote: fleet.dir }],
  };
}

test("POSITIVE CONTROL: a lockfile pinning a version whose tag the remote lacks REFUSES, naming the layer, the tag and the remote", () => {
  const made = fixtureLayers();
  const core = coreAt(lockfileWith({ "screenreader-worker": "0.1.0", "screenreader-fleet": "0.5.1" }));
  const found = layerRefsFor({ sha: core.sha, git: core.git, layers: made.layers });
  assert.ok("refusal" in found, "a pin with no tag is not answered with a commit");
  assert.match(found.refusal, /layer nvda-worker is pinned at @a11ign\/screenreader-worker@0\.1\.0 by the lockfile/);
  assert.ok(found.refusal.includes(made.layers[0].remote), "the remote is named");
  assert.doesNotMatch(found.refusal, /screenreader-fleet/, "the layer that DID resolve is not blamed");
  assert.match(found.refusal, /Nothing was posted or dispatched/);
});

test("a fixture whose both pins resolve yields the two commits: the PEELED one for an annotated tag, the tag's own for a lightweight one", () => {
  const made = fixtureLayers();
  const core = coreAt(lockfileWith({ "screenreader-worker": "0.2.0", "screenreader-fleet": "0.5.1" }));
  const found = layerRefsFor({ sha: core.sha, git: core.git, layers: made.layers });
  assert.deepEqual(found, { layer_refs: { "nvda-worker": made.worker.first, "screenreader-fleet": made.fleet.second } });
  assert.match(made.worker.first, FULL_SHA);
  const tag = execFileSync("git", ["-C", made.layers[0].remote, "rev-parse", "@a11ign/screenreader-worker@0.2.0"], { env: sandboxGitEnv(), encoding: "utf8" }).trim();
  assert.notEqual(tag, made.worker.first, "the annotated tag is its own object, so the commit is what was PEELED, not the tag's sha");
});

test("the lockfile read is the one AT the sha, not the one in the working tree", () => {
  const made = fixtureLayers();
  const core = coreAt(lockfileWith({ "screenreader-worker": "0.2.0", "screenreader-fleet": "0.5.0" }));
  writeFileSync(join(core.dir, "pnpm-lock.yaml"), lockfileWith({ "screenreader-worker": "0.3.0", "screenreader-fleet": "0.5.1" }));
  git(core.dir, "commit", "-qam", "moves on");
  const found = layerRefsFor({ sha: core.sha, git: core.git, layers: made.layers });
  assert.deepEqual(found, { layer_refs: { "nvda-worker": made.worker.first, "screenreader-fleet": made.fleet.first } },
    "the sha's pins (0.2.0, 0.5.0), not HEAD's (0.3.0, 0.5.1)");
});

test("a pin the lockfile does not hold, and a remote that cannot be asked, are refusals that say which", () => {
  const made = fixtureLayers();
  const none = coreAt(lockfileWith({ "screenreader-fleet": "0.5.1" }));
  const unpinned = layerRefsFor({ sha: none.sha, git: none.git, layers: made.layers });
  assert.ok("refusal" in unpinned);
  assert.match(unpinned.refusal, /layer nvda-worker .*pnpm-lock\.yaml has no importer entry for @a11ign\/screenreader-worker/);
  const core = coreAt(lockfileWith({ "screenreader-worker": "0.2.0", "screenreader-fleet": "0.5.1" }));
  const gone = layerRefsFor({ sha: core.sha, git: core.git, layers: [{ name: "nvda-worker", remote: join(newDir(), "screenreader-worker.git") }] });
  assert.ok("refusal" in gone);
  assert.match(gone.refusal, /could not be asked for @a11ign\/screenreader-worker@0\.2\.0/, "git not answering is not 'the remote holds no such tag'");
  assert.doesNotMatch(gone.refusal, /holds no such tag/);
});

test("a sha this checkout does not hold is a refusal naming it, never a lockfile read from somewhere else", () => {
  const made = fixtureLayers();
  const core = coreAt(lockfileWith({ "screenreader-worker": "0.2.0", "screenreader-fleet": "0.5.1" }));
  const found = layerRefsFor({ sha: SHA, git: core.git, layers: made.layers });
  assert.ok("refusal" in found);
  assert.ok(found.refusal.includes(SHA.slice(0, 12)));
  assert.match(found.refusal, /pnpm-lock\.yaml could not be read/);
});

test("a pinned version that is not a registry release, or that would be a glob, never reaches `git ls-remote`", () => {
  const made = fixtureLayers();
  const core = coreAt(lockfileWith({ "screenreader-worker": "link:../nvda-worker", "screenreader-fleet": "0.5.1" }));
  const asked: string[][] = [];
  const found = layerRefsFor({ sha: core.sha, git: (args) => { asked.push(args); return core.git(args); }, layers: made.layers });
  assert.ok("refusal" in found);
  assert.match(found.refusal, /not a registry release/);
  assert.ok(!asked.some((args) => args.includes("ls-remote") && args.some((arg) => arg.includes("link:"))), "the unreleasable pin asked nothing of the remote");
});

test("the layer is named for its package by its repository, and the two real layers come out as the lockfile spells them", () => {
  assert.equal(packageOfLayer({ name: "nvda-worker", remote: "https://github.com/a11ign/screenreader-worker.git" }), "screenreader-worker");
  const names = separateLayers();
  assert.ok(names.includes("nvda-worker") && names.includes("screenreader-fleet"), "both layers are declared with a repository of their own");
  const real = readFileSync(fileURLToPath(new URL("../layers.json", import.meta.url)), "utf8");
  assert.ok(real.includes("screenreader-worker.git"), "the manifest this reads is the one that declares them");
  for (const name of names) {
    const { remote } = layerDeclaration(name);
    assert.ok(remote !== undefined);
    const pin = layerPinTag(lockfileWith({ [packageOfLayer({ name, remote })]: "1.2.3" }), packageOfLayer({ name, remote }));
    assert.deepEqual(pin, { tag: `@a11ign/${packageOfLayer({ name, remote })}@1.2.3` }, `${name}'s package is the one its lockfile entry names`);
  }
});

test("withLayerRefs adds ONE `-e` naming every layer to the argv, and an unresolved layer refuses before an argv exists", () => {
  const request = { sha: SHA, row: 3289, argv: ["-e", "job=gate-stability", "-e", `ref=${SHA}`] };
  const pinned = withLayerRefs(request, () => ({ layer_refs: { "nvda-worker": "a".repeat(40), "screenreader-fleet": "b".repeat(40) } }));
  assert.ok(!("refusal" in pinned));
  assert.deepEqual(pinned.argv.slice(0, 4), request.argv, "what the caller named is untouched");
  assert.deepEqual(pinned.argv.slice(4), ["-e", JSON.stringify({ layer_refs: { "nvda-worker": "a".repeat(40), "screenreader-fleet": "b".repeat(40) } })]);
  const refused = withLayerRefs(request, () => ({ refusal: "layer nvda-worker is pinned at X, and R holds no such tag." }));
  assert.deepEqual(refused, { refusal: "REFUSING --qualify-sha=: layer nvda-worker is pinned at X, and R holds no such tag." });
});

test("an operator-typed layer_refs is REFUSED, not merged: a second pin that could disagree with the lockfile's", () => {
  const typed = { sha: SHA, row: 3289, argv: ["-e", "job=gate-stability", "-e", `{"layer_refs": {"nvda-worker": "${"c".repeat(40)}"}}`, "-e", `ref=${SHA}`] };
  let asked = 0;
  const refused = withLayerRefs(typed, () => { asked += 1; return { layer_refs: {} }; });
  assert.ok("refusal" in refused);
  assert.match(refused.refusal, /layer_refs is set from the lockfile/);
  assert.equal(asked, 0, "the lockfile was not even read");
  const request = qualificationRequest(["-e", "job=gate-stability", `--qualify-sha=${SHA}`], { job: "gate-stability", row: "3289", ref: undefined, describeOnly: false });
  assert.ok(request !== undefined && !("refusal" in request), "the control: the same request without the typed ref is accepted");
});
