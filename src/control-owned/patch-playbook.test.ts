/**
 * #4445 (under #4405): `ansible/patch.yml` is the one thing that moves the fleet's Windows build, so the
 * properties that make it safe are pinned HERE, each with a negative control -- a predicate that has only
 * ever been shown to accept the real playbook has not been shown to reject anything.
 *
 * Two kinds of test, and the split is deliberate:
 *   - STRUCTURE, read off the parsed playbook: serial, the busy refusal, `reboot: false`, the lift that opens the block
 *     and the re-freeze that closes it in `always:` (A11-205). These always run.
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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const DAILY_FREEZE_PLAY: Play = PLAYS[1];
const PATCH_PLAY: Play = PLAYS[2];
const VERDICT_PLAY: Play = PLAYS[3];
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

/** The role's own freeze, included with the Windows levers lifted or not. */
const freezeInclude = (task: Task | undefined, lifted: boolean): boolean => {
  const include = task?.["ansible.builtin.include_role"];
  return include?.name === "worker" && include.tasks_from === "freeze.yml" && task?.vars?.worker_freeze_lift_windows === lifted;
};

/**
 * A11-205: the block OPENS with the lift (the role's freeze, lifted) and `always:` ENDS with the freeze, not lifted. Last, so that nothing after it in
 * `always:` can undo it, and in `always:` so that an install or a reboot that died still leaves the box frozen.
 */
function liftsThenRefreezes(play: Play): boolean {
  const block = play.tasks.find((task: Task) => Array.isArray(task.block));
  if (block === undefined || !Array.isArray(block.always) || block.always.length === 0) return false;
  return freezeInclude(block.block[0], true) && freezeInclude(block.always[block.always.length - 1], false);
}

/** The play moves no Windows Update value itself: the lift and the freeze are the role's one list, so the two cannot disagree about what "frozen" is. */
const writesNoRegistryValue = (play: Play): boolean => tasksUsing(play, "ansible.windows.win_regedit").length === 0;

