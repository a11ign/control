/**
 * a11ign#5314: on a target pass a box with nothing staged must download the feature update BEFORE the install, and a
 * pre-download that did not download must fail the box by name. The install used to meet the update at download, fail
 * it with HRESULT 0 and leave nothing staged for a switch to commit.
 *
 * The verdict is pinned BEHAVIOURALLY, as `patch-update-naming.test.ts` does: the task is lifted out of the real playbook
 * and run through the real `ansible-playbook` over localhost with an invented pre-download result. The pre-download
 * itself is a Windows module and reaches no box here, so its shape is read off the parsed playbook: the Upgrades category
 * alone, `state: downloaded`, and the block that also holds the install and the `always` that puts the deferral back.
 *
 * The negative control drops the `failed` condition from the verdict: a pre-download that did NOT fail must then fail the
 * box too, which shows the test bites on the condition and not only on the task's presence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH = fileURLToPath(new URL("../../ansible/patch.yml", import.meta.url));
const STAGE_TASK = "Stage the feature update's download before the install";
const VERDICT_TASK = "A feature update that did not stage fails the box";
const INSTALL_TASK = "Install the pending quality updates";
const FAILED_CONDITION = "patch_predownload.failed";

// Parsed YAML has no schema here (this package takes no npm dependency, ADR 0012), so the one untyped alias is named once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Task = Record<string, any>;

function parseYamlFile(path: string): Task[] {
  return JSON.parse(execFileSync("python3", ["-I", "-c",
    "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf8" }));
}

const named = (prefix: string) => (task: Task) => typeof task.name === "string" && task.name.startsWith(prefix);

/** The task whose name starts with `prefix`, anywhere in the patch play (blocks included). */
function findTask(tasks: Task[], prefix: string): Task | undefined {
  for (const task of tasks) {
    if (named(prefix)(task)) return task;
    const nested = findTask([...(task.block ?? []), ...(task.rescue ?? []), ...(task.always ?? [])], prefix);
    if (nested) return nested;
  }
  return undefined;
}

/** The block that directly holds a task whose name starts with `prefix`. */
function blockHolding(tasks: Task[], prefix: string): Task | undefined {
  for (const task of tasks) {
    if (Array.isArray(task.block) && task.block.some(named(prefix))) return task;
    const nested = blockHolding(task.block ?? [], prefix);
    if (nested) return nested;
  }
  return undefined;
}

const PATCH_PLAY = parseYamlFile(PATCH)[1];

const FAILED_PREDOWNLOAD = {
  failed: true,
  msg: "Failed to download all updates - see updates for more information",
  updates: { feature: { title: "Windows 11, version 25H2", kb: ["5129195"], categories: ["Upgrades"],
    downloaded: false, installed: false, failure_hresult_code: 0 } },
};
const CLEAN_PREDOWNLOAD = { failed: false, msg: "", updates: { feature: { title: "Windows 11, version 25H2",
  kb: ["5129195"], categories: ["Upgrades"], downloaded: false, installed: false } } };

/** The verdict task run over localhost with `patch_predownload` set to `predownload`. `become` is dropped: no sudo here. */
function runVerdict(task: Task, predownload: unknown): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "patch-stage-"));
  const playbook = join(dir, "verdict.json");
  const config = join(dir, "ansible.cfg");
  const lifted = structuredClone(task);
  delete lifted.become;
  writeFileSync(playbook, JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false,
    vars: { patch_target_set: true, patch_predownload: predownload, patch_download_result: { output: [] } },
    tasks: [lifted] }]));
  writeFileSync(config, "[defaults]\nlocalhost_warning = False\n");
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", playbook], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_CONFIG: config, ANSIBLE_NOCOLOR: "1" } });
  return { status: run.status ?? -1, output: `${run.stdout}\n${run.stderr}` };
}

test("a pre-download that failed fails the box, naming the feature update and WUA's per-update record", () => {
  const verdict = findTask(PATCH_PLAY.tasks, VERDICT_TASK);
  assert.ok(verdict, `the patch play must carry a task named "${VERDICT_TASK}..."`);
  const run = runVerdict(verdict, FAILED_PREDOWNLOAD);
  assert.notEqual(run.status, 0, run.output);
  assert.ok(run.output.includes("did not download"), run.output);
  assert.ok(run.output.includes("Windows 11, version 25H2"), run.output);
});

test("a pre-download that did not fail is not refused, so a box that already holds the download passes", () => {
  const verdict = findTask(PATCH_PLAY.tasks, VERDICT_TASK);
  assert.ok(verdict);
  const run = runVerdict(verdict, CLEAN_PREDOWNLOAD);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.output.includes("skipping: [localhost]"), run.output);
});

test("negative control: without the failed condition a clean pre-download is refused too", () => {
  const verdict = findTask(PATCH_PLAY.tasks, VERDICT_TASK);
  assert.ok(verdict);
  assert.ok(verdict.when.some((c: string) => c.includes(FAILED_CONDITION)), "the verdict must still carry the condition the mutation removes");
  const unconditional = structuredClone(verdict);
  unconditional.when = verdict.when.filter((c: string) => !c.includes(FAILED_CONDITION));
  const run = runVerdict(unconditional, CLEAN_PREDOWNLOAD);
  assert.notEqual(run.status, 0, run.output);
});

test("the pre-download downloads the Upgrades category only, on a target pass, and installs nothing", () => {
  const stage = findTask(PATCH_PLAY.tasks, STAGE_TASK);
  assert.ok(stage, `the patch play must carry a task named "${STAGE_TASK}..."`);
  assert.deepEqual(stage["ansible.windows.win_updates"], {
    category_names: ["Upgrades"], state: "downloaded", reboot: false, log_path: "C:\\Windows\\Temp\\a11y-patch-updates.log" });
  assert.ok(stage.when.includes("patch_target_set | bool"), "the pre-download must be gated on a target pass");
  assert.equal(stage.ignore_errors, true, "the verdict, not the module's own exit, must name the failure");
});

test("the pre-download sits in the same block as the install and the deferral's restore, before the install", () => {
  const block = blockHolding(PATCH_PLAY.tasks, STAGE_TASK);
  assert.ok(block, "the pre-download must be inside the block that lifts and restores the deferral");
  assert.ok(block.always, "that block must carry the `always` which puts the deferral back");
  const names: string[] = block.block.map((t: Task) => String(t.name ?? ""));
  const stageAt = names.findIndex((n) => n.startsWith(STAGE_TASK));
  const verdictAt = names.findIndex((n) => n.startsWith(VERDICT_TASK));
  const installAt = names.findIndex((n) => n.startsWith(INSTALL_TASK));
  assert.ok(stageAt >= 0 && stageAt < verdictAt && verdictAt < installAt,
    `order must be stage, verdict, install; got ${stageAt}, ${verdictAt}, ${installAt}`);
});
