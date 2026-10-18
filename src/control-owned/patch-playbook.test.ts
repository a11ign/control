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
 * A11-31: a feature update goes through the Installation Assistant, not `win_updates`' `Upgrades` category and not
 * `UsoClient.exe StartInstall`. The tests that pinned those (a11ign#4979's commit/BCD/refusal order, a11ign#5314's
 * pre-download) are replaced by tests of the route that switched 11 boxes, and by a test that the old steps stay gone.
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

// Parsed YAML has no schema here (no npm dependency to give it one), so the one untyped alias is named once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Yaml = any;
type Task = Record<string, Yaml>;
type Play = Record<string, Yaml>;

function parseYamlFile(path: string): Yaml {
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
  if (updates.length === 0 || reboots.length !== 1) return false;
  const neverModuleReboot = updates.every((task: Task) => task["ansible.windows.win_updates"].reboot === false);
  // The condition is `patch_restart_wanted`, defined once in the play's vars: it must be there, and it must name the install count.
  const when = JSON.stringify(reboots[0].when ?? "");
  const condition = /patch_restart_wanted/.test(when) ? String(play.vars?.patch_restart_wanted ?? "") : when;
  const onlyAfterInstalling = when !== '""' && /installed_update_count/.test(condition);
  return neverModuleReboot && onlyAfterInstalling && !updates.includes(reboots[0]);
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
  // #4897: the window may also name `DeferFeatureUpdatesPeriodInDays` (with a target), as it names the quality entry.
  assert.doesNotMatch(text, /DeferFeatureUpdates(?!PeriodInDays)|DeferQualityUpdates(?!PeriodInDays)|:\s*365\b|\bvalue:\s*30\b/,
    "the play must not restate the role's values; only the lifted entries' NAMES and the window's 0 are its own");
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

// --- #4897: a box below the target build is brought up to it, a feature update included ---------------------

const TARGET = { patch_target_release: "26H2", patch_target_build: "26300.9711" };
const NO_TARGET = {};
type Extra = Record<string, unknown>;

/** Run `ansible-playbook` on `playbook` in a scratch directory over the given hosts' local connections. */
function runLocal(opts: { playbook: string, hosts: Record<string, Record<string, unknown>>, extra: Extra, tags?: string }):
  { status: number | null, out: string, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "patch-target-"));
  const inventory = join(dir, "inventory.json");
  const hosts = Object.fromEntries(Object.entries(opts.hosts).map(([name, vars]) => [name, { ansible_connection: "local", ...vars }]));
  writeFileSync(inventory, JSON.stringify({ a11y_workers: { hosts } }));
  const config = join(dir, "ansible.cfg");
  writeFileSync(config, "[defaults]\nlocalhost_warning = False\n");
  const argv = ["-i", inventory, opts.playbook, "-e", JSON.stringify(opts.extra), ...(opts.tags ? ["--tags", opts.tags] : [])];
  const run = spawnSync("ansible-playbook", argv, { cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_CONFIG: config, ANSIBLE_NOCOLOR: "1" } });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, dir };
}

interface WindowValue { path: string, name: string, value: string | number, type?: string }
interface Evaluated {
  categories: string[], lifted: WindowValue[], window: WindowValue[], targetValues: WindowValue[],
  pending: boolean, restart: boolean, rebootTimeout: number,
}

/**
 * The patch play's OWN vars, templated by the real Ansible over the role's real defaults, with `extra` as the
 * caller's `-e` (and, for the per-box facts the play sets itself, `patch_build_before` / `patch_updates`). Reads what the
 * play would hand `win_updates` and `win_regedit` and whether it would take the feature route; reaches no box.
 */
