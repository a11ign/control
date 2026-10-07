// no-token: gh -- every test below runs `controlPlaneCheckout` (a pure string builder), a shell against a fixture
// checkout, a play against a fixture lab, or reads source text; none calls `readFleetGatedIssues` or any other
// path through fleet-playbook.mjs that runs `gh`, which is the only reason the import reaches the token.
/**
 * THE CONTROL PLANE AND THE LAB HANDLE THE LAYER'S CHECKOUT BESIDE THE CORE'S (ADR 0039 item 6, row 6c, #3396).
 *
 * Until a layer declares a `remote` nothing here moves, and that is the state today: the layer is inside the core
 * checkout. This pins the day it does. The control plane's move to a ref (`controlPlaneCheckout`, and
 * `lab:pipeline`'s own) and the lab's fetch (`run-job.yml`) and reset (`lab-reset.yml`) each have to carry the
 * layer's checkout, because a command that moves only the core leaves the layer wherever its branch last was, and
 * the host then runs a pair nobody chose and reads back a core commit that says it is fine.
 *
 * What is EXECUTED, not read as text: the control plane's shell against a real checkout and a real layer
 * repository, the lab's task files under `ansible-playbook` against the same, and the bootstrap's layer block
 * under `bash`. What is read as text: that each entry point calls them, which a CI job can only read. What none
 * of it shows is the control plane or the lab doing it: that is the fleet step on the row.
 *
 * POSITIVE CONTROL, in each of the three: a fixture whose layer checkout is MISSING REFUSES, naming the layer and
 * the path, and the core's own tree is left to answer for nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.mjs";
import { CONTROL_PLANE_CHECKOUT, CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";
import { controlPlaneCheckout } from "./fleet-playbook.mjs";
import { LAYER_REF, layerCheckoutMove, layersFrom } from "./layer-checkouts.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ANSIBLE = resolve(REPO, "packages/control/ansible");
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const FULL_SHA = /^[0-9a-f]{40}$/;
const ABSENT_PIN = "0".repeat(40);
const REFUSED = 4;

const LAYER = "fixture-layer";
const LAYER_PATH = "packages/fixture-layer-3396";
const REMOTE = "https://example.test/fixture-layer.git";
const SEPARATE = { layers: { [LAYER]: { path: LAYER_PATH, remote: REMOTE } } };
const INSIDE_THE_CORE = { layers: { [LAYER]: { path: LAYER_PATH } } };

/** Comments out: a verb named in PROSE is not a verb that runs. */
const codeText = (source: string) => source.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

const scratch: string[] = [];
const newDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "layer-control-lab-"));
  scratch.push(dir);
  return dir;
};
test.after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const GIT_IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...GIT_IDENTITY, ...args], { cwd, env: sandboxGitEnv(), encoding: "utf8" }).trim();

/** A layer repository with two commits, and a core checkout that holds a clone of it at the declared path. */
function fixture({ withLayerCheckout }: { withLayerCheckout: boolean }) {
  const root = newDir();
  const origin = join(root, "layer-origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  writeFileSync(join(origin, "f"), "one\n");
  git(origin, "add", "f");
  git(origin, "commit", "-qm", "one");
  const first = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "f"), "two\n");
  git(origin, "commit", "-qam", "two");
  const second = git(origin, "rev-parse", "HEAD");
  const core = join(root, "core");
  mkdirSync(join(core, "packages"), { recursive: true });
  git(core, "init", "-q", "-b", "main");
  const layerDir = join(core, LAYER_PATH);
  if (withLayerCheckout) {
    git(core, "clone", "-q", origin, layerDir);
    git(layerDir, "checkout", "-q", "--detach", second);
  }
  return { root, origin, core, layerDir, first, second };
}

/** Runs the control plane's shell against a stand-in checkout: the absolute path it names is swapped for the fixture's. */
function runOnControlPlane(command: string, core: string) {
  const local = command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, core);
  assert.ok(!local.includes(CONTROL_PLANE_CHECKOUT_PATH), "the swap left the real control-plane path in the command");
  return spawnSync("bash", ["-c", `true${local}`], { env: { ...sandboxGitEnv(), PATH: process.env.PATH }, encoding: "utf8" });
}

const fixtureMove = layersFrom({ manifest: SEPARATE, root: REPO }).layerCheckoutMove;

test("the control plane's move: with no layer in its own repository the command is the core's alone, unchanged", () => {
  assert.equal(layerCheckoutMove({}), "", "nothing pinned, nothing appended");
  assert.equal(controlPlaneCheckout("main", "a".repeat(40)),
    `cd ${CONTROL_PLANE_CHECKOUT} && git fetch --quiet --all && git checkout --quiet main `
    + `&& git merge --ff-only --quiet ${"a".repeat(40)}`);
});

test("the control plane's move puts the layer's checkout on its pin, beside the core's, and reads it back", () => {
  const { core, layerDir, first, second } = fixture({ withLayerCheckout: true });
  assert.equal(git(layerDir, "rev-parse", "HEAD"), second);
  assert.match(first, FULL_SHA);
  const run = runOnControlPlane(fixtureMove({ [LAYER]: first }), core);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(layerDir, "rev-parse", "HEAD"), first, "the layer must be on its pin, not where its branch was");
});

test("the layer's move is part of the core's command, after the core's own fast-forward", () => {
  const manifest = layersFrom({ manifest: SEPARATE, root: REPO });
  const text = manifest.layerCheckoutMove({ [LAYER]: "b".repeat(40) });
  assert.ok(text.startsWith(" && "), "appended to the core's command, so its failure fails the pair");
  assert.match(text, new RegExp(`git checkout --quiet --detach ${"b".repeat(40)}`));
  assert.match(text, /test "\$\(git rev-parse HEAD\)" = b{40}/, "the commit is read back inside the same command");
});

