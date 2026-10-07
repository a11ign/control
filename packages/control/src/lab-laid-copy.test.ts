/**
 * #3833 (follow-up of #3505): a lab host that PULLS and does not INSTALL holds no lab code, and a lab job names the missing laid copy
 * before it plays a lab script.
 *
 * What is EXECUTED: `labLaidCopyRefusal` against fixture trees, and the real command (`node lab-laid-copy.mjs`, which the play runs on
 * the lab) copied into a fixture checkout so its exit status and words are read, not assumed. What is read as text: that
 * `tasks/run-job.yml` asks the question before it starts a unit, which a CI job can only read. What none of it shows is a real lab host
 * refusing: that is `orchestrator`'s fleet step, not this row's.
 *
 * POSITIVE CONTROL: a fixture laid the way `scripts/lay-layer.mjs` leaves `packages/lab` (`.layer-ref` at the pin, no `.git`, `src/`
 * and everything `lays` names) PASSES. Each refusal below is then that same fixture with one thing taken away, so a check that refuses
 * everything fails the control and a check that refuses nothing fails every other test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { labLaidCopyRefusal } from "./lab-laid-copy.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MODULE = join(HERE, "lab-laid-copy.mjs");
const REAL_MANIFEST = JSON.parse(readFileSync(join(HERE, "../layers.json"), "utf8"));
const RUN_JOB = readFileSync(join(HERE, "../ansible/tasks/run-job.yml"), "utf8");
const { path: LAB_PATH, tag: PINNED, lays: LAYS } = REAL_MANIFEST.pinned.lab as { path: string, tag: string, lays: string[] };

/** The exit status the command refuses with. */
const REFUSED = 4;

const scratch: string[] = [];
const newRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "lab-laid-copy-"));
  scratch.push(root);
  return root;
};
test.after(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

/** What `scripts/lay-layer.mjs` leaves: the declared `lays` and `.layer-ref`, no `.git`. */
function layLab(root: string, { ref = PINNED, leaving = [] as string[] } = {}) {
  const dir = join(root, LAB_PATH);
  for (const name of LAYS.filter((n) => !leaving.includes(n))) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    if (name.includes(".")) writeFileSync(join(dir, name), "{}");
    else mkdirSync(join(dir, name), { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".layer-ref"), `${ref}\n`);
  return dir;
}

const refusal = (root: string) => labLaidCopyRefusal({ manifest: REAL_MANIFEST, root });

test("positive control: a host whose packages/lab is laid at the pinned tag passes", () => {
  const root = newRoot();
  layLab(root);
  assert.equal(refusal(root), null);
});

test("a host that pulled and did not install is REFUSED, naming the missing packages/lab and the remedy", () => {
  const root = newRoot();
  const said = refusal(root);
  assert.match(said ?? "", /holds NO lab code: packages\/lab does not exist/);
  assert.match(said ?? "", /pnpm install --frozen-lockfile/);
});

test("a laid tree at an older tag than the pin (the pin moved, the install did not follow) is refused naming both", () => {
  const root = newRoot();
  layLab(root, { ref: "v0.0.1" });
  const said = refusal(root);
  assert.match(said ?? "", /laid at v0\.0\.1/);
  assert.ok(said?.includes(PINNED), said ?? "");
});

test("a CLONE at packages/lab is refused: only the laid shape runs", () => {
  const root = newRoot();
  mkdirSync(join(layLab(root), ".git"));
  assert.match(refusal(root) ?? "", /is a clone, not the laid copy/);
});

test("a directory with no .layer-ref is refused: it is not laid at any tag", () => {
  const root = newRoot();
  const dir = layLab(root);
  rmSync(join(dir, ".layer-ref"));
  assert.match(refusal(root) ?? "", /has no \.layer-ref/);
});

test("a laid tree missing something `lays` names is refused naming it (the scripts a job plays are read by path)", () => {
  const root = newRoot();
  layLab(root, { leaving: ["scripts"] });
  assert.match(refusal(root) ?? "", /holds no scripts/);
});

test("a laid tree missing several `lays` names every one of them, separated", () => {
  const root = newRoot();
  layLab(root, { leaving: ["scripts", "baselines"] });
  assert.match(refusal(root) ?? "", /holds no scripts, baselines:/);
});

test("a manifest that declares no pinned lab is refused, never read as 'nothing to check'", () => {
  assert.match(labLaidCopyRefusal({ manifest: { pinned: {} }, root: newRoot() }) ?? "", /declares no `pinned\.lab`/);
});

/** The real command's file, in a fixture checkout of its own: the module and the manifest where the module looks for them. */
function commandFileIn(root: string) {
  const control = join(root, "packages/control");
  mkdirSync(join(control, "src"), { recursive: true });
  copyFileSync(MODULE, join(control, "src/lab-laid-copy.mjs"));
  writeFileSync(join(control, "layers.json"), JSON.stringify(REAL_MANIFEST));
  return join(control, "src/lab-laid-copy.mjs");
}
const play = (entry: string) => spawnSync(process.execPath, [entry], { encoding: "utf8" });
const commandIn = (root: string) => play(commandFileIn(root));

test("the command the play runs exits with the refusal status and names the missing packages/lab on a pulled-not-installed fixture, and 0 on a laid one", () => {
  const bare = commandIn(newRoot());
  assert.equal(bare.status, REFUSED, bare.stderr);
  assert.match(bare.stderr, /lab-laid-copy: REFUSING: .*packages\/lab does not exist/);
  const laid = newRoot();
  layLab(laid);
  const ok = commandIn(laid);
  assert.equal(ok.status, 0, ok.stderr);
});

test("the command run THROUGH A SYMLINK still refuses a bare host: node resolves the module's real path, so a guard comparing argv[1] unresolved never fires and the check passes in silence (#1086)", () => {
  const root = newRoot();
  const link = join(root, "lab-laid-copy-link.mjs");
  symlinkSync(commandFileIn(root), link);
  const bare = play(link);
  assert.equal(bare.status, REFUSED, `through a symlink the command ran nothing: status ${bare.status}, stderr ${bare.stderr}`);
  assert.match(bare.stderr, /lab-laid-copy: REFUSING: .*packages\/lab does not exist/);
  layLab(root);
  const ok = play(link);
  assert.equal(ok.status, 0, ok.stderr);
});

test("tasks/run-job.yml asks the question before the unit starts, and the argv it runs is the command above", () => {
  const code = RUN_JOB.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const asked = code.indexOf("{{ lab_laid_copy_check }}");
  assert.ok(asked > 0, "run-job.yml no longer runs `lab_laid_copy_check`");
  assert.ok(asked < code.indexOf('- name: "Start it:'), "the question is asked after the unit starts");
  assert.ok(asked > code.indexOf("pnpm, install, --frozen-lockfile"), "the question is asked before the install lays the copy, so it would refuse a host the install is about to fix");
  const group = readFileSync(join(dirname(HERE), "ansible/group_vars/a11y_lab.yml"), "utf8");
  assert.match(group, /^lab_laid_copy_check: \["\/usr\/bin\/node", "packages\/control\/src\/lab-laid-copy\.mjs"\]$/m);
});
