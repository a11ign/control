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

import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
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
function playLabFile({ file, manifest, labDir, extra }: { file: string, manifest: object, labDir: string, extra: string[] }) {
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
    env: { ...sandboxGitEnv(), PATH: process.env.PATH, ANSIBLE_NOCOLOR: "1", ANSIBLE_LOCALHOST_WARNING: "False", HOME: play },
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
