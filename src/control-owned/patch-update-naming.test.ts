/**
 * a11ign#5308: `patch.yml` names each update it installed, by title and KB. The count alone printed a feature update
 * as a "1" that could not be told from a cumulative one, so the naming task is pinned BEHAVIOURALLY: the task is lifted
 * out of the real playbook and run through the real `ansible-playbook` over localhost with invented `win_updates`
 * entries. It reaches no box. A grep for the words "KB" would pass a task that prints nothing, so it is not the test.
 *
 * The negative control is the same task with its installed-only filter removed: an offered-but-not-installed update must
 * then appear, which shows the test bites on the filter and not only on the task's presence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PATCH = fileURLToPath(new URL("../../ansible/patch.yml", import.meta.url));
const NAMING_TASK = "Name each update that installed";
const INSTALLED_FILTER = " | selectattr('value.installed') | list";

// Parsed YAML has no schema here (this package takes no npm dependency, ADR 0012), so the one untyped alias is named once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Task = Record<string, any>;

function parseYamlFile(path: string): Task[] {
  return JSON.parse(execFileSync("python3", ["-I", "-c",
    "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf8" }));
}

/** The task whose name starts with NAMING_TASK, found anywhere in the patch play (blocks included). */
function findNamingTask(tasks: Task[]): Task | undefined {
  for (const task of tasks) {
    if (typeof task.name === "string" && task.name.startsWith(NAMING_TASK)) return task;
    const nested = findNamingTask([...(task.block ?? []), ...(task.rescue ?? []), ...(task.always ?? [])]);
    if (nested) return nested;
  }
  return undefined;
}

const UPDATES = {
  "feature": { title: "Windows 11, version 25H2", kb: ["5129195"], categories: ["Upgrades"], installed: true },
  "cumulative": { title: "Cumulative", kb: ["5000001"], categories: ["SecurityUpdates"], installed: true },
  "offered": { title: "Offered, not installed", kb: ["9"], categories: ["Updates"], installed: false },
};
const EXPECTED = [
  "localhost: installed Windows 11, version 25H2 (KB 5129195)",
  "localhost: installed Cumulative (KB 5000001)",
];

/** The naming task run over localhost, with `patch_updates` set to UPDATES. Returns the debug messages it printed. */
function namingMessages(task: Task): string[] {
  const dir = mkdtempSync(join(tmpdir(), "patch-naming-"));
  const playbook = join(dir, "naming.json");
  const config = join(dir, "ansible.cfg");
  writeFileSync(playbook, JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false,
    vars: { patch_updates: { reboot_required: true, updates: UPDATES } }, tasks: [task] }]));
  writeFileSync(config, "[defaults]\nlocalhost_warning = False\n");
  const run = spawnSync("ansible-playbook", ["-i", "localhost,", playbook], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_CONFIG: config, ANSIBLE_NOCOLOR: "1" } });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  return [...`${run.stdout}`.matchAll(/"msg": "(localhost: [^"]*)"/g)].map((m) => m[1]);
}

const PATCH_PLAY = parseYamlFile(PATCH)[1];

test("the naming task names each installed update by title and KB, and not the one offered but not installed", () => {
  const task = findNamingTask(PATCH_PLAY.tasks);
  assert.ok(task, `the patch play must carry a task named "${NAMING_TASK}..."`);
  assert.deepEqual(namingMessages(task), EXPECTED);
});

test("negative control: without the installed-only filter the offered update is named too", () => {
  const task = findNamingTask(PATCH_PLAY.tasks);
  assert.ok(task);
  const unfiltered = structuredClone(task);
  assert.ok(String(unfiltered.loop).includes(INSTALLED_FILTER), "the loop must still carry the filter the mutation removes");
  unfiltered.loop = String(unfiltered.loop).replace(INSTALLED_FILTER, " | list");
  const messages = namingMessages(unfiltered);
  assert.ok(messages.includes("localhost: installed Offered, not installed (KB 9)"), "removing the filter must name the offered update");
  assert.notDeepEqual(messages, EXPECTED);
});
