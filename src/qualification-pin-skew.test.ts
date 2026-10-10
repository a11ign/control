/**
 * a11ign/a11ign#4863: A SHA WHOSE LAB PIN IS OLDER THAN THE PLAYBOOK IS REFUSED BEFORE `pending`, AND POSTS NOTHING.
 *
 * `--qualify-sha` on `7c87a6a9` (a11ign/a11ign#4860, #4862) pinned lab v0.1.24, which holds `scripts/stability-gate.mjs` only, while
 * `ansible/lab-job.yml` runs `packages/lab/scripts/stability-gate.ts`. Both attempts died a second after they started with
 * `ERR_MODULE_NOT_FOUND`, nothing reached a worker, the poster wrote `failure` twice, and the release raised a regression. Nothing
 * refused that launch, because `withLayerRefs` read the lockfile's layers and the lab is not one of them.
 *
 * The git here is REAL, as `qualification-layer-refs.test.ts`'s is: a lab repository carrying one tag per layout under test and a
 * core repository whose commit carries the `layers.json` that pins one of them, so `show`, `ls-remote`, the shallow `fetch` and the
 * `ls-tree` are the shipped ones and not a stand-in. What is faked is only the dispatch and the status poster, at `run()`'s own seams.
 */
// no-token: none -- local git repositories in a temp directory, no `gh`, no network, no ansible.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.ts";
import { run } from "./lab-job.ts";
import { postQualificationStatus } from "./post-qualification-status.ts";
import { labPinRefusal, layerRefsFor, playbookLabScripts, qualifiedPinsFor, type Git } from "./qualification-run.ts";

const CATALOGUE = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");
const SCRIPT = "packages/lab/scripts/stability-gate.ts";
/** How much of a sha a refusal quotes, and the exit `run()` gives a refused launch. */
const ABBREVIATED_SHA = 12;
const REFUSED = 3;

const scratch: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "qualification-pin-skew-"));
  scratch.push(dir);
  return dir;
};
after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, env: sandboxGitEnv(), encoding: "utf8" }).trim();

function commitFiles(dir: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", message);
}

/**
 * A lab repository with one commit per tag, each holding exactly the files named for it: the tag a release made, the way the lab's
 * `v0.1.24` (the `.mjs` only) and `v0.1.28` (the `.ts`) differ. The tag `annotated` is annotated, the rest lightweight.
 */
function labRepository(tags: Record<string, { files: string[]; annotated?: boolean }>) {
  const dir = join(newDir(), "lab.git");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [tag, { files, annotated }] of Object.entries(tags)) {
    git(dir, "rm", "-rqf", "--ignore-unmatch", ".");
    commitFiles(dir, Object.fromEntries(files.map((file) => [file, `${tag}\n`])), tag);
    if (annotated) git(dir, "tag", "-a", "-m", tag, tag);
    else git(dir, "tag", tag);
  }
  return dir;
}

type LabDeclaration = { path?: string; source?: string; remote: string; tag: string };

/** A core repository whose one commit carries a lockfile and the `layers.json` that pins the lab as `lab`; `git` reads it as the poster's does. */
function coreAt(lab: LabDeclaration | undefined, lockfile = "lockfileVersion: '9.0'\n") {
  const dir = join(newDir(), "core");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  const manifest = { layers: {}, pinned: lab === undefined ? {} : { lab: { path: "packages/lab", ...lab } } };
  commitFiles(dir, { "pnpm-lock.yaml": lockfile, "layers.json": JSON.stringify(manifest) }, "core");
  const calls: string[][] = [];
  const asked: Git = (args) => {
    calls.push(args);
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: sandboxGitEnv() });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { sha: git(dir, "rev-parse", "HEAD"), dir, git: asked, calls };
}

const OLD_LAB = ["scripts/stability-gate.mjs", "src/gates/qualification-status.mjs"];
const NEW_LAB = ["scripts/stability-gate.mjs", "scripts/stability-gate.ts", "src/gates/qualification-status.ts"];

function fixtureLab() {
  return labRepository({ "v0.1.24": { files: OLD_LAB }, "v0.1.28": { files: NEW_LAB, annotated: true } });
}

const pins = (core: ReturnType<typeof coreAt>) => qualifiedPinsFor({ sha: core.sha, git: core.git, layers: [], catalogueText: CATALOGUE });