test("POSITIVE CONTROL: a layer whose checkout is missing REFUSES, naming the layer and the path, and moves nothing", () => {
  const { core, layerDir } = fixture({ withLayerCheckout: false });
  const run = runOnControlPlane(fixtureMove({ [LAYER]: ABSENT_PIN }), core);
  assert.equal(run.status, REFUSED, `expected the refusal's own exit status, got ${run.status}: ${run.stderr}`);
  assert.match(run.stderr, new RegExp(`layer ${LAYER} is declared at ${LAYER_PATH}`));
  assert.match(run.stderr, /does not stand in for it/);
  assert.equal(spawnSync("test", ["-e", layerDir]).status, 1, "nothing was created in its place");
});

test("a pin the layer does not have fails the command and leaves the layer where it was", () => {
  const { core, layerDir, second } = fixture({ withLayerCheckout: true });
  const run = runOnControlPlane(fixtureMove({ [LAYER]: ABSENT_PIN }), core);
  assert.notEqual(run.status, 0, "an unreachable pin must not read as landed");
  assert.equal(git(layerDir, "rev-parse", "HEAD"), second);
});

test("a layer with no repository of its own, or an unsafe path, cannot be pinned at all", () => {
  const inside = layersFrom({ manifest: INSIDE_THE_CORE, root: REPO });
  assert.throws(() => inside.layerCheckoutMove({ [LAYER]: ABSENT_PIN }), /no repository of its own/);
  const escaping = layersFrom({ manifest: { layers: { [LAYER]: { path: "../elsewhere", remote: REMOTE } } }, root: REPO });
  assert.throws(() => escaping.layerCheckoutMove({ [LAYER]: ABSENT_PIN }), /not a plain relative path/);
});

test("lab:pipeline moves the layer with the core: it knows --layer-ref, refuses a missing pin, and adds the move", () => {
  const source = codeText(read("packages/control/src/lab-pipeline.mjs"));
  assert.match(source, /refuseUnknownFlags\(\[[^\]]*"--layer-ref="/, "an unknown flag is refused, so a pin must be a KNOWN one");
  assert.match(source, /layerPins\(layerRefValues\(args\)\)/, "the pins are validated by the same decider `fleet:deploy` uses");
  const remote = source.slice(source.indexOf("const remote = `"), source.indexOf("systemctl stop"));
  assert.ok(remote.includes("git merge --quiet --ff-only origin/${ref}${layerMove}"),
    "the layer's move sits straight after the core's fast-forward, in the same chain");
  assert.match(source, /const layerMove = layerMoveOrRefuse\(args\);/);
});

test("fleet:deploy passes the layers' half of the pair to the control plane's move, not only to the guests", () => {
  const source = codeText(read("packages/control/src/fleet-playbook.mjs"));
  assert.match(source, /ssh\(controlPlaneCheckout\(ref, expected, layerCommits\)\)/);
});

// ---- the lab: run-job.yml and lab-reset.yml ----------------------------------------------------------------------

const LAB_FILES = ["tasks/lab-layer-checkouts.yml", "tasks/lab-layer-reset.yml"];

test("the lab's fetch and reset read the layers from the manifest, run in the LAYER's directory, and use lab_ref's pattern", () => {
  const runJob = codeText(readFileSync(resolve(ANSIBLE, "tasks/run-job.yml"), "utf8"));
  const reset = codeText(readFileSync(resolve(ANSIBLE, "lab-reset.yml"), "utf8"));
  assert.match(runJob, /include_tasks: lab-layer-checkouts\.yml/);
  assert.match(reset, /include_tasks: tasks\/lab-layer-reset\.yml/);
  const labRefPattern = /lab_ref is match\('(\^\[A-Za-z0-9\._\/-\]\{1,100\}\$)'\)/.exec(runJob);
  assert.ok(labRefPattern, "run-job.yml no longer validates lab_ref with a pattern this test can read");
  assert.equal(labRefPattern[1], LAYER_REF.source, "a layer ref and lab_ref are held to ONE pattern");
  for (const file of LAB_FILES) {
    const code = codeText(readFileSync(resolve(ANSIBLE, file), "utf8"));
    assert.ok(code.includes(labRefPattern[1]), `${file} validates a ref with a different pattern from lab_ref's`);
    assert.match(code, /include_tasks: read-layer-checkouts\.yml/, `${file} must read the layers from layers.json`);
    assert.ok(!code.includes(LAYER) && !code.includes("nvda-worker"), `${file} names a layer instead of reading it`);
    const chdirs = [...code.matchAll(/chdir: "([^"]+)"/g)].map((match) => match[1]);
    assert.ok(chdirs.length > 0, `${file} runs nothing in a directory`);
    for (const chdir of chdirs) {
      // `item.item` where the loop is over a registered result, which carries the layer one level down.
      assert.match(chdir, /^\{\{ lab_repo_path \}\}\/\{\{ item(\.item)?\.value\.path \}\}$/,
        `${file}: a layer's git runs in the CORE's directory: ${chdir}`);
    }
  }
});

const ansibleAvailable = spawnSync("ansible-playbook", ["--version"], { encoding: "utf8" }).status === 0;

/** A play that includes one of the lab's task files against a fixture lab checkout, run for real. */
function playLabFile({ file, manifest, labDir, extra, env }: { file: string, manifest: object, labDir: string, extra: string[], env?: Record<string, string> }) {
  const play = newDir();
  mkdirSync(join(play, "ansible/tasks"), { recursive: true });
  for (const name of [file, "tasks/read-layer-checkouts.yml"]) copyFileSync(resolve(ANSIBLE, name), join(play, "ansible", name));
  writeFileSync(join(play, "layers.json"), JSON.stringify(manifest));
  writeFileSync(join(play, "ansible/play.yml"), [
    "- hosts: localhost", "  gather_facts: false", "  vars:", `    lab_repo_path: ${labDir}`, "  tasks:",
    "    - ansible.builtin.set_fact:", "        lab_should_pull: \"{{ pull | default(true) | bool }}\"",
    `    - ansible.builtin.include_tasks: ${file}`, "",
  ].join("\n"));
  const result = spawnSync("ansible-playbook", ["play.yml", ...extra], {
    cwd: join(play, "ansible"), encoding: "utf8",
    env: { ...sandboxGitEnv(), PATH: process.env.PATH, ANSIBLE_NOCOLOR: "1", ANSIBLE_LOCALHOST_WARNING: "False", HOME: play, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const layerRefs = (ref: string) => ["-e", JSON.stringify({ layer_refs: { [LAYER]: ref } })];

test("the lab's job moves the layer's checkout to the ref it names, and only when the core's may move", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root, layerDir, first, second } = fixture({ withLayerCheckout: true });
  const moved = playLabFile({ file: "tasks/lab-layer-checkouts.yml", manifest: SEPARATE, labDir: join(root, "core"), extra: layerRefs(first) });
  assert.equal(moved.status, 0, moved.output);
  assert.equal(git(layerDir, "rev-parse", "HEAD"), first);
  const left = playLabFile({ file: "tasks/lab-layer-checkouts.yml", manifest: SEPARATE, labDir: join(root, "core"),
    extra: [...layerRefs(second), "-e", "pull=false"] });
  assert.equal(left.status, 0, left.output);
  assert.equal(git(layerDir, "rev-parse", "HEAD"), first, "pull=false leaves BOTH checkouts alone");
  const branch = playLabFile({ file: "tasks/lab-layer-checkouts.yml", manifest: SEPARATE, labDir: join(root, "core"), extra: layerRefs("main") });
  assert.equal(branch.status, 0, branch.output);
  assert.equal(git(layerDir, "rev-parse", "HEAD"), second, "a branch name resolves on origin, as lab_ref does");
});

test("the lab's job refuses a layer with no ref, an unrecognisable ref, a ref that names nothing", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root } = fixture({ withLayerCheckout: true });
  const play = (extra: string[]) => playLabFile({ file: "tasks/lab-layer-checkouts.yml", manifest: SEPARATE, labDir: join(root, "core"), extra });
  assert.match(play([]).output, /layer_refs must name EVERY layer/);
  assert.match(play(layerRefs("a..b")).output, /must be a plain branch, tag or commit name/);
  assert.match(play(layerRefs("no-such-branch")).output, /names no branch on its origin/);
});

test("POSITIVE CONTROL: the lab's job with the layer checkout missing REFUSES, naming the layer and the path", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root } = fixture({ withLayerCheckout: false });
  const run = playLabFile({ file: "tasks/lab-layer-checkouts.yml", manifest: SEPARATE, labDir: join(root, "core"), extra: layerRefs("main") });
  assert.notEqual(run.status, 0);
  assert.match(run.output, new RegExp(`layer ${LAYER} is declared at ${LAYER_PATH}`));
  assert.match(run.output, /Nothing falls back to the core's tree/);
});