function evaluatedVars(extra: Record<string, unknown>): Evaluated {
  const dir = mkdtempSync(join(tmpdir(), "patch-vars-"));
  const out = join(dir, "out.json");
  const playbook = join(dir, "vars.yml");
  const result = "{'categories': patch_categories, 'lifted': patch_lifted_values, 'window': patch_window_values, "
    + "'targetValues': patch_target_values, 'pending': patch_feature_pending | bool, 'restart': patch_restart_wanted | bool, "
    + "'rebootTimeout': patch_reboot_timeout | int}";
  writeFileSync(playbook, JSON.stringify([{ hosts: "localhost", connection: "local", gather_facts: false,
    vars_files: [join(ANSIBLE, "roles/worker/defaults/main.yml")], vars: PATCH_PLAY.vars,
    tasks: [{ "ansible.builtin.copy": { dest: out, content: `{{ ${result} | to_json }}` } }] }]));
  const run = runLocal({ playbook, hosts: { localhost: {} }, extra: extra as Extra });
  assert.equal(run.status, 0, run.out);
  return JSON.parse(readFileSync(out, "utf8"));
}
const names = (values: WindowValue[]): string[] => values.map((v) => v.name);
const valueOf = (values: WindowValue[], name: string): string | number | undefined => values.find((v) => v.name === name)?.value;
const BASE_CATEGORIES = ["SecurityUpdates", "CriticalUpdates", "UpdateRollups", "Updates"];

test("#4897 negative control: with no target the categories, the deferral and the reboot rule are what they were", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const none = evaluatedVars(NO_TARGET);
  assert.deepEqual(none.categories, BASE_CATEGORIES, "no Upgrades category without a target");
  assert.deepEqual(none.window.map((v) => `${v.name}=${v.value}`), ["DeferQualityUpdatesPeriodInDays=0"],
    "the window lifts the quality deferral and nothing else, and writes no target release");
  assert.deepEqual(none.targetValues, []);
  assert.equal(none.rebootTimeout, 1800, "the reboot timeout is the cumulative one");
  assert.equal(none.pending, false, "no target, no feature route");
  assert.ok(rebootsOnlyItself(PATCH_PLAY));
  // The reboot rule never mentions the target: a box already on it installs nothing, so it is not restarted.
  assert.doesNotMatch(JSON.stringify(tasksUsing(PATCH_PLAY, "ansible.windows.win_reboot")[0].when), /patch_target/);
});

test("#4897: with a target the feature deferral is lifted for the window, the target is set, and Upgrades is NOT a category", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const set = evaluatedVars(TARGET);
  assert.deepEqual(set.categories, BASE_CATEGORIES, "win_updates cannot switch a feature update (A11-31), so it is not asked to");
  assert.equal(valueOf(set.window, "DeferFeatureUpdatesPeriodInDays"), 0, "feature deferral lifted");
  assert.equal(valueOf(set.window, "DeferQualityUpdatesPeriodInDays"), 0, "quality deferral still lifted");
  assert.equal(valueOf(set.window, "TargetReleaseVersion"), 1);
  assert.equal(valueOf(set.window, "TargetReleaseVersionInfo"), "26H2");
  assert.equal(valueOf(set.window, "ProductVersion"), "Windows 11");
  assert.equal(set.window.find((v) => v.name === "TargetReleaseVersionInfo")?.type, "string", "a release name is not a dword");
  assert.ok(!names(set.window).includes("DeferFeatureUpdates"), "the on/off flag is the role's and stays on");
  assert.ok(set.window.every((v) => v.path.startsWith("HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate")));
});

/** The restore (in `always`) removes every target name the window can write, and reads the removal back. */
function removesTargetThenReadsBack(play: Play): boolean {
  const always: Task[] = play.tasks.find((task: Task) => Array.isArray(task.always))?.always ?? [];
  const removeAt = always.findIndex((task) => moduleOf(task, "ansible.windows.win_regedit")?.state === "absent"
    && /patch_target_names/.test(String(task.loop)));
  const readsBack = always.slice(removeAt + 1).some((task) => /Names/.test(JSON.stringify(task["ansible.windows.win_powershell"] ?? "")));
  return removeAt > 0 && readsBack && String(play.vars.patch_target_names).includes("TargetReleaseVersionInfo");
}

test("#4897: the target is REMOVED in the `always`, after the role's list is back, on every run, and read back", () => {
  assert.ok(removesTargetThenReadsBack(PATCH_PLAY));
  const noRemoval = clone(PATCH_PLAY);
  const always = noRemoval.tasks.find((task: Task) => task.always);
  always.always = always.always.filter((task: Task) => moduleOf(task, "ansible.windows.win_regedit")?.state !== "absent");
  assert.ok(!removesTargetThenReadsBack(noRemoval), "no removal must be caught");
  const noReadBack = clone(PATCH_PLAY);
  const tail = noReadBack.tasks.find((task: Task) => task.always);
  tail.always = tail.always.filter((task: Task) => !/Names/.test(JSON.stringify(task["ansible.windows.win_powershell"] ?? "")));
  assert.ok(!removesTargetThenReadsBack(noReadBack), "a removal nobody read back must be caught");
  // Never conditional on the target: a target a killed run left behind is healed by the next window of any kind.
  const removal = PATCH_PLAY.tasks.find((task: Task) => task.always).always.find((task: Task) => moduleOf(task, "ansible.windows.win_regedit")?.state === "absent");
  assert.equal(removal.when, undefined);
});