test("POSITIVE CONTROL: a sha whose lab pin holds no `scripts/stability-gate.ts` is refused, naming the sha, the tag and the path", () => {
  const remote = fixtureLab();
  const core = coreAt({ remote, tag: "v0.1.24", source: "." });
  const found = pins(core);
  assert.ok("refusal" in found, "a lab that predates the script the playbook runs is not answered with layer refs");
  assert.ok(found.refusal.includes(core.sha.slice(0, ABBREVIATED_SHA)), "the sha is named");
  assert.ok(found.refusal.includes("v0.1.24") && found.refusal.includes(remote), "the lab tag and where it was asked are named");
  assert.ok(found.refusal.includes("scripts/stability-gate.ts"), "the missing path is named");
  assert.match(found.refusal, /superseded by the next release sha/);
  assert.match(found.refusal, /not re-run/);
  assert.match(found.refusal, /Nothing was posted or dispatched/);
});

test("NEGATIVE CONTROL: the same core pinning the lab tag that DOES hold the script is not refused, so the refusal above is the script's absence", () => {
  const remote = fixtureLab();
  const core = coreAt({ remote, tag: "v0.1.28", source: "." });
  assert.deepEqual(pins(core), { layer_refs: {} }, "an ANNOTATED tag is peeled to its commit and its tree read");
});

test("the script is looked for where the sha's layers.json says the lab is in ITS repository, not where it is laid", () => {
  const nested = labRepository({ "v0.1.12": { files: ["packages/lab/scripts/stability-gate.ts"] }, "v0.1.13": { files: ["scripts/stability-gate.ts"] } });
  // `source` absent: the lab is at `path` in its repository (v0.1.12's layout).
  assert.deepEqual(pins(coreAt({ remote: nested, tag: "v0.1.12" })), { layer_refs: {} }, "no `source` means the same path at both ends");
  assert.deepEqual(pins(coreAt({ remote: nested, tag: "v0.1.13", source: "." })), { layer_refs: {} }, "`source: .` means the root");
  const wrong = pins(coreAt({ remote: nested, tag: "v0.1.13" }));
  assert.ok("refusal" in wrong, "a root-layout tag read as if the lab were nested does not hold the script");
  assert.match(wrong.refusal, /packages\/lab\/scripts\/stability-gate\.ts/);
});

test("a path that merely CONTAINS the script's name is not the script", () => {
  const remote = labRepository({ "v0.1.30": { files: ["scripts/old/stability-gate.ts", "scripts/stability-gate.ts.bak"] } });
  const found = pins(coreAt({ remote, tag: "v0.1.30", source: "." }));
  assert.ok("refusal" in found);
});

test("the layers are read first: a sha with a layer problem is refused with exactly the words it had before the lab was asked", () => {
  const layer = join(newDir(), "screenreader-worker.git");
  mkdirSync(layer);
  git(layer, "init", "-q", "-b", "main");
  commitFiles(layer, { f: "one\n" }, "one");
  git(layer, "tag", "v0.3.0");
  const lockfile = ["importers:", "  .:", "    dependencies:", "      '@a11ign/screenreader-worker':", "        specifier: ^0.4.0", "        version: 0.4.0", ""].join("\n");
  const lab = fixtureLab();
  const core = coreAt({ remote: lab, tag: "v0.1.24", source: "." }, lockfile);
  const layers = [{ name: "nvda-worker", remote: layer, package: "screenreader-worker" }];
  const before = layerRefsFor({ sha: core.sha, git: core.git, layers });
  assert.ok("refusal" in before);
  assert.match(before.refusal, /layer nvda-worker is pinned at v0\.4\.0 by the lockfile/, "the #4465 class: a layer tag the remote lacks");
  const calls = core.calls.length;
  const after = qualifiedPinsFor({ sha: core.sha, git: core.git, layers, catalogueText: CATALOGUE });
  assert.deepEqual(after, before, "the layer refusal is unchanged");
  assert.ok(!core.calls.slice(calls).some((args) => args.includes(lab)), "and the lab was not asked");
});

test("git not answering is a refusal that says so, never `the script is missing`, and an absent tag says that instead", () => {
  const gone = pins(coreAt({ remote: join(newDir(), "lab.git"), tag: "v0.1.24", source: "." }));
  assert.ok("refusal" in gone);
  assert.match(gone.refusal, /could not be asked for v0\.1\.24/);
  assert.doesNotMatch(gone.refusal, /holds no scripts|ERR_MODULE_NOT_FOUND/);
  const noTag = pins(coreAt({ remote: fixtureLab(), tag: "v9.9.9", source: "." }));
  assert.ok("refusal" in noTag);
  assert.match(noTag.refusal, /holds no such tag/);
});

