/**
 * #3920, rewritten by #5085: THE LAYERS A QUALIFIED RUN IS PINNED TO COME FROM CONTROL'S OWN DECLARATION.
 *
 * `lab-layer-checkouts.yml` refuses a job whose `layer_refs` does not name every layer that lives in its own repository, and
 * nothing in the `--qualify-sha` path supplied them, so every qualified run refused, posted `failure` and was re-run into the same
 * refusal (four `failure` statuses on one sha, none about the gate). `ceo` ruled where they come from: resolved to a commit on each
 * layer's remote, by the poster, never typed by an operator, and a tag the remote lacks is a refusal. They were read from the sha's
 * lockfile until control stopped reading another repository's declarations (ADR 0045 rule 3); they are `deploy-pins.json`'s releases now.
 *
 * The git here is REAL: a layer repository carrying an annotated and a lightweight tag, so `ls-remote` and the peeling of an
 * annotated tag are the shipped ones and not a stand-in for them.
 */
// no-token: none -- local git repositories in a temp directory, no `gh`, no network, no ansible.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.ts";
import { layerDeclaration, separateLayers } from "./layer-checkouts.ts";
import { parseDeployPins, pinnedTag, readDeployPins, type DeployPins } from "./layer-pins.ts";
import { layerRefsFor, qualificationRequest, withLayerRefs } from "./qualification-run.ts";

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

/**
 * A repository with two commits, an ANNOTATED tag on the first and a LIGHTWEIGHT one on the second, each named in FULL: the tag a
 * repository really made (`v0.3.0` for `screenreader-worker` from 0.3.0, #4363), spelled out here so no fixture asks `releaseTag` what it should be.
 */
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
  git(dir, "tag", "-a", "-m", "annotated", annotated, first);
  git(dir, "tag", lightweight, second);
  return { dir, first, second };
}