/** Run only the box-level target verdict over invented readings, with the caller's `-e`. */
const targetVerdict = (readings: Record<string, string>, extra: Extra): { status: number | null, out: string } =>
  runLocal({ playbook: PATCH, tags: "patch_target_verdict", extra,
    hosts: Object.fromEntries(Object.entries(readings).map(([name, reading]) => [name, { patch_build_reading: reading }])) });

test("#4897: the closing task fails a box whose build is below the target, by worker number", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const below = targetVerdict({ "a11y-worker-7": "26200.9711" }, TARGET);
  assert.notEqual(below.status, 0, below.out);
  assert.match(below.out, /a11y-worker-7 is on 26200\.9711, below\s+the target build 26300\.9711/);
  const lowerRevision = targetVerdict({ "a11y-worker-8": "26300.9000" }, TARGET);
  assert.notEqual(lowerRevision.status, 0, "the same release at an older revision is still below");
  const unreadable = targetVerdict({ "a11y-worker-9": "unreadable" }, TARGET);
  assert.notEqual(unreadable.status, 0, "a box nobody could read has not been shown to have reached the target");
  assert.match(unreadable.out, /a11y-worker-9 is UNREADABLE/);
});

test("#4897: the closing task passes a box at or above the target, compares numbers not text, and is inert without one", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  assert.equal(targetVerdict({ "a11y-worker-2": "26300.9711" }, TARGET).status, 0, "exactly on the target");
  assert.equal(targetVerdict({ "a11y-worker-3": "26300.10000" }, TARGET).status, 0, "10000 is above 9457; as text it would sort below");
  assert.equal(targetVerdict({ "a11y-worker-4": "26400.1" }, TARGET).status, 0, "a later release is above");
  // negative control: no target given is the play as it was. The unreadable box is the discriminating one: a
  // below-target reading alone would pass even with the target guard removed, an empty build comparing as 0.
  assert.equal(targetVerdict({ "a11y-worker-5": "22631.1", "a11y-worker-6": "unreadable" }, NO_TARGET).status, 0, "no target, no verdict");
});

/** The input check on its own, over one invented local host. */
const targetInputs = (extra: Extra): number | null =>
  runLocal({ playbook: PATCH, tags: "patch_target_inputs", extra, hosts: { "a11y-worker-2": {} } }).status;

test("#4897: a target is given whole and well-formed, or not at all", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  assert.equal(targetInputs(TARGET), 0);
  assert.equal(targetInputs(NO_TARGET), 0, "the default is no target");
  assert.notEqual(targetInputs({ patch_target_release: "26H2" }), 0, "a release with no build could never be checked");
  assert.notEqual(targetInputs({ patch_target_build: "26300.9711" }), 0, "a build with no release would change nothing");
  assert.notEqual(targetInputs({ patch_target_release: "Windows 11", patch_target_build: "26300.9711" }), 0, "a release is NNHn");
  assert.notEqual(targetInputs({ patch_target_release: "26H2", patch_target_build: "26300" }), 0, "a build is <build>.<UBR>");
});

// --- A11-31: a feature update goes through the Installation Assistant, then ONE restart once Setup has finished ----

const FEATURE_BLOCK = (play: Play): Task[] => play.tasks.find((task: Task) => Array.isArray(task.block))?.block ?? [];
const nameStarts = (prefix: string) => (task: Task): boolean => typeof task.name === "string" && task.name.startsWith(prefix);
const indexWhere = (tasks: Task[], pick: (task: Task) => boolean): number => tasks.findIndex(pick);
const gatedOnFeature = (task: Task | undefined): boolean => /patch_feature_pending/.test(JSON.stringify(task?.when ?? ""));
const fetchBlock = (tasks: Task[]): Task | undefined => tasks.find(nameStarts("Fetch the Installation Assistant"));
const isReset = (task: Task): boolean => task["ansible.builtin.meta"] === "reset_connection";
const isReboot = (task: Task): boolean => "ansible.windows.win_reboot" in task;

