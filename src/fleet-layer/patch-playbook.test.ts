/**
 * #4445 (under #4405): `ansible/patch.yml` is the one thing that moves the fleet's Windows build, so the
 * properties that make it safe are pinned HERE, each with a negative control -- a predicate that has only
 * ever been shown to accept the real playbook has not been shown to reject anything.
 *
 * Two kinds of test, and the split is deliberate:
 *   - STRUCTURE, read off the parsed playbook: serial, the busy refusal, `reboot: false`, the restore that
 *     reads the role's list. These always run.
 *   - BEHAVIOUR of the final verdict, run through the real `ansible-playbook` over a SYNTHETIC inventory of
 *     local connections carrying invented readings. It reaches no worker. It needs Ansible installed, which
 *     the control plane always has; where it is absent the tests say so by name rather than pass.
 *
 * The YAML is parsed by PyYAML in a subprocess because this package takes no npm dependency (ADR 0012) and
 * `check-modules.py` already requires PyYAML on the machine that edits playbooks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ANSIBLE = fileURLToPath(new URL("../../ansible/", import.meta.url));
const PATCH = join(ANSIBLE, "patch.yml");

type Task = Record<string, any>;
type Play = Record<string, any>;

function parseYamlFile(path: string): any {
  return JSON.parse(execFileSync("python3", ["-I", "-c",
    "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", path], { encoding: "utf8" }));
}

const PLAYS: Play[] = parseYamlFile(PATCH);
const GUARD_PLAY: Play = PLAYS[0];
const PATCH_PLAY: Play = PLAYS[1];
const VERDICT_PLAY: Play = PLAYS[2];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Every task in the play, flattened through block/rescue/always, in order. */
function allTasks(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [task, ...allTasks([...(task.block ?? []), ...(task.rescue ?? []), ...(task.always ?? [])])]);
}
const moduleOf = (task: Task, fqcn: string): Task | undefined => task[fqcn];
const tasksUsing = (play: Play, fqcn: string): Task[] => allTasks(play.tasks).filter((task) => fqcn in task);

// --- predicates, each exercised on the real playbook AND on a mutated copy ---------------------------------

const targetsWorkersSerially = (play: Play): boolean => play.hosts === "a11y_workers" && play.serial === 1;

/** A `uri` against the worker's /health, BEFORE the block that changes anything, that fails on busy. */
function refusesOnBusyBeforeChanging(play: Play): boolean {
  const blockAt = play.tasks.findIndex((task: Task) => Array.isArray(task.block));
  if (blockAt === -1) return false;
  return play.tasks.slice(0, blockAt).some((task: Task) => {
    const uri = moduleOf(task, "ansible.builtin.uri");
    return uri !== undefined && /\/health$/.test(String(uri.url))
      && /json\.busy/.test(String(task.failed_when)) && /default\(true\)/.test(String(task.failed_when));
  });
}

/** `win_updates` never reboots; the reboot is a separate `win_reboot` that waits on having installed something. */
function rebootsOnlyItself(play: Play): boolean {
  const updates = tasksUsing(play, "ansible.windows.win_updates");
  const reboots = tasksUsing(play, "ansible.windows.win_reboot");
  if (updates.length !== 1 || reboots.length !== 1) return false;
  const neverModuleReboot = updates[0]["ansible.windows.win_updates"].reboot === false;
  const onlyAfterInstalling = /installed_update_count/.test(JSON.stringify(reboots[0].when ?? ""));
  return neverModuleReboot && onlyAfterInstalling && updates[0] !== reboots[0];
}

/** The restore runs in `always` and takes its values from the role's list through the variable's name. */
function restoresFromRolesList(play: Play): boolean {
  const block = play.tasks.find((task: Task) => Array.isArray(task.always));
  const restore = block?.always.find((task: Task) => moduleOf(task, "ansible.windows.win_regedit"));
  return restore !== undefined && /^\{\{\s*worker_update_deferral_policy\s*\}\}$/.test(String(restore.loop))
    && play.vars_files?.includes("roles/worker/defaults/main.yml") === true;
}