/** `git`, as the poster's is bound to a checkout: `ls-remote` of a local repository needs no working directory of its own. */
const run = (args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8", env: sandboxGitEnv() });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const INTEGRITY = `sha512-${"A".repeat(86)}==`;

/** Two layer repositories, and the pins declaring them at the versions given: the layer's key is NOT always its package (`nvda-worker` is `screenreader-worker`). */
function fixtureLayers(versions: { worker: string; fleet: string; }, { workerRemote }: { workerRemote?: string; } = {}) {
  const worker = layerRepository({ package: "screenreader-worker", annotated: "@a11ign/screenreader-worker@0.2.0", lightweight: "v0.3.0" });
  const fleet = layerRepository({ package: "screenreader-fleet", annotated: "@a11ign/screenreader-fleet@0.5.0", lightweight: "@a11ign/screenreader-fleet@0.5.1" });
  // The flat release is the repository's third tag on the second commit (v0.5.3 is where `screenreader-fleet` moved, #4224).
  git(fleet.dir, "tag", "v0.5.3", fleet.second);
  const pins: DeployPins = { layers: {
    "nvda-worker": { package: "@a11ign/screenreader-worker", version: versions.worker, integrity: INTEGRITY, path: "packages/nvda-worker", remote: workerRemote ?? worker.dir },
    "screenreader-fleet": { package: "@a11ign/screenreader-fleet", version: versions.fleet, integrity: INTEGRITY, path: "packages/worker-fleet", remote: fleet.dir },
  } };
  return { worker, fleet, pins };
}

test("POSITIVE CONTROL: a pin whose tag the remote lacks REFUSES, naming the layer, the tag and the remote", () => {
  const made = fixtureLayers({ worker: "0.1.0", fleet: "0.5.1" });
  const found = layerRefsFor({ pins: made.pins, git: run });
  assert.ok("refusal" in found, "a pin with no tag is not answered with a commit");
  assert.match(found.refusal, /layer nvda-worker: .* holds no tag @a11ign\/screenreader-worker@0\.1\.0/);
  assert.ok(found.refusal.includes(made.worker.dir), "the remote is named");
  assert.doesNotMatch(found.refusal, /screenreader-fleet/, "the layer that DID resolve is not blamed");
  assert.match(found.refusal, /Nothing was posted or dispatched/);
});

test("a fixture whose both pins resolve yields the two commits: the PEELED one for an annotated tag, the tag's own for a lightweight one", () => {
  const made = fixtureLayers({ worker: "0.2.0", fleet: "0.5.1" });
  const found = layerRefsFor({ pins: made.pins, git: run });
  assert.deepEqual(found, { layer_refs: { "nvda-worker": made.worker.first, "screenreader-fleet": made.fleet.second } });
  assert.match(made.worker.first, FULL_SHA);
  const tag = execFileSync("git", ["-C", made.worker.dir, "rev-parse", "@a11ign/screenreader-worker@0.2.0"], { env: sandboxGitEnv(), encoding: "utf8" }).trim();
  assert.notEqual(tag, made.worker.first, "the annotated tag is its own object, so the commit is what was PEELED, not the tag's sha");
});

test("#4363 a pin at a repository's first flat version asks for `v<semver>`, and one before it for `<package>@<version>`: the tag the layer made", () => {
  const flat = fixtureLayers({ worker: "0.3.0", fleet: "0.5.3" });
  assert.deepEqual(layerRefsFor({ pins: flat.pins, git: run }),
    { layer_refs: { "nvda-worker": flat.worker.second, "screenreader-fleet": flat.fleet.second } }, "v0.3.0 and v0.5.3 resolve");
  const before = fixtureLayers({ worker: "0.2.0", fleet: "0.5.1" });
  assert.deepEqual(layerRefsFor({ pins: before.pins, git: run }),
    { layer_refs: { "nvda-worker": before.worker.first, "screenreader-fleet": before.fleet.second } }, "the older form still resolves");
  const missing = fixtureLayers({ worker: "0.4.0", fleet: "0.5.2" });
  const refused = layerRefsFor({ pins: missing.pins, git: run });
  assert.ok("refusal" in refused);
  assert.match(refused.refusal, /layer nvda-worker: .* holds no tag v0\.4\.0/, "a flat pin the remote lacks names the flat tag");
  assert.match(refused.refusal, /layer screenreader-fleet: .* holds no tag @a11ign\/screenreader-fleet@0\.5\.2/, "0.5.2 is still the older form");
});

test("a remote that cannot be asked is a refusal that says so, and is not 'the remote holds no such tag'", () => {
  const made = fixtureLayers({ worker: "0.2.0", fleet: "0.5.1" }, { workerRemote: join(newDir(), "screenreader-worker.git") });
  const gone = layerRefsFor({ pins: made.pins, git: run });
  assert.ok("refusal" in gone);
  assert.match(gone.refusal, /could not be asked for @a11ign\/screenreader-worker@0\.2\.0/, "git not answering is not 'the remote holds no such tag'");
  assert.doesNotMatch(gone.refusal, /holds no tag/);
});

test("a version that is a range, a link or a glob is refused when the declaration is read, so it never reaches `git ls-remote`", () => {
  const real = readDeployPins();
  for (const version of ["^0.2.0", "link:../nvda-worker", "0.*", "latest", "0.2.0 --upload-pack=x"]) {
    const read = parseDeployPins(JSON.stringify({ layers: { "nvda-worker": { ...real.layers["nvda-worker"], version } } }));
    assert.ok("refusal" in read, version);
    assert.match(read.refusal, /exact x\.y\.z/, version);
  }
  assert.ok("pins" in parseDeployPins(JSON.stringify({ layers: { "nvda-worker": real.layers["nvda-worker"] } })), "the control: the real entry is accepted");
});

test("every layer the real declaration names resolves to a release tag of its own package's repository", () => {
  const names = separateLayers();
  assert.deepEqual(names, ["nvda-worker", "screenreader-fleet"], "both layers are declared with a repository of their own");
  const pins = readDeployPins();
  for (const name of names) {
    const { remote, package: declared } = layerDeclaration(name);
    assert.ok(remote !== undefined && declared !== undefined);
    assert.ok(remote.endsWith(`/${declared.replace("@a11ign/", "")}.git`), `${name}: its remote is its package's repository`);
    // Both repositories tag `v<semver>` from the versions pinned here, which is what `ls-remote` is asked for.
    assert.deepEqual(pinnedTag(pins, name), { tag: `v${pins.layers[name].version}` }, `${name}'s tag is the flat release the pin names`);
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

test("an operator-typed layer_refs is REFUSED, not merged: a second pin that could disagree with the declaration's", () => {
  const typed = { sha: SHA, row: 3289, argv: ["-e", "job=gate-stability", "-e", `{"layer_refs": {"nvda-worker": "${"c".repeat(40)}"}}`, "-e", `ref=${SHA}`] };
  let asked = 0;
  const refused = withLayerRefs(typed, () => { asked += 1; return { layer_refs: {} }; });
  assert.ok("refusal" in refused);
  assert.match(refused.refusal, /layer_refs is set from deploy-pins\.json/);
  assert.equal(asked, 0, "the declaration was not even read");
  const request = qualificationRequest(["-e", "job=gate-stability", `--qualify-sha=${SHA}`], { job: "gate-stability", row: "3289", ref: undefined, worker: "a11y-worker-2", describeOnly: false });
  assert.ok(request !== undefined && !("refusal" in request), "the control: the same request without the typed ref is accepted");
});