test("parses as YAML, targets the workers group, and runs one box at a time", () => {
  assert.ok(Array.isArray(PLAYS) && PLAYS.length === 4, "patch.yml is the zero-host guard, the daily-freeze guard, the patch play and the verdict play");
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
  const [busyCheck] = checkAfter.tasks.splice(checkAfter.tasks.findIndex((task: Task) => moduleOf(task, "ansible.builtin.uri")), 1);
  checkAfter.tasks.push(busyCheck);
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

test("A11-205: the block lifts the Windows freeze first and the re-freeze is the last thing in `always:`; the play writes no value of its own", () => {
  assert.ok(liftsThenRefreezes(PATCH_PLAY));
  const noAlways = clone(PATCH_PLAY);
  delete noAlways.tasks.find((task: Task) => task.always).always;
  assert.ok(!liftsThenRefreezes(noAlways), "no `always:` must be caught");
  const emptyAlways = clone(PATCH_PLAY);
  emptyAlways.tasks.find((task: Task) => task.always).always = [];
  assert.ok(!liftsThenRefreezes(emptyAlways), "an empty `always:` must be caught");
  const stillLifted = clone(PATCH_PLAY);
  const closing = stillLifted.tasks.find((task: Task) => task.always).always;
  closing[closing.length - 1].vars.worker_freeze_lift_windows = true;
  assert.ok(!liftsThenRefreezes(stillLifted), "a re-freeze that is itself lifted leaves the box open");
  const notLast = clone(PATCH_PLAY);
  notLast.tasks.find((task: Task) => task.always).always.push({ name: "x", "ansible.builtin.debug": { msg: "after" } });
  assert.ok(!liftsThenRefreezes(notLast), "something after the re-freeze could undo it");
  const noLift = clone(PATCH_PLAY);
  noLift.tasks.find((task: Task) => task.block).block.shift();
  assert.ok(!liftsThenRefreezes(noLift), "a block that does not open with the lift installs nothing");
  const wrongRole = clone(PATCH_PLAY);
  wrongRole.tasks.find((task: Task) => task.always).always.at(-1)["ansible.builtin.include_role"].tasks_from = "policy.yml";
  assert.ok(!liftsThenRefreezes(wrongRole), "a re-freeze that runs another task file is no freeze");

  assert.ok(writesNoRegistryValue(PATCH_PLAY));
  const own = clone(PATCH_PLAY);
  own.tasks.find((task: Task) => task.always).always.unshift({ name: "x", "ansible.windows.win_regedit": { path: "HKLM:\\x", name: "NoAutoUpdate", data: 0 } });
  assert.ok(!writesNoRegistryValue(own), "a value written here could disagree with the freeze");

  const text = readFileSync(PATCH, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(text, /Defer(Feature|Quality)Updates|worker_update_deferral_policy|TargetReleaseVersion/,
    "no deferral and no target release is restated here: the deferral is gone, and the target release is the freeze's");
});

test("A11-205: the daily freeze is refused while it runs, so it cannot undo a lift", () => {
  const tasks = allTasks(DAILY_FREEZE_PLAY.tasks);
  // On the workers, run once, delegated to the control plane: `hosts: localhost` matches nothing there ("skipping: no hosts matched"), so a guard on it never runs.
  assert.equal(DAILY_FREEZE_PLAY.hosts, "a11y_workers");
  assert.equal(DAILY_FREEZE_PLAY.run_once, true);
  assert.ok(tasks.every((task) => task.delegate_to === "localhost"), "every task of the guard runs on the control plane");
  const ask = tasks.find((task) => /a11y-fleet-freeze-daily\.service/.test(JSON.stringify(task["ansible.builtin.command"] ?? "")));
  assert.ok(ask, "the play asks systemd about the daily freeze's unit");
  const refusal = tasks.find((task) => "ansible.builtin.assert" in task);
  assert.match(JSON.stringify(refusal), /active.*activating/, "active and activating both refuse");
  assert.match(JSON.stringify(refusal), /not in/, "the refusal is on the unit being in those states");
});

// --- the manifest, through the real Ansible over invented readings -------------------------------------------------

const ANSIBLE_PLAYBOOK = spawnSync("ansible-playbook", ["--version"], { encoding: "utf8" });
const HAVE_ANSIBLE = ANSIBLE_PLAYBOOK.status === 0;
const NO_ANSIBLE = "ansible-playbook is not installed on this machine, so the verdict cannot be run (the control plane has it)";

type Extra = Record<string, unknown>;
const MANIFEST = JSON.parse(readFileSync(join(ANSIBLE, "../deploy-pins.json"), "utf8")) as {
  windows: { release: string; build: string; kb: string; }; edge: { version: string; }; nvda: { version: string; }; node: { version: string; }; };
/** What a box that is on the manifest reads back as, from the manifest itself: nothing in this file restates a version. */
const ON_MANIFEST = { Windows: MANIFEST.windows.build, Edge: MANIFEST.edge.version, NVDA: MANIFEST.nvda.version, Node: MANIFEST.node.version };

/** Run `ansible-playbook` on `playbook` in a scratch directory over the given hosts' local connections. */
function runLocal(opts: { playbook: string, hosts: Record<string, Record<string, unknown>>, extra?: Extra, tags?: string }):
  { status: number | null, out: string, dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "patch-run-"));
  const inventory = join(dir, "inventory.json");
  const hosts = Object.fromEntries(Object.entries(opts.hosts).map(([name, vars]) => [name, { ansible_connection: "local", ...vars }]));
  writeFileSync(inventory, JSON.stringify({ a11y_workers: { hosts } }));
  const config = join(dir, "ansible.cfg");
  writeFileSync(config, "[defaults]\nlocalhost_warning = False\n");
  const argv = ["-i", inventory, opts.playbook, "-e", JSON.stringify(opts.extra ?? {}), ...(opts.tags ? ["--tags", opts.tags] : [])];
  const run = spawnSync("ansible-playbook", argv, { cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_CONFIG: config, ANSIBLE_NOCOLOR: "1" } });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}`, dir };
}

/** The differences the closing play names, as `box field` pairs, read from its message. */
const differencesNamed = (out: string): string[] =>
  [...new Set([...out.matchAll(/(a11y-worker-\d+) (Windows|Edge|NVDA|Node) has/g)].map((m) => `${m[1]} ${m[2]}`))];

/** Run only the whole-fleet play over invented local hosts that carry the given readbacks (`null` is a box that recorded none). */
function verdict(readbacks: Record<string, Record<string, string> | null>): { status: number | null, out: string } {
  return runLocal({ playbook: PATCH, tags: "patch_verdict",
    hosts: Object.fromEntries(Object.entries(readbacks).map(([name, readback]) => [name, readback === null ? {} : { patch_readback: readback }])) });
}

test("A11-205: the whole-fleet play passes when every box reads as the manifest", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, out } = verdict({ "a11y-worker-2": ON_MANIFEST, "a11y-worker-3": ON_MANIFEST });
  assert.equal(status, 0, out);
  assert.match(out, /2 box\(es\) read against the manifest/);
  assert.match(out, /0 difference\(s\)/);
});

for (const field of ["Windows", "Edge", "NVDA", "Node"] as const) {
  test(`A11-205: the whole-fleet play fails on ${field} alone and names the box, the field, what it has and what the manifest wants`, { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
    const { status, out } = verdict({ "a11y-worker-2": ON_MANIFEST, "a11y-worker-3": { ...ON_MANIFEST, [field]: "0.0.0" }, "a11y-worker-4": ON_MANIFEST });
    assert.notEqual(status, 0, out);
    assert.deepEqual(differencesNamed(out), [`a11y-worker-3 ${field}`], "only the box that differs, only the field that differs");
    assert.match(out, new RegExp(`a11y-worker-3 ${field} has 0\\.0\\.0, the manifest wants ${ON_MANIFEST[field].replace(/\./g, "\\.")}`));
  });
}

test("A11-205: a fleet that AGREES but not with the manifest fails: the upgrade is judged against the manifest, never against the majority", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const old = { ...ON_MANIFEST, Windows: "22631.6199" };
  const { status, out } = verdict({ "a11y-worker-2": old, "a11y-worker-3": old, "a11y-worker-4": old });
  assert.notEqual(status, 0, out);
  assert.deepEqual(differencesNamed(out), ["a11y-worker-2 Windows", "a11y-worker-3 Windows", "a11y-worker-4 Windows"]);
});

test("A11-205: a box that recorded no readback, or an unreadable field, is a difference: the run must SHOW the fleet on the manifest", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const none = verdict({ "a11y-worker-2": ON_MANIFEST, "a11y-worker-5": null });
  assert.notEqual(none.status, 0, none.out);
  assert.deepEqual(differencesNamed(none.out), ["a11y-worker-5 Windows", "a11y-worker-5 Edge", "a11y-worker-5 NVDA", "a11y-worker-5 Node"]);
  const unreadable = verdict({ "a11y-worker-2": { ...ON_MANIFEST, NVDA: "unreadable" } });
  assert.notEqual(unreadable.status, 0, unreadable.out);
  assert.deepEqual(differencesNamed(unreadable.out), ["a11y-worker-2 NVDA"]);
});

test("A11-205: the whole-fleet play is the LAST play, runs once, and can fail", () => {
  assert.equal(PLAYS.at(-1), VERDICT_PLAY, "the upgrade ends with the whole-fleet read");
  assert.deepEqual(VERDICT_PLAY.tags, ["patch_verdict"]);
  assert.equal(VERDICT_PLAY.run_once, true);
  assert.ok(allTasks(VERDICT_PLAY.tasks).some((task) => task["ansible.builtin.fail"]), "the verdict play must be able to fail");
  // Every version it judges against comes from the manifest it reads, not from a literal in the play.
  assert.doesNotMatch(JSON.stringify(VERDICT_PLAY.vars), /\d+\.\d+\.\d+|26[0-9]{3}\./, "no version literal in the verdict play");
});

// --- the target is the manifest's, from nowhere else -------------------------------------------------------------

const BUILD_OF = (build: string) => ({ patch_build_before: build });

/** A scratch tree shaped like the repository (`<tmp>/ansible/<play>`, `<tmp>/deploy-pins.json`), so a lookup of `playbook_dir/../deploy-pins.json` finds the real manifest. */
function scratchPlaybook(play: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), "patch-vars-"));
  mkdirSync(join(root, "ansible"));
  copyFileSync(join(ANSIBLE, "../deploy-pins.json"), join(root, "deploy-pins.json"));
  const playbook = join(root, "ansible", "vars.yml");
  writeFileSync(playbook, JSON.stringify(play));
  return playbook;
}

interface Evaluated {
  categories: string[], pending: boolean, current: boolean, restart: boolean, rebootTimeout: number, release: string, build: string, kb: string,
}

/**
 * The patch play's OWN vars, templated by the real Ansible over the real manifest, with `extra` as the caller's `-e` (and, for the per-box facts the play sets itself,
 * `patch_build_before` / `patch_updates`). Reads what the play would hand `win_updates` and whether it would take the feature route; reaches no box.
 */
function evaluatedVars(extra: Record<string, unknown>): Evaluated {
  const out = join(mkdtempSync(join(tmpdir(), "patch-out-")), "out.json");
  const result = "{'categories': patch_categories, 'pending': patch_feature_pending | bool, 'current': patch_windows_current | bool, 'restart': patch_restart_wanted | bool, "
    + "'rebootTimeout': patch_reboot_timeout | int, 'release': patch_target_release, 'build': patch_target_build, 'kb': patch_target_kb}";
  const playbook = scratchPlaybook([{ hosts: "localhost", connection: "local", gather_facts: false, vars: PATCH_PLAY.vars,
    tasks: [{ "ansible.builtin.copy": { dest: out, content: `{{ ${result} | to_json }}` } }] }]);
  const run = runLocal({ playbook, hosts: { localhost: {} }, extra });
  assert.equal(run.status, 0, run.out);
  return JSON.parse(readFileSync(out, "utf8"));
}
const BASE_CATEGORIES = ["SecurityUpdates", "CriticalUpdates", "UpdateRollups", "Updates"];

test("A11-205: the target is the manifest's release, build and update, templated by the real Ansible", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const set = evaluatedVars({});
  assert.deepEqual([set.release, set.build, set.kb], [MANIFEST.windows.release, MANIFEST.windows.build, MANIFEST.windows.kb]);
  assert.deepEqual(set.categories, BASE_CATEGORIES, "win_updates cannot switch a feature update (A11-31), so Upgrades is not a category");
  assert.ok(writesNoRegistryValue(PATCH_PLAY), "the lift and the target release are written by the role's freeze, from deploy-pins.json");
});

test("A11-205: the target is read only from the manifest: the fleet is not asked, and the wrapper passes no target", () => {
  const text = readFileSync(PATCH, "utf8");
  const executable = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  // Nothing in the play reads a box's build to MAKE a target: the only build reads are the box's own before and after, never the fleet's newest.
  assert.doesNotMatch(executable, /fleetTopBuild|patchTargetOf|highest build|majority/i);
  const wrapper = readFileSync(join(ANSIBLE, "../src/fleet-playbook.ts"), "utf8");
  for (const gone of ["fleetTopBuild", "patchTargetOf", "parsePatchTargetRead", "patchTargetReadCommand", "patchTargetExtraVars"]) {
    assert.doesNotMatch(wrapper, new RegExp(gone), `${gone} is deleted from the wrapper`);
  }
  assert.doesNotMatch(wrapper, /-e patch_target/, "the wrapper hands the play no -e target");
});

const targetInputs = (extra: Extra): number | null =>
  runLocal({ playbook: PATCH, tags: "patch_target_inputs", extra, hosts: { "a11y-worker-2": {} } }).status;

test("A11-205: a caller's -e cannot move the target off the manifest; the manifest's own values are accepted", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  assert.equal(targetInputs({}), 0, "negative control: no -e is the manifest's target");
  assert.equal(targetInputs({ patch_target_release: MANIFEST.windows.release, patch_target_build: MANIFEST.windows.build, patch_target_kb: MANIFEST.windows.kb }), 0,
    "the manifest's own values, given explicitly, are the same target");
  assert.notEqual(targetInputs({ patch_target_build: "26300.1" }), 0, "another build");
  assert.notEqual(targetInputs({ patch_target_release: "25H2" }), 0, "another release");
  assert.notEqual(targetInputs({ patch_target_kb: "KB5000000" }), 0, "another update");
  assert.notEqual(targetInputs({ patch_target_kb: "kb" }), 0, "a KB that is not shaped as one");
});

/** Run only the above-the-manifest refusal over one invented box with the given pre-upgrade build. */
const aboveManifest = (build: string) => runLocal({ playbook: PATCH, tags: "patch_above_manifest", hosts: { "a11y-worker-7": {} }, extra: BUILD_OF(build) });
const [BUILD_NUMBER, BUILD_UBR] = MANIFEST.windows.build.split(".").map(Number);

test("A11-205: a box ABOVE the manifest is refused by name before anything is lifted, and is never rolled back", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  for (const above of [`${BUILD_NUMBER}.${BUILD_UBR + 1}`, `${BUILD_NUMBER}.${BUILD_UBR * 10}`, `${BUILD_NUMBER + 100}.1`]) {
    const run = aboveManifest(above);
    assert.notEqual(run.status, 0, `${above}: ${run.out}`);
    assert.match(run.out, new RegExp(`a11y-worker-7 is on ${above.replace(/\./g, "\\.")}, ABOVE the manifest's build ${MANIFEST.windows.build.replace(/\./g, "\\.")}`));
    assert.match(run.out, /It is not rolled back/);
  }
  const unreadable = aboveManifest("unreadable");
  assert.notEqual(unreadable.status, 0, "a box nobody could read is not shown to be at or below the manifest");
  assert.match(unreadable.out, /a11y-worker-7 build could not be read/);
});