test("parses as YAML, targets the workers group, and runs one box at a time", () => {
  assert.ok(Array.isArray(PLAYS) && PLAYS.length === 3, "patch.yml is the zero-host guard, the patch play and the verdict play");
  // A run matching no worker exits 0 having patched nothing; the guard play is what makes that a refusal.
  assert.equal(GUARD_PLAY.hosts, "localhost");
  assert.ok(allTasks(GUARD_PLAY.tasks).some((task) => task["ansible.builtin.include_tasks"] === "tasks/require-inventory-group.yml"));
  assert.ok(targetsWorkersSerially(PATCH_PLAY));
  // negative controls
  assert.ok(!targetsWorkersSerially({ ...PATCH_PLAY, serial: 2 }), "serial 2 must not satisfy the predicate");
  assert.ok(!targetsWorkersSerially({ ...PATCH_PLAY, serial: undefined }), "no serial must not satisfy it");
  assert.ok(!targetsWorkersSerially({ ...PATCH_PLAY, hosts: "all" }), "another group must not satisfy it");
});

test("refuses a busy worker BEFORE anything changes, and an unanswered /health counts as busy", () => {
  assert.ok(refusesOnBusyBeforeChanging(PATCH_PLAY));
  const noCheck = clone(PATCH_PLAY);
  noCheck.tasks = noCheck.tasks.filter((task: Task) => !moduleOf(task, "ansible.builtin.uri"));
  assert.ok(!refusesOnBusyBeforeChanging(noCheck), "with the check removed the predicate must say so");
  const checkAfter = clone(PATCH_PLAY);
  const [first, second, third] = checkAfter.tasks;
  checkAfter.tasks = [first, third, second, ...checkAfter.tasks.slice(3)];
  assert.ok(!refusesOnBusyBeforeChanging(checkAfter), "a check AFTER the block is no refusal");
  const failsOpen = clone(PATCH_PLAY);
  failsOpen.tasks[1].failed_when = "patch_worker_health.json.busy | default(false)";
  assert.ok(!refusesOnBusyBeforeChanging(failsOpen), "an unanswered /health must count as busy");
});

test("win_updates runs with reboot: false and the reboot is a separate, conditional win_reboot", () => {
  assert.ok(rebootsOnlyItself(PATCH_PLAY));
  assert.ok(!/reboot:\s*true/.test(readFileSync(PATCH, "utf8")), "no `reboot: true` anywhere in the file");
  const moduleReboots = clone(PATCH_PLAY);
  tasksUsing(moduleReboots, "ansible.windows.win_updates")[0]["ansible.windows.win_updates"].reboot = true;
  assert.ok(!rebootsOnlyItself(moduleReboots), "reboot: true inside win_updates must be caught");
  const unconditional = clone(PATCH_PLAY);
  delete tasksUsing(unconditional, "ansible.windows.win_reboot")[0].when;
  assert.ok(!rebootsOnlyItself(unconditional), "a win_reboot that fires on an empty box must be caught");
  const noSeparateReboot = clone(PATCH_PLAY);
  noSeparateReboot.tasks.find((task: Task) => task.block).block =
    noSeparateReboot.tasks.find((task: Task) => task.block).block.filter((task: Task) => !task["ansible.windows.win_reboot"]);
  assert.ok(!rebootsOnlyItself(noSeparateReboot), "with no win_reboot task there is no visible reboot");
});