test("a sha that pins no lab, or one with a remote that is not an https clone URL, is a refusal and asks nothing of git's remotes", () => {
  const none = pins(coreAt(undefined));
  assert.ok("refusal" in none);
  assert.match(none.refusal, /declares no pinned layer lab/);
  const hostile = coreAt({ remote: "ext::sh -c touch${IFS}/tmp/x", tag: "v0.1.28", source: "." });
  const refused = pins(hostile);
  assert.ok("refusal" in refused);
  assert.match(refused.refusal, /https clone URL \(or an absolute path\)/);
  assert.ok(!hostile.calls.some((args) => args.includes("ls-remote") || args.includes("fetch") && args.includes("--depth=1")), "nothing was asked of that remote");
});

test("a sha this checkout does not hold is a refusal naming it", () => {
  const core = coreAt({ remote: fixtureLab(), tag: "v0.1.28", source: "." });
  const found = labPinRefusal({ sha: "308b2de5bbd8a1f0c4e7d9b3a6f2e1d0c9b8a7f6", git: core.git, scripts: [SCRIPT] });
  assert.ok(found !== undefined && found.includes("308b2de5bbd8") && /layers\.json could not be read/.test(found));
});

test("the playbook's script is READ from the catalogue, and a catalogue that cannot say refuses rather than reading as `nothing to hold`", () => {
  assert.deepEqual(playbookLabScripts({ catalogueText: CATALOGUE, job: "gate-stability", labPath: "packages/lab" }), { scripts: [SCRIPT] },
    "the real playbook's gate-stability runs one lab script (POSITIVE CONTROL: the list this check asks for is not empty)");
  const moved = CATALOGUE.replaceAll(SCRIPT, "packages/lab/scripts/stability-gate-two.ts");
  assert.deepEqual(playbookLabScripts({ catalogueText: moved, job: "gate-stability", labPath: "packages/lab" }),
    { scripts: ["packages/lab/scripts/stability-gate-two.ts"] }, "a rename in the playbook is followed, with no second copy of the name to forget");
  const renamed = playbookLabScripts({ catalogueText: CATALOGUE, job: "no-such-job", labPath: "packages/lab" });
  assert.ok("refusal" in renamed);
  const elsewhere = playbookLabScripts({ catalogueText: CATALOGUE.replaceAll(SCRIPT, "scripts/elsewhere/stability-gate.ts"), job: "gate-stability", labPath: "packages/lab" });
  assert.ok("refusal" in elsewhere, "no entry under the lab's path is a refusal, not an empty list");
});

test("through `run()`: the refusal exits 3 on stderr BEFORE `pending`, so no status is posted and nothing is dispatched", async () => {
  const core = coreAt({ remote: fixtureLab(), tag: "v0.1.24", source: "." });
  const events: string[] = [];
  const qualify = {
    post: (input: Parameters<typeof postQualificationStatus>[0]) => postQualificationStatus({
      ...input, gh: () => { events.push("post"); return { status: 0, stdout: "{}", stderr: "", missing: false }; } }),
    readRecord: () => undefined as never,
    layerRefs: (sha: string) => qualifiedPinsFor({ sha, git: core.git, layers: [], catalogueText: CATALOGUE }),
    now: () => 0,
    say: () => {},
  };
  const argv = ["-e", "job=gate-stability", "-e", "worker=a11y-worker-2", "-e", "row=4863", `--qualify-sha=${core.sha}`];
  const realExit = process.exit;
  const realErr = process.stderr.write;
  let exited: number | undefined;
  let stderr = "";
  process.exit = ((code: number) => { exited = code; throw new Error(`exit ${code}`); }) as never;
  process.stderr.write = ((text: string) => { stderr += text; return true; }) as never;
  try {
    await run(argv, {
      catalogueText: CATALOGUE, readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" }] }),
      dispatch: () => { events.push("dispatch"); return 0; }, qualify });
  } catch (error) {
    if (!/^exit \d$/.test((error as Error).message)) throw error;
  } finally {
    process.exit = realExit;
    process.stderr.write = realErr;
  }
  assert.equal(exited, REFUSED);
  assert.match(stderr, /^REFUSING --qualify-sha=: .*v0\.1\.24.*scripts\/stability-gate\.ts.*superseded by the next release sha/);
  assert.deepEqual(events, [], "no post, so no pending or failure is left standing on the sha, and no dispatch");
});