test("A11-205: a box at or below the manifest is not refused (compared as numbers: UBR 10000 is above 9457, not below)", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  assert.equal(aboveManifest(MANIFEST.windows.build).status, 0, "exactly on the manifest");
  assert.equal(aboveManifest(`${BUILD_NUMBER}.${BUILD_UBR - 1}`).status, 0, "the same release, an older revision: the cumulative's job");
  assert.equal(aboveManifest("22631.6199").status, 0, "an older release: the Installation Assistant's job");
  assert.equal(aboveManifest(`${BUILD_NUMBER}.${BUILD_UBR * 10}`).status === 0, false, "as text '97110' would sort below '9711'; as numbers it is above");
});

test("A11-205: the above-the-manifest refusal comes BEFORE the block, so a refused box is left frozen and nothing is lifted", () => {
  const refusal = PATCH_PLAY.tasks.findIndex((task: Task) => (task.tags ?? []).includes("patch_above_manifest"));
  const block = PATCH_PLAY.tasks.findIndex((task: Task) => Array.isArray(task.block));
  assert.ok(refusal > -1 && refusal < block, "the refusal is a task of the play, before the block");
  assert.equal(PATCH_PLAY.tasks.slice(refusal).findIndex((task: Task) => "ansible.builtin.fail" in task || "ansible.builtin.assert" in task), 0, "and it is an assert");
  const stripped = clone(PATCH_PLAY);
  stripped.tasks.splice(refusal, 1);
  assert.equal(stripped.tasks.findIndex((task: Task) => (task.tags ?? []).includes("patch_above_manifest")), -1, "negative control: the predicate sees its absence");
});