test("the restore reads worker_update_deferral_policy; the play declares no deferral values of its own", () => {
  assert.ok(restoresFromRolesList(PATCH_PLAY));
  const own = clone(PATCH_PLAY);
  const restore = own.tasks.find((task: Task) => task.always).always.find((task: Task) => task["ansible.windows.win_regedit"]);
  restore.loop = [{ path: "HKLM:\\x", name: "DeferQualityUpdatesPeriodInDays", value: 30 }];
  assert.ok(!restoresFromRolesList(own), "a literal list in the restore must be caught");
  const unrestored = clone(PATCH_PLAY);
  unrestored.tasks.find((task: Task) => task.always).always = [];
  assert.ok(!restoresFromRolesList(unrestored), "no restore in `always` must be caught");

  const text = readFileSync(PATCH, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(text, /DeferFeatureUpdates|DeferQualityUpdates(?!PeriodInDays)|:\s*365\b|\bvalue:\s*30\b/,
    "the play must not restate the role's values; only the lifted entry's NAME and the window's 0 are its own");
  // The variable it reads really lives in the file it loads: otherwise the read is of an undefined name.
  const defaults = readFileSync(join(ANSIBLE, "roles/worker/defaults/main.yml"), "utf8");
  assert.match(defaults, /^worker_update_deferral_policy:/m);
});

// --- the verdict, through the real Ansible over invented readings -----------------------------------------

const ANSIBLE_PLAYBOOK = spawnSync("ansible-playbook", ["--version"], { encoding: "utf8" });
const HAVE_ANSIBLE = ANSIBLE_PLAYBOOK.status === 0;
const NO_ANSIBLE = "ansible-playbook is not installed on this machine, so the verdict cannot be run (the control plane has it)";

/** The boxes the failure message lists as odd, read from its bracketed list (not the whole line, which also lists every reading). */
const oddBoxes = (out: string): string[] =>
  [...(/Odd box\(es\) \(not on [^)]*\): \[([^\]]*)\]/.exec(out)?.[1] ?? "").matchAll(/a11y-worker-\d+/g)].map((m) => m[0]);

/** Run only the verdict play over local-connection hosts that carry the given readings. */
function verdict(readings: Record<string, string | null>): { status: number | null, out: string } {
  const dir = mkdtempSync(join(tmpdir(), "patch-verdict-"));
  const hosts = Object.fromEntries(Object.entries(readings).map(([name, reading]) =>
    [name, { ansible_connection: "local", ...(reading === null ? {} : { patch_build_reading: reading }) }]));
  const inventory = join(dir, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ a11y_workers: { hosts } }));
  const config = join(dir, "ansible.cfg");
  writeFileSync(config, "[defaults]\nlocalhost_warning = False\n");
  const run = spawnSync("ansible-playbook", ["-i", inventory, PATCH, "--tags", "patch_verdict"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_CONFIG: config, ANSIBLE_NOCOLOR: "1" } });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

test("the verdict fails on two distinct builds and names the odd box", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, out } = verdict({ "a11y-worker-2": "26100.1742", "a11y-worker-3": "26100.1742", "a11y-worker-4": "26100.1000" });
  assert.notEqual(status, 0, out);
  assert.deepEqual(oddBoxes(out), ["a11y-worker-4"], "a box on the majority build is not odd");
});

test("the verdict passes on one build", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, out } = verdict({ "a11y-worker-2": "26100.1742", "a11y-worker-3": "26100.1742" });
  assert.equal(status, 0, out);
  assert.match(out, /2 box\(es\) read, 0 unreadable/);
});

test("an unreadable box is reported as unreadable, never as a differing build", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, out } = verdict({ "a11y-worker-2": "26100.1742", "a11y-worker-3": "unreadable", "a11y-worker-4": "26100.1742", "a11y-worker-5": null });
  assert.equal(status, 0, `unreadable boxes must not fail the play\n${out}`);
  assert.match(out, /2 box\(es\) read, 2 unreadable/);
  assert.match(out, /a11y-worker-3/);
  assert.match(out, /a11y-worker-5/, "a box that never recorded a reading is unreadable too");
  // ...and a real mismatch alongside an unreadable box still fails, naming only the box that differs.
  const mixed = verdict({ "a11y-worker-2": "26100.1742", "a11y-worker-3": "unreadable", "a11y-worker-4": "26100.1000", "a11y-worker-5": "26100.1742" });
  assert.notEqual(mixed.status, 0, mixed.out);
  assert.deepEqual(oddBoxes(mixed.out), ["a11y-worker-4"], "the unreadable box is not an odd build");
});

test("the verdict play exists and is tagged, so the behavioural tests cannot silently run nothing", () => {
  assert.deepEqual(VERDICT_PLAY.tags, ["patch_verdict"]);
  assert.ok(allTasks(VERDICT_PLAY.tasks).some((task) => task["ansible.builtin.fail"]), "the verdict play must be able to fail");
});