// ---- a layer the lab holds LAID, not checked out (#3819) -----------------------------------------------------------

const TAG_ANNOTATED = `@a11ign/${LAYER}@1.0.0`;
const TAG_LIGHTWEIGHT = `@a11ign/${LAYER}@1.1.0`;

/** The fixture's layer repository carries both kinds of tag, and `REMOTE` is rewritten to it so `git ls-remote` runs for real. */
function laidFixture() {
  const made = fixture({ withLayerCheckout: false });
  git(made.origin, "tag", "-a", "-m", "annotated", TAG_ANNOTATED, made.first);
  git(made.origin, "tag", TAG_LIGHTWEIGHT, made.second);
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${made.origin}.insteadOf`, GIT_CONFIG_VALUE_0: REMOTE };
  const lay = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(made.layerDir, name)), { recursive: true });
      writeFileSync(join(made.layerDir, name), text);
    }
  };
  const playOn = (file: string, extra: string[]) => playLabFile({ file, manifest: SEPARATE, labDir: join(made.root, "core"), extra, env });
  const play = (extra: string[]) => playOn("tasks/lab-layer-checkouts.yml", extra);
  return { ...made, lay, play, playOn };
}

test("a layer the lab holds laid is ACCEPTED at the commit its tag names, annotated or lightweight, and nothing is moved", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { first, second, layerDir, lay, play } = laidFixture();
  lay({ ".layer-ref": `${TAG_ANNOTATED}\n`, "src/index.mjs": "export {};\n" });
  const annotated = play(layerRefs(first));
  assert.equal(annotated.status, 0, annotated.output);
  assert.doesNotMatch(annotated.output, /is not a git checkout/);
  lay({ ".layer-ref": `${TAG_LIGHTWEIGHT}\n` });
  const lightweight = play(layerRefs(second));
  assert.equal(lightweight.status, 0, lightweight.output);
  assert.equal(spawnSync("test", ["-e", join(layerDir, ".git")]).status, 1, "no git history was made for it: it is left laid");
  assert.equal(readFileSync(join(layerDir, ".layer-ref"), "utf8"), `${TAG_LIGHTWEIGHT}\n`, "the laid tree is untouched");
});

test("a laid layer at ANOTHER tag, or named by a branch, or whose tag the layer has not got, is REFUSED", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { first, second, lay, play } = laidFixture();
  lay({ ".layer-ref": `${TAG_ANNOTATED}\n`, "src/index.mjs": "export {};\n" });
  const wrongTree = play(layerRefs(second));
  assert.notEqual(wrongTree.status, 0, "laid at 1.0.0, job named the commit of 1.1.0");
  assert.match(wrongTree.output, new RegExp(`layer ${LAYER} is laid at ${TAG_ANNOTATED.replaceAll("/", "\\/")}`));
  assert.match(wrongTree.output, new RegExp(`the job\\s+named ${second}`));
  assert.notEqual(play(layerRefs("main")).status, 0, "a branch name cannot be compared with a tree that has no history");
  lay({ ".layer-ref": `@a11ign/${LAYER}@9.9.9\n` });
  const noSuchTag = play(layerRefs(first));
  assert.notEqual(noSuchTag.status, 0, "a tag the layer's repository does not hold names no commit");
  assert.match(noSuchTag.output, /no tag on its remote/);
  lay({ ".layer-ref": "../../etc/passwd\n" });
  assert.match(play(layerRefs(first)).output, /does not hold a tag/);
});

test("POSITIVE CONTROL: the core's own tree at the layer's path is not the layer, and neither is a marker with no source", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { first, lay, play } = laidFixture();
  const absent = play(layerRefs(first));
  assert.notEqual(absent.status, 0);
  assert.match(absent.output, /is not a git checkout and not a laid tree/, "an ABSENT layer still refuses");
  lay({ "src/index.mjs": "the core's own copy\n" });
  const coreTree = play(layerRefs(first));
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is the core's tree, laid by nobody");
  assert.match(coreTree.output, /Nothing falls back to the core's tree/);
  const { first: other, lay: layOther, play: playOther } = laidFixture();
  layOther({ ".layer-ref": `${TAG_ANNOTATED}\n` });
  assert.notEqual(playOther(layerRefs(other)).status, 0, "the marker alone, with no `src/`, is the wreckage of a rebase");
});

test("when the core's pull just changed the checkout the install re-lays the layer, so a stale laid tag is not judged", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { second, lay, play } = laidFixture();
  lay({ ".layer-ref": `${TAG_ANNOTATED}\n`, "src/index.mjs": "export {};\n" });
  const pulled = play([...layerRefs(second), "-e", JSON.stringify({ lab_core_moved: true })]);
  assert.equal(pulled.status, 0, pulled.output);
  const notPulled = play([...layerRefs(second), "-e", JSON.stringify({ lab_core_moved: false })]);
  assert.notEqual(notPulled.status, 0, "a pull that changed nothing re-lays nothing, so the laid tag is judged");
});

// ---- the guest's half: `tasks/layer-checkouts.yml` runs PowerShell, and `pwsh` runs it here -------------------------------

const pwshAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;

/** The guest's "is the layer on the box" script, template variables filled in for a fixture, git clone replaced by a stub that says so. */
function guestPresentScript({ repoPath, remote }: { repoPath: string, remote: string }) {
  const task = read("packages/control/ansible/tasks/layer-checkouts.yml").split("\n- name:").find((chunk) => chunk.includes("Each such layer is on the box"))!;
  const body = task.split("win_shell: |\n")[1].split(/\n {2}loop:/)[0];
  const indent = /^ */.exec(body)![0].length;
  return body.split("\n").map((line) => line.slice(indent)).join("\n")
    .replaceAll("{{ a11y_repo_path }}", repoPath).replaceAll("{{ item.value.path }}", LAYER_PATH)
    .replaceAll("{{ item.value.remote }}", remote).replaceAll("{{ item.key }}", LAYER)
    .replace("& git -c core.hooksPath=a11y-no-hooks clone", "& git clone");
}

test("the guest accepts a LAID layer, leaves it alone, and still refuses the core's own copy of it", (t) => {
  if (!pwshAvailable) return t.skip("pwsh is not on PATH here. Not run, and not counted as a pass.");
  const { origin, core, layerDir } = fixture({ withLayerCheckout: false });
  const run = () => spawnSync("pwsh", ["-NoProfile", "-Command", guestPresentScript({ repoPath: core, remote: origin })],
    { encoding: "utf8", env: { ...sandboxGitEnv(), PATH: process.env.PATH, HOME: core } });
  mkdirSync(join(layerDir, "src"), { recursive: true });
  writeFileSync(join(layerDir, "src/index.mjs"), "the core's own copy\n");
  const coreTree = run();
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is not the layer");
  assert.match(`${coreTree.stdout}${coreTree.stderr}`, /exists and is not a clone of/);
  writeFileSync(join(layerDir, ".layer-ref"), `${TAG_ANNOTATED}\n`);
  const laid = run();
  assert.equal(laid.status, 0, `${laid.stdout}${laid.stderr}`);
  assert.equal(laid.stdout.trim(), "laid");
  assert.equal(spawnSync("test", ["-e", join(layerDir, ".git")]).status, 1, "nothing was cloned over it");
  rmSync(join(layerDir, "src"), { recursive: true });
  assert.notEqual(run().status, 0, "the marker alone, with no `src/`, is not a laid tree");
  rmSync(layerDir, { recursive: true });
  assert.equal(run().stdout.trim(), "cloned", "an ABSENT layer is still cloned: the control for the three above");
});

test("the lab's reset ACCEPTS a laid layer and never lets git walk up from it into the core, and still refuses the core's own tree", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { core, layerDir, lay, playOn } = laidFixture();
  const reset = (extra: string[]) => playOn("tasks/lab-layer-reset.yml", extra);
  // The core is DIRTY: a `git status` or `git checkout -- .` run in the laid directory would find the core's repository above it.
  writeFileSync(join(core, "core-file"), "one\n");
  git(core, "add", "core-file");
  git(core, "commit", "-qm", "core file");
  writeFileSync(join(core, "core-file"), "edited\n");
  lay({ ".layer-ref": `${TAG_ANNOTATED}\n`, "src/index.mjs": "export {};\n" });
  const report = reset([]);
  assert.equal(report.status, 0, report.output);
  assert.doesNotMatch(report.output, /is not a git checkout/);
  const applied = reset(["-e", "apply=true"]);
  assert.equal(applied.status, 0, applied.output);
  assert.equal(readFileSync(join(core, "core-file"), "utf8"), "edited\n", "no git ran in the laid layer, so none reached the core's tree");
  assert.equal(spawnSync("test", ["-e", join(layerDir, ".git")]).status, 1, "the laid tree is left laid");
  // POSITIVE CONTROL: the refusals this file made before still stand, so the pass above is the shape being accepted, not the check gone.
  rmSync(join(layerDir, ".layer-ref"));
  const coreTree = reset([]);
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is the core's tree, laid by nobody");
  assert.match(coreTree.output, /not a git checkout and not a laid tree/);
  rmSync(join(layerDir, "src"), { recursive: true });
  lay({ ".layer-ref": `${TAG_ANNOTATED}\n` });
  assert.notEqual(reset([]).status, 0, "the marker alone, with no `src/`, is the wreckage of a rebase");
  rmSync(layerDir, { recursive: true });
  assert.notEqual(reset([]).status, 0, "an ABSENT layer still refuses");
});

// ---- the guest's OTHER readers of a laid layer: the role run, the origin rewrite, the post-install pin (#3826) --------
// They run PowerShell through `ansible.windows.win_shell`, which cannot run here. A stand-in module of the same name runs the
// task's own script under `pwsh`, so the REAL task text, loop, `register` and `assert` execute against a fixture, rather than
// a script cut out of the file with the variables swapped in by hand.

const WIN_SHELL_STUB = [
  "from ansible.module_utils.basic import AnsibleModule", "import subprocess", "",
  "def main():",
  "    m = AnsibleModule(argument_spec=dict(_raw_params=dict(type='str'), chdir=dict(type='path')))",
  "    p = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', m.params['_raw_params']],",
  "                       cwd=m.params['chdir'], capture_output=True, text=True)",
  "    out = dict(rc=p.returncode, stdout=p.stdout, stdout_lines=p.stdout.splitlines(), stderr=p.stderr, changed=True)",
  "    if p.returncode != 0:",
  "        m.fail_json(msg='non-zero return code', **out)",
  "    m.exit_json(**out)", "", "main()", "",
].join("\n");

function stubCollections() {
  const modules = join(newDir(), "ansible_collections/ansible/windows/plugins/modules");
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, "win_shell.py"), WIN_SHELL_STUB);
  return resolve(modules, "../../../../..");
}

/** The named tasks of a YAML task list, in the order given, dedented so they can stand alone in a tasks file. */
function tasksNamed(file: string, ...names: string[]) {
  const lines = readFileSync(resolve(ANSIBLE, file), "utf8").split("\n");
  return names.map((name) => {
    const start = lines.findIndex((line) => [`- name: ${name}`, `- name: "${name}"`].includes(line.trim()));
    assert.ok(start >= 0, `${file} has no task named "${name}"`);
    const indent = /^ */.exec(lines[start])![0].length;
    const length = lines.slice(start + 1).findIndex((line) => line.trim() !== "" && /^ */.exec(line)![0].length <= indent && !line.trimStart().startsWith("#"));
    return lines.slice(start, length < 0 ? undefined : start + 1 + length).map((line) => line.slice(indent)).join("\n");
  }).join("\n\n");
}

/** Tasks that run `win_shell`, played on localhost against a fixture core checkout, with `layers.json` beside them as in the repository. */
function playGuestTasks({ tasks, vars, extra = [], env }: { tasks: string, vars: object, extra?: string[], env?: Record<string, string> }) {
  const play = newDir();
  mkdirSync(join(play, "ansible/tasks"), { recursive: true });
  copyFileSync(resolve(ANSIBLE, "tasks/read-layer-checkouts.yml"), join(play, "ansible/tasks/read-layer-checkouts.yml"));
  writeFileSync(join(play, "layers.json"), JSON.stringify(SEPARATE));
  writeFileSync(join(play, "ansible/tasks/under-test.yml"), `${tasks}\n`);
  writeFileSync(join(play, "ansible/play.yml"), [
    "- hosts: localhost", "  gather_facts: false", `  vars: ${JSON.stringify(vars)}`, "  tasks:",
    "    - ansible.builtin.include_tasks: tasks/under-test.yml", "",
  ].join("\n"));
  // `-v` so a task's stdout (`laid`, `cloned`) is in the output the test reads.
  const result = spawnSync("ansible-playbook", ["play.yml", "-v", ...extra], {
    cwd: join(play, "ansible"), encoding: "utf8",
    env: { ...sandboxGitEnv(), PATH: process.env.PATH, ANSIBLE_NOCOLOR: "1", ANSIBLE_LOCALHOST_WARNING: "False", HOME: play,
      ANSIBLE_COLLECTIONS_PATH: stubCollections(), ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const guestPlayable = ansibleAvailable && pwshAvailable;
const SKIP_GUEST = "ansible-playbook and pwsh are both needed to run a guest's task here, and one is not on PATH. Not run, and not counted as a pass.";
const LAID_FILES = { ".layer-ref": `${TAG_ANNOTATED}\n`, "src/index.mjs": "export {};\n" };
const CORE_TREE = { "src/index.mjs": "the core's own copy\n" };

/** A guest's fixture: the core checkout and a layer repository with annotated and lightweight tags, files laid at the layer's path on request. */
function guestFixture() {
  const made = laidFixture();
  const layOnly = (files: Record<string, string>) => { rmSync(made.layerDir, { recursive: true, force: true }); made.lay(files); };
  const cloneIt = () => { rmSync(made.layerDir, { recursive: true, force: true }); git(made.core, "clone", "-q", made.origin, made.layerDir); };
  return { ...made, layOnly, cloneIt, vars: { a11y_repo_path: made.core, worker_repo_path: made.core } };
}

test("a role run LEAVES a laid layer alone and still refuses the core's copy of it (roles/worker/tasks/packages.yml)", (t) => {
  if (!guestPlayable) return t.skip(SKIP_GUEST);
  const { origin, layerDir, layOnly, cloneIt, vars } = guestFixture();
  const tasks = tasksNamed("roles/worker/tasks/packages.yml", "Each layer that has its own repository exists on the box")
    .replace("& 'C:\\Program Files\\MinGit\\cmd\\git.exe' clone", "& git clone");
  assert.ok(tasks.includes("& git clone"), "the fixture stands in for the box's git, so the swap must have found the call");
  const play = () => playGuestTasks({ tasks, vars: { ...vars, worker_layer_checkouts: [{ key: LAYER, value: { path: LAYER_PATH, remote: origin } }] } });
  layOnly(LAID_FILES);
  const laid = play();
  assert.equal(laid.status, 0, laid.output);
  assert.match(laid.output, /laid/);
  assert.equal(spawnSync("test", ["-e", join(layerDir, ".git")]).status, 1, "nothing was cloned over it");
  layOnly(CORE_TREE);
  const coreTree = play();
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is the core's copy, not the layer");
  assert.match(coreTree.output, /exists and is not a clone of/);
  layOnly({ ".layer-ref": `${TAG_ANNOTATED}\n` });
  assert.notEqual(play().status, 0, "the marker alone, with no `src/`, is not a laid tree");
  cloneIt();
  assert.match(play().output, /present/, "a clone is still `present`: the control for the laid case");
  rmSync(layerDir, { recursive: true });
  assert.match(play().output, /cloned/, "an ABSENT layer is still cloned");
});

/** The origin rewrite for the one named layer, at `address`, through the real task file. */
const originRewrite = (vars: object, address: string) => ({
  tasks: read("packages/control/ansible/tasks/layer-origins.yml"),
  vars: { ...vars, new_layer_repo_urls: { [LAYER]: address } },
});

test("the origin rewrite leaves a laid layer alone, rewrites a clone's, and refuses the core's copy before git can reach the core", (t) => {
  if (!guestPlayable) return t.skip(SKIP_GUEST);
  const { origin, core, layerDir, layOnly, cloneIt, vars } = guestFixture();
  git(core, "remote", "add", "origin", "https://example.test/the-core.git");
  const coreOrigin = () => git(core, "remote", "get-url", "origin");
  const rewrite = () => playGuestTasks(originRewrite(vars, origin));
  layOnly(LAID_FILES);
  const laid = rewrite();
  assert.equal(laid.status, 0, laid.output);
  assert.equal(coreOrigin(), "https://example.test/the-core.git", "the CORE's origin was not rewritten to the layer's address");
  layOnly(CORE_TREE);
  const coreTree = rewrite();
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is not the layer");
  assert.match(coreTree.output, /neither a clone of fixture-layer nor a laid tree/);
  assert.equal(coreOrigin(), "https://example.test/the-core.git");
  layOnly({ ".layer-ref": `${TAG_ANNOTATED}\n` });
  assert.notEqual(rewrite().status, 0, "the marker alone, with no `src/`, is not a laid tree");
  rmSync(layerDir, { recursive: true });
  assert.notEqual(rewrite().status, 0, "an ABSENT layer refuses too, and git is not asked");
  // POSITIVE CONTROL, and the reason for all of it: set-url run in a directory with no `.git` of its own does not fail, it
  // rewrites the repository above. Without the check, the laid cases above would have changed the core's origin.
  layOnly(LAID_FILES);
  git(layerDir, "remote", "set-url", "origin", origin);
  assert.equal(coreOrigin(), origin, "git walked up from the laid directory and rewrote the core's origin");
  git(core, "remote", "set-url", "origin", "https://example.test/the-core.git");
  cloneIt();
  git(layerDir, "remote", "set-url", "origin", "https://example.test/old-layer.git");
  const cloned = rewrite();
  assert.equal(cloned.status, 0, cloned.output);
  assert.equal(git(layerDir, "remote", "get-url", "origin"), origin, "a clone's origin is rewritten, so the filter is not a skip that always fires");
  assert.equal(coreOrigin(), "https://example.test/the-core.git");
});

const DEPLOY_AFTER_INSTALL = ["Read each layer's commit AFTER the install", "Each layer is ON its pin after the install, laid or cloned"];

test("the deploy checks a laid layer against its pin AFTER the install, and refuses a laid tree at another tag, the core's copy, or a tag nobody holds", (t) => {
  if (!guestPlayable) return t.skip(SKIP_GUEST);
  const { origin, first, second, layerDir, layOnly, cloneIt, vars } = guestFixture();
  const tasks = tasksNamed("deploy.yml", ...DEPLOY_AFTER_INSTALL);
  const check = (pin: string) => playGuestTasks({ tasks, vars: { ...vars, inventory_hostname: "a11y-worker-fixture",
    a11y_layer_checkouts: [{ key: LAYER, value: { path: LAYER_PATH, remote: origin } }], a11y_layer_commits: { [LAYER]: pin } } });
  layOnly(LAID_FILES);
  const atPin = check(first);
  assert.equal(atPin.status, 0, atPin.output);
  const wrongPin = check(second);
  assert.notEqual(wrongPin.status, 0, "laid at 1.0.0 (the first commit), pinned to the second");
  assert.match(wrongPin.output, new RegExp(`layer ${LAYER} is at '${first}' after the\\s+install, not ${second}`));
  layOnly({ ".layer-ref": `${TAG_LIGHTWEIGHT}\n`, "src/index.mjs": "export {};\n" });
  assert.equal(check(second).status, 0, "a lightweight tag names its commit directly");
  layOnly({ ".layer-ref": `@a11ign/${LAYER}@9.9.9\n`, "src/index.mjs": "export {};\n" });
  const noTag = check(first);
  assert.notEqual(noTag.status, 0, "a tag the layer's repository does not hold names no commit");
  assert.match(noTag.output, /at '' after the\s+install/);
  layOnly({ ".layer-ref": "../../etc/passwd\n", "src/index.mjs": "export {};\n" });
  assert.match(check(first).output, /does not hold a tag/);
  layOnly(CORE_TREE);
  const coreTree = check(first);
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is the core's copy: no pin can be read from it");
  assert.match(coreTree.output, /neither a clone of fixture-layer nor a laid tree/);
  cloneIt();
  git(layerDir, "checkout", "-q", "--detach", first);
  assert.equal(check(first).status, 0, "a layer still held as a clone is read at HEAD: the control for the laid cases");
  assert.notEqual(check(second).status, 0);
});

test("the deploy's post-install read sits AFTER the install and BEFORE the worker restarts, and reads the same pin the merge asserted", () => {
  const code = codeText(read("packages/control/ansible/deploy.yml"));
  const order = [/- name: Install dependencies/, /- name: Read each layer's commit AFTER the install/, /- name: Restart the worker task/]
    .map((marker) => code.search(marker));
  assert.ok(order.every((at) => at >= 0), "a task this test names has moved");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "install, then the post-install read, then the restart");
  assert.match(code, /that: \(item\.stdout \| default\(''\) \| trim\) == a11y_layer_commits\[item\.item\.key\]/);
});

const LAB_AFTER_INSTALL = ["Read each layer's commit AFTER the install", "Each layer is ON its pin after the install, laid or cloned"];

test("the lab's job checks a laid layer against its pin AFTER the install it ran, and refuses another tag, the core's copy, or a tag nobody holds", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root, origin, first, second, layerDir, layOnly, cloneIt } = guestFixture();
  const tasks = tasksNamed("tasks/run-job.yml", ...LAB_AFTER_INSTALL);
  const check = ({ pin, moved = true, commits = {} }: { pin: string, moved?: boolean, commits?: object }) => playGuestTasks({ tasks, vars: {
    lab_repo_path: join(root, "core"), lab_pull: { changed: moved }, layer_refs: { [LAYER]: pin }, lab_layer_commits: commits,
    a11y_layer_checkouts: [{ key: LAYER, value: { path: LAYER_PATH, remote: origin } }] } });
  layOnly(LAID_FILES);
  const atPin = check({ pin: first });
  assert.equal(atPin.status, 0, atPin.output);
  const wrongPin = check({ pin: second });
  assert.notEqual(wrongPin.status, 0, "laid at 1.0.0 (the first commit), the job named the second");
  assert.match(wrongPin.output, new RegExp(`layer ${LAYER} is at '${first}' after the\\s+install, not ${second}`));
  assert.notEqual(check({ pin: "main" }).status, 0, "a branch name cannot equal a commit a laid tree names");
  layOnly({ ".layer-ref": `${TAG_LIGHTWEIGHT}\n`, "src/index.mjs": "export {};\n" });
  assert.equal(check({ pin: second }).status, 0, "a lightweight tag names its commit directly");
  layOnly({ ".layer-ref": `@a11ign/${LAYER}@9.9.9\n`, "src/index.mjs": "export {};\n" });
  assert.match(check({ pin: first }).output, /at '' after the\s+install/, "a tag the layer's repository does not hold names no commit");
  layOnly({ ".layer-ref": "../../etc/passwd\n", "src/index.mjs": "export {};\n" });
  // `-v` echoes the command's argv, and the script's own messages are in it: these match the RENDERED text (a path, a tag), which is not.
  assert.match(check({ pin: first }).output, /\.layer-ref does not hold a tag: \.\.\/\.\.\/etc\/passwd/);
  // Each half of the tag's validation alone: `*` passes the `..` test and would be an `ls-remote` pattern matching every tag; `a..b` passes the pattern.
  for (const tag of ["*", "a..b"]) {
    layOnly({ ".layer-ref": `${tag}\n`, "src/index.mjs": "export {};\n" });
    const odd = check({ pin: second });
    assert.notEqual(odd.status, 0, `a .layer-ref holding ${tag} is not a tag`);
    assert.match(odd.output, new RegExp(`\\.layer-ref does not hold a tag: ${tag.replace("*", "\\*").replaceAll(".", "\\.")}`));
  }
  layOnly(CORE_TREE);
  const coreTree = check({ pin: first });
  assert.notEqual(coreTree.status, 0, "`src/` with no `.layer-ref` is the core's copy: no pin can be read from it");
  assert.match(coreTree.output, new RegExp(`${LAYER_PATH} is neither a clone nor a laid tree`));
  cloneIt();
  git(layerDir, "checkout", "-q", "--detach", first);
  assert.equal(check({ pin: first, commits: { [LAYER]: first } }).status, 0, "a clone is read at HEAD against the commit it was moved to");
  assert.notEqual(check({ pin: first, commits: { [LAYER]: second } }).status, 0);
  layOnly(LAID_FILES);
  assert.equal(check({ pin: second, moved: false }).status, 0, "no install ran, so `lab-layer-checkouts.yml` judged the tree that will run: nothing is read twice");
});

test("the lab's post-install read sits AFTER the install and BEFORE the build, gated on the install's own register", () => {
  const code = codeText(read("packages/control/ansible/tasks/run-job.yml"));
  const order = [/- name: "Install dependencies/, /- name: "Read each layer's commit AFTER the install"/, /- name: "Rebuild the compiled packages"/]
    .map((marker) => code.search(marker));
  assert.ok(order.every((at) => at >= 0), "a task this test names has moved");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "install, then the post-install read, then the build");
  for (const name of LAB_AFTER_INSTALL) {
    const task = code.split("\n- name:").find((chunk) => chunk.startsWith(` "${name}"`))!;
    assert.match(task, /when: lab_pull is defined and lab_pull is changed/, `${name}: gated as the install is`);
  }
});

test("the guest's git moves loop over the clones only, and the clones are the layers its script did not report `laid`", () => {
  const code = codeText(read("packages/control/ansible/tasks/layer-checkouts.yml"));
  const moves = code.split("\n- name:").find((chunk) => chunk.includes("Fetch, check out and fast-forward"))!;
  assert.match(moves, /loop: "\{\{ a11y_layer_clones \}\}"/, "a laid tree has no history: git on it fails, in the CORE's repository if it walks up");
  assert.match(code, /a11y_layer_clones: .*rejectattr\('key', 'in', layer_present\.results \| selectattr\('stdout', 'search', 'laid'\)/);
});

test("run-job.yml hands the lab's layer check whether its pull moved the core, from the very register the install is gated on", () => {
  const runJob = codeText(read("packages/control/ansible/tasks/run-job.yml"));
  const include = runJob.split("\n- name:").find((chunk) => chunk.includes("include_tasks: lab-layer-checkouts.yml"))!;
  assert.match(include, /lab_core_moved: "\{\{ lab_pull is defined and lab_pull is changed \}\}"/);
  assert.match(runJob, /Install dependencies[\s\S]*?when: lab_pull is defined and lab_pull is changed/, "the install is gated on the same register");
});

test("with no layer in its own repository the lab's tasks run nothing, not even without a checkout there", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root } = fixture({ withLayerCheckout: false });
  for (const file of LAB_FILES) {
    const run = playLabFile({ file, manifest: INSIDE_THE_CORE, labDir: join(root, "core"), extra: [] });
    assert.equal(run.status, 0, `${file}: ${run.output}`);
    assert.match(run.output, /failed=0/);
  }
});

test("the lab's reset discards a layer's tracked changes that origin already carries, and refuses ones it does not", (t) => {
  if (!ansibleAvailable) return t.skip("ansible-playbook is not on PATH here. Not run, and not counted as a pass.");
  const { root, layerDir, first } = fixture({ withLayerCheckout: true });
  const reset = (extra: string[]) => playLabFile({ file: "tasks/lab-layer-reset.yml", manifest: SEPARATE, labDir: join(root, "core"), extra });
  git(layerDir, "checkout", "-q", "--detach", first);
  writeFileSync(join(layerDir, "f"), "two\n");
  assert.match(reset(layerRefs("main")).output, /is DIRTY and nothing was discarded/, "report only, and it FAILS");
  assert.match(reset([]).output, /no usable ref to compare them with/);
  writeFileSync(join(layerDir, "f"), "not on origin\n");
  assert.match(reset([...layerRefs("main"), "-e", "apply=true"]).output, /NOT on origin\/main/, "work origin lacks is never discarded");
  writeFileSync(join(layerDir, "f"), "two\n");
  const applied = reset([...layerRefs("main"), "-e", "apply=true"]);
  assert.equal(applied.status, 0, applied.output);
  assert.equal(git(layerDir, "status", "--porcelain", "--untracked-files=no"), "", "the layer is clean again");
});

// ---- the bootstrap ----------------------------------------------------------------------------------------------

const BOOTSTRAP = read("packages/worker-fleet/src/provisioning/bootstrap-control-plane.sh");
const LAYER_BLOCK = BOOTSTRAP.slice(BOOTSTRAP.indexOf("LAYER_ROWS="), BOOTSTRAP.indexOf('done <<< "$LAYER_ROWS"') + 'done <<< "$LAYER_ROWS"'.length);

/** The bootstrap's layer block, run under bash against a core checkout whose layers.json is `manifest`. */
function bootstrapLayers({ core, origin, manifest }: { core: string, origin: string, manifest: object }) {
  mkdirSync(join(core, "packages/control"), { recursive: true });
  writeFileSync(join(core, "packages/control/layers.json"), JSON.stringify(manifest));
  const script = `set -euo pipefail\nok() { echo "OK $1"; }\nREPO_PATH=${JSON.stringify(core)}\n${LAYER_BLOCK}\n`;
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...sandboxGitEnv(), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: REMOTE },
  });
}

test("the bootstrap block was found, and names the manifest, not a layer", () => {
  assert.ok(LAYER_BLOCK.startsWith("LAYER_ROWS="), "the block this test extracts has moved");
  assert.ok(LAYER_BLOCK.includes("layers.json") && !LAYER_BLOCK.includes("nvda-worker"));
});

test("the bootstrap clones a layer that is absent, fetches one that is there, and keeps it out of the core's git status", () => {
  const { origin, core, layerDir } = fixture({ withLayerCheckout: false });
  const cloned = bootstrapLayers({ core, origin, manifest: SEPARATE });
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.match(cloned.stdout, new RegExp(`layer ${LAYER} cloned to ${LAYER_PATH}`));
  assert.match(git(layerDir, "rev-parse", "--is-inside-work-tree"), /true/);
  const excluded = readFileSync(join(core, ".git/info/exclude"), "utf8").split("\n");
  assert.ok(excluded.includes(`/${LAYER_PATH}/`), "a nested clone is otherwise `??` and stops every job pulling");
  assert.ok(!git(core, "status", "--porcelain").includes(LAYER_PATH));
  const again = bootstrapLayers({ core, origin, manifest: SEPARATE });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /fetched at/);
  assert.equal(readFileSync(join(core, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === `/${LAYER_PATH}/`).length, 1);
});

test("POSITIVE CONTROL: the bootstrap refuses to clone over a directory that is not a git checkout", () => {
  const { origin, core, layerDir } = fixture({ withLayerCheckout: false });
  mkdirSync(layerDir, { recursive: true });
  writeFileSync(join(layerDir, "the-monorepos-copy"), "x\n");
  const run = bootstrapLayers({ core, origin, manifest: SEPARATE });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, new RegExp(`layer ${LAYER} is declared at ${LAYER_PATH}`));
  assert.match(run.stderr, /refusing to clone over it/);
});

test("the bootstrap does nothing for a layer inside the core, and refuses a remote that is not https .git", () => {
  const { origin, core } = fixture({ withLayerCheckout: false });
  const none = bootstrapLayers({ core, origin, manifest: INSIDE_THE_CORE });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "");
  const bad = bootstrapLayers({ core, origin, manifest: { layers: { [LAYER]: { path: LAYER_PATH, remote: "git@example.test:x/y.git" } } } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /is not an https \.git URL/);
});