/** Run only the box's closing verdict over an invented reading. */
const closing = (reading: string) => runLocal({ playbook: PATCH, tags: "patch_target_verdict", hosts: { "a11y-worker-7": { patch_build_reading: reading } } });

test("A11-205: the closing task fails a box whose build is not the manifest's -- below, above, or unreadable -- by worker number", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const below = closing(`${BUILD_NUMBER - 100}.${BUILD_UBR}`);
  assert.notEqual(below.status, 0, below.out);
  assert.match(below.out, new RegExp(`a11y-worker-7 is on ${BUILD_NUMBER - 100}\\.${BUILD_UBR}, below\\s+the manifest's build ${MANIFEST.windows.build.replace(/\./g, "\\.")}`));
  const olderRevision = closing(`${BUILD_NUMBER}.${BUILD_UBR - 1}`);
  assert.notEqual(olderRevision.status, 0, "the same release at an older revision is still below");
  const above = closing(`${BUILD_NUMBER}.${BUILD_UBR + 1}`);
  assert.notEqual(above.status, 0, "a box ahead of the manifest differs from it too");
  assert.match(above.out, /ABOVE\s+the manifest's build/);
  const unreadable = closing("unreadable");
  assert.notEqual(unreadable.status, 0, "a box nobody could read has not been shown to have reached the manifest");
  assert.match(unreadable.out, /a11y-worker-7 is UNREADABLE/);
  assert.equal(closing(MANIFEST.windows.build).status, 0, "negative control: exactly on the manifest passes");
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
const ROUTE_STEPS = ["A feature update needs room", "Fetch the Installation Assistant", "Start the Installation Assistant", "Wait for Setup to finish", "Close the connection", "Reboot, only"];
function featureRouteInOrder(play: Play): boolean {
  const block = FEATURE_BLOCK(play);
  const at = ROUTE_STEPS.map((prefix) => indexWhere(block, nameStarts(prefix)));
  const ordered = at.every((index, i) => index > -1 && (i === 0 || index > at[i - 1]));
  const gated = at.slice(0, 4).every((index) => index > -1 && gatedOnFeature(block[index]));
  const restartsOnWanted = at[4] > -1 && at[5] > -1 && [block[at[4]], block[at[5]]].every((task) => /patch_restart_wanted/.test(JSON.stringify(task.when ?? "")));
  const rebootIsOurOwn = at[4] > -1 && at[5] > -1 && isReboot(block[at[5]]) && isReset(block[at[4]]);
  return ordered && gated && restartsOnWanted && rebootIsOurOwn;
}

test("A11-31: the Assistant route runs space, fetch, launch, wait and ONE restart, in that order, only on a feature pass", () => {
  assert.ok(featureRouteInOrder(PATCH_PLAY));
  for (const prefix of ROUTE_STEPS.slice(0, 5)) {
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
  // The re-freeze still sits in the `always`, and the install is not asked to do the feature pass's job.
  assert.ok(liftsThenRefreezes(PATCH_PLAY));
  const install = FEATURE_BLOCK(PATCH_PLAY).find(nameStarts("Install the manifest's cumulative update"));
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
  assert.match(launch, /Get-Process -Name [^\n]*SetupHost[^\n]*\n[^\n]*\$Ansible\.Failed = \$true[^\n]*already running/, "a second Setup is refused");
  assert.ok(launch.indexOf("already running") < launch.indexOf("Win32_Process"), "the refusal comes before the launch");
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

/** What each removed step looks like in a task's module arguments (name and when left out) once the playbook is parsed. */
const STALE_IN_TASK: Array<[RegExp, string]> = [
  [/UsoClient/i, "UsoClient, which did not commit the switch"],
  [/bcdedit/i, "bcdedit, the BCD wait"],
  [/"category_names":[^\]]*Upgrades/, "win_updates with Upgrades, which marks a feature update installed without Setup"],
  [/"state":"downloaded"/, "the pre-download, which staged media nothing committed"],
  [/staged but not switched/, "the staged-but-not-switched refusal"],
  [/"(reboot_timeout|timeout)":"?(7200|\{\{\s*7200)/, "the 7200 s restart"],
];
const STALE_VAR_NAME = /^patch_(safeos|switch)/;

const argumentsOf = (task: Task): string => JSON.stringify(Object.fromEntries(Object.entries(task).filter(([key]) => key !== "name" && key !== "when")));

function staleSteps(plays: Play[]): string[] {
  const found: string[] = [];
  for (const play of plays) {
    if (/Upgrades/.test(JSON.stringify(play.vars ?? {}))) found.push("the Upgrades category in a var");
    found.push(...Object.keys(play.vars ?? {}).filter((name) => STALE_VAR_NAME.test(name)).map((name) => `var ${name}, the BCD wait's`));
    for (const task of allTasks(play.tasks ?? [])) {
      found.push(...STALE_IN_TASK.filter(([pattern]) => pattern.test(argumentsOf(task))).map(([, label]) => label));
    }
  }
  return found;
}

test("A11-31: the steps that did not switch a box stay gone, read from the parsed playbook", () => {
  assert.deepEqual(staleSteps(PLAYS), []);
});

test("A11-31: the removed-steps check sees each step when it is put back", () => {
  const withTask = (task: Task): Play[] => { const plays = clone(PLAYS); plays[2].tasks.push(task); return plays; };
  const usoClient = { name: "x", "ansible.windows.win_powershell": { script: "UsoClient.exe StartInstall" } };
  const bcd = { name: "x", "ansible.windows.win_powershell": { script: "bcdedit /enum all" } };
  const upgrades = { name: "x", "ansible.windows.win_updates": { category_names: ["Upgrades"], state: "installed" } };
  const download = { name: "x", "ansible.windows.win_updates": { category_names: ["Updates"], state: "downloaded" } };
  const refusal = { name: "x", "ansible.builtin.fail": { msg: "staged but not switched" } };
  const slowReboot = { name: "x", "ansible.windows.win_reboot": { reboot_timeout: 7200 } };
  for (const task of [usoClient, bcd, upgrades, download, refusal, slowReboot]) {
    assert.equal(staleSteps(withTask(task)).length, 1, JSON.stringify(task));
  }
  const viaVar = clone(PLAYS);
  viaVar[2].vars.patch_categories = [...viaVar[2].vars.patch_categories, "Upgrades"];
  assert.equal(staleSteps(viaVar).length, 1, "Upgrades back in patch_categories");
  const renamed = clone(PLAYS);
  renamed[2].vars.patch_switch_pending = "{{ true }}";
  assert.equal(staleSteps(renamed).length, 1, "the BCD wait's var");
  const named = { name: "UsoClient and bcdedit and Upgrades, mentioned only in the task name", "ansible.builtin.debug": { msg: "gone" } };
  assert.deepEqual(staleSteps(withTask(named)), [], "a name is not a step");
});

// --- the route's decisions, templated by the real Ansible --------------------------------------------------------

const UPDATES_AND_REBOOT = { installed_update_count: 1, reboot_required: true };
const UPDATES_NO_REBOOT = { installed_update_count: 1, reboot_required: false };
const REBOOT_NO_UPDATES = { installed_update_count: 0, reboot_required: true };

test("A11-31: a box whose CurrentBuild is below the manifest's takes the feature route; any other box does not", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const on = (build: string): Evaluated => evaluatedVars({ patch_build_before: build });
  assert.equal(on("22631.6199").pending, true, "a 22631 box");
  assert.equal(on(`${BUILD_NUMBER - 100}.${BUILD_UBR}`).pending, true, "the previous release");
  assert.equal(on(`${BUILD_NUMBER}.${BUILD_UBR - 700}`).pending, false, "the manifest's release, an older UBR: the cumulative's job");
  assert.equal(on(MANIFEST.windows.build).pending, false, "on the manifest");
  assert.equal(on(`${BUILD_NUMBER + 100}.1`).pending, false, "above the manifest (refused before this is asked)");
  assert.equal(on(`${BUILD_NUMBER}.${BUILD_UBR * 10}`).pending, false, "numbers, not text");
  assert.equal(on("unreadable").pending, false, "a box nobody could read is refused before the route is chosen");
  assert.equal(on("22631.6199").rebootTimeout, 3600, "only a feature pass lengthens the restart");
  assert.equal(on(MANIFEST.windows.build).rebootTimeout, 1800);
});

test("A11-205: a box already on the manifest's build skips its Windows work; one below it does not", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const current = (build: string) => evaluatedVars({ patch_build_before: build }).current;
  assert.equal(current(MANIFEST.windows.build), true);
  assert.equal(current(`${BUILD_NUMBER}.${BUILD_UBR - 1}`), false, "an older revision is installed");
  assert.equal(current("22631.6199"), false, "an older release is upgraded");
  const install = FEATURE_BLOCK(PATCH_PLAY).find(nameStarts("Install the manifest's cumulative update"));
  assert.match(JSON.stringify(install?.when), /patch_windows_current/, "the install is skipped on a box that is current");
});

test("A11-205: win_updates installs exactly the manifest's update: accept_list is the KB, not the newest one", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const [install] = tasksUsing(PATCH_PLAY, "ansible.windows.win_updates");
  assert.deepEqual(install["ansible.windows.win_updates"].accept_list, ["{{ patch_target_kb }}"]);
  assert.equal(evaluatedVars({}).kb, MANIFEST.windows.kb);
  // negative control: the predicate is not satisfied by a list that names another update, or none
  assert.notDeepEqual(["KB1"], install["ansible.windows.win_updates"].accept_list);
  assert.equal(tasksUsing(PATCH_PLAY, "ansible.windows.win_updates").every((task) => task["ansible.windows.win_updates"].accept_list !== undefined), true);
});

test("A11-31: the restart fires for a feature pass, or for an install Windows asked a restart for -- and for nothing else", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const older = `${BUILD_NUMBER}.${BUILD_UBR - 700}`;
  const restart = (build: string, updates: Record<string, unknown> | undefined): boolean =>
    evaluatedVars({ patch_build_before: build, ...(updates ? { patch_updates: updates } : {}) }).restart;
  assert.equal(restart(`${BUILD_NUMBER - 100}.${BUILD_UBR}`, undefined), true, "a feature pass installs nothing else and still restarts");
  assert.equal(restart(older, UPDATES_AND_REBOOT), true, "a cumulative that asked");
  assert.equal(restart(older, UPDATES_NO_REBOOT), false, "a cumulative that did not ask");
  assert.equal(restart(older, REBOOT_NO_UPDATES), false, "a pending restart this run did not cause is left alone");
  assert.equal(restart(older, undefined), false, "nothing installed");
});

// --- the rest of what a box runs is installed from the manifest, in the same lift-and-freeze ---------------------------

/** The role task files the block includes, in order. */
const roleFilesOf = (play: Play): string[] =>
  FEATURE_BLOCK(play).flatMap((task: Task) => {
    const include = task["ansible.builtin.include_role"];
    return include?.name === "worker" ? [String(include.tasks_from)] : [];
  });
const UPGRADE_FILES = ["freeze.yml", "packages.yml", "nvda.yml", "edge-version.yml", "display.yml"];

test("A11-205: each box's upgrade runs the role's Node, NVDA, Edge and display-driver installs after Windows, inside the lift", () => {
  assert.deepEqual(roleFilesOf(PATCH_PLAY), UPGRADE_FILES);
  const block = FEATURE_BLOCK(PATCH_PLAY);
  const at = (file: string) => block.findIndex((task: Task) => task["ansible.builtin.include_role"]?.tasks_from === file);
  const reboot = block.findIndex(isReboot);
  for (const file of UPGRADE_FILES.slice(1)) assert.ok(at(file) > reboot, `${file} runs after the Windows restart`);
  assert.ok(liftsThenRefreezes(PATCH_PLAY), "and the freeze is still the last thing in `always:`");
  // each is the role's own file: the play restates no version and installs nothing the role does not
  for (const task of tasksUsing(PATCH_PLAY, "ansible.windows.win_package")) assert.fail(`the play installs a package itself: ${task.name}`);
  // negative control: without one of them the predicate says so
  for (const file of UPGRADE_FILES.slice(1)) {
    const without = clone(PATCH_PLAY);
    const inner = without.tasks.find((task: Task) => task.block);
    inner.block = inner.block.filter((task: Task) => task["ansible.builtin.include_role"]?.tasks_from !== file);
    assert.notDeepEqual(roleFilesOf(without), UPGRADE_FILES, file);
  }
});

test("A11-205: the install files take their versions from the manifest: no Edge, Node or NVDA literal in the play", () => {
  const executable = readFileSync(PATCH, "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(executable, new RegExp(`${MANIFEST.edge.version.replace(/\./g, "\\.")}|${MANIFEST.node.version.replace(/\./g, "\\.")}|${MANIFEST.nvda.version.replace(/\./g, "\\.")}`));
  assert.doesNotMatch(executable, /26300\.\d+|KB\d{6,8}/, "nor a Windows build or update");
});