/**
 * Space, fetch (with the signature check inside it), launch, wait for Setup, close the connection, restart -- in that
 * order, each of the first four only on a feature pass, and the restart on `patch_restart_wanted`, which is true for one.
 */
function featureRouteInOrder(play: Play): boolean {
  const block = FEATURE_BLOCK(play);
  const at = ["A feature update needs room", "Fetch the Installation Assistant", "Start the Installation Assistant", "Wait for Setup to finish", "Close the connection", "Reboot, only"]
    .map((prefix) => indexWhere(block, nameStarts(prefix)));
  const ordered = at.every((index, i) => index > -1 && (i === 0 || index > at[i - 1]));
  const gated = at.slice(0, 4).every((index) => index > -1 && gatedOnFeature(block[index]));
  const restartsOnWanted = at[4] > -1 && at[5] > -1 && [block[at[4]], block[at[5]]].every((task) => /patch_restart_wanted/.test(JSON.stringify(task.when ?? "")));
  const rebootIsOurOwn = at[4] > -1 && at[5] > -1 && isReboot(block[at[5]]) && isReset(block[at[4]]);
  return ordered && gated && restartsOnWanted && rebootIsOurOwn;
}

test("A11-31: the Assistant route runs space, fetch, launch, wait and ONE restart, in that order, only on a feature pass", () => {
  assert.ok(featureRouteInOrder(PATCH_PLAY));
  for (const prefix of ["A feature update needs room", "Fetch the Installation Assistant", "Start the Installation Assistant", "Wait for Setup to finish", "Close the connection"]) {
    const without = clone(PATCH_PLAY);
    without.tasks.find((task: Task) => task.block).block = FEATURE_BLOCK(PATCH_PLAY).filter((task) => !nameStarts(prefix)(task));
    assert.ok(!featureRouteInOrder(without), `without "${prefix}" the route must be caught`);
  }
  const ungated = clone(PATCH_PLAY);
  delete FEATURE_BLOCK(ungated).find(nameStarts("Start the Installation Assistant"))?.when;
  assert.ok(!featureRouteInOrder(ungated), "a launch that runs for every pass must be caught");
  assert.equal(tasksUsing(PATCH_PLAY, "ansible.windows.win_reboot").length, 1, "one restart, this play's own");
  // The restart is bounded: `reboot_timeout` is not read while a connection hangs, so the task carries its own `timeout`.
  assert.match(String(FEATURE_BLOCK(PATCH_PLAY).find(isReboot)?.timeout), /patch_reboot_timeout/);
  // The restore still sits in the `always`, and the install is not asked to do the feature pass's job.
  assert.ok(restoresFromRolesList(PATCH_PLAY));
  assert.ok(removesTargetThenReadsBack(PATCH_PLAY));
  const install = FEATURE_BLOCK(PATCH_PLAY).find(nameStarts("Install the pending quality updates"));
  assert.match(JSON.stringify(install?.when), /not \(patch_feature_pending/, "a feature pass installs nothing beside the Assistant");
});

test("A11-31: Setup is waited for by its own log, written after the launch -- never by the build, which changes at the restart", () => {
  const block = FEATURE_BLOCK(PATCH_PLAY);
  const wait = block.find(nameStarts("Wait for Setup to finish"));
  const script = String(wait?.["ansible.windows.win_powershell"]?.script ?? "");
  assert.match(script, /SetupPhasePostFinalize/);
  assert.match(script, /Panther\\setupact\.log/);
  assert.match(script, /LastWriteTimeUtc -gt \$launched/, "a PostFinalize from an earlier attempt must not end the wait");
  assert.doesNotMatch(script, /windowsBuild|CurrentBuild/, "the build moves at the restart, so waiting on it waits for nobody");
  assert.match(String(wait?.until), /SETUP_DONE: True/);
  const launch = String(block.find(nameStarts("Start the Installation Assistant"))?.["ansible.windows.win_powershell"]?.script ?? "");
  assert.match(launch, /Win32_Process/, "detached from the SSH session");
  assert.match(launch, /launched\.txt/, "the clock the wait is held against");
  assert.match(JSON.stringify(PATCH_PLAY.vars.patch_feature_installer_args), /\/QuietInstall \/SkipEULA \/Auto Upgrade/);
  assert.match(String(PATCH_PLAY.vars.patch_feature_installer_url), /^https:\/\/go\.microsoft\.com\/fwlink\/\?linkid=2171764$/);
});

test("A11-31: the Assistant is refused unless validly signed by Microsoft Corporation, before it is launched", () => {
  const block = FEATURE_BLOCK(PATCH_PLAY);
  const inner: Task[] = fetchBlock(block)?.block ?? [];
  const download = inner.findIndex((task) => "ansible.windows.win_get_url" in task);
  const signature = inner.findIndex((task) => /Authenticode/.test(JSON.stringify(task)));
  assert.ok(download > -1 && signature > download, "download, then the signature check, inside the fetch");
  const check = JSON.stringify(inner[signature]);
  assert.match(check, /\$s\.Status -ne 'Valid'/);
  assert.match(check, /O=Microsoft Corporation/);
  assert.match(check, /Ansible\.Failed = \$true/);
  assert.ok(indexWhere(block, nameStarts("Fetch the Installation Assistant")) < indexWhere(block, nameStarts("Start the Installation Assistant")));
});

test("A11-31: the steps that did not switch a box stay gone", () => {
  const code = readFileSync(PATCH, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /UsoClient/i, "UsoClient.exe StartInstall did not commit the switch");
  assert.doesNotMatch(code, /bcdedit|staged but not switched|patch_safeos|patch_switch/i, "the BCD wait and the refusal were built on it");
  assert.doesNotMatch(code, /state:\s*downloaded/, "the Upgrades pre-download staged media that nothing committed");
  assert.doesNotMatch(code, /\bUpgrades\b/, "win_updates marks a feature update installed without running Setup");
  assert.doesNotMatch(code, /reboot_timeout:\s*"\{\{\s*7200/, "the 7200 s guess is replaced by patch_reboot_timeout and a task timeout");
});

// --- the route's decisions, templated by the real Ansible --------------------------------------------------------

const UPDATES_AND_REBOOT = { installed_update_count: 1, reboot_required: true };
const UPDATES_NO_REBOOT = { installed_update_count: 1, reboot_required: false };
const REBOOT_NO_UPDATES = { installed_update_count: 0, reboot_required: true };

test("A11-31: a box whose CurrentBuild is below the target's takes the feature route; any other box does not", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const on = (build: string, extra: Record<string, unknown> = TARGET): Evaluated => evaluatedVars({ ...extra, patch_build_before: build });
  assert.equal(on("22631.6199").pending, true, "a 22631 box");
  assert.equal(on("26200.9711").pending, true, "the previous release");
  assert.equal(on("26300.9000").pending, false, "the target's release, an older UBR: the cumulative's job");
  assert.equal(on("26300.9711").pending, false, "on the target");
  assert.equal(on("26400.1").pending, false, "above the target");
  assert.equal(on("26300.10000").pending, false, "numbers, not text");
  assert.equal(on("unreadable").pending, false, "a box nobody could read is left for the closing task to fail");
  assert.equal(on("22631.6199", NO_TARGET).pending, false, "no target, no feature route (the play as it was)");
  assert.equal(on("22631.6199").rebootTimeout, 3600, "only a feature pass lengthens the restart");
  assert.equal(on("26300.9711").rebootTimeout, 1800);
});

test("A11-31: the restart fires for a feature pass, or for an install Windows asked a restart for -- and for nothing else", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const restart = (build: string, updates: Record<string, unknown> | undefined): boolean =>
    evaluatedVars({ ...TARGET, patch_build_before: build, ...(updates ? { patch_updates: updates } : {}) }).restart;
  assert.equal(restart("26200.9711", undefined), true, "a feature pass installs nothing else and still restarts");
  assert.equal(restart("26300.9000", UPDATES_AND_REBOOT), true, "a cumulative that asked");
  assert.equal(restart("26300.9000", UPDATES_NO_REBOOT), false, "a cumulative that did not ask");
  assert.equal(restart("26300.9000", REBOOT_NO_UPDATES), false, "a pending restart this run did not cause is left alone");
  assert.equal(restart("26300.9000", undefined), false, "nothing installed");
});
