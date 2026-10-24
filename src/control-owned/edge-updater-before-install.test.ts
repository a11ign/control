/**
 * THE EDGE UPDATER IS FROZEN WHATEVER STOPS THE ROLE AT THE EDGE STEP (a11ign#4732, a11ign#4948, A11-205).
 *
 * `edge-version.yml` used to stop the updater with two tasks placed BEFORE "Install it", and again with the same pair AFTER the rename, because a box that
 * stopped at the Edge step never reached tasks placed after it (a11y-worker-7, -8 and -9: Edge moved to 154 and then 155 on its own, the MSI declined the
 * 152 pin and still logged success, `--rename-chrome-exe` threw, and the role stopped with a live updater) and because the installer re-registers what it was
 * told to stop (twelve boxes on 2026-10-11). Two copies of the same pair, kept in order by this test.
 *
 * With the freeze that is ONE thing: the install is a block, and the role's `freeze.yml` is its `always:`, so a failed download, a refused downgrade, a failed
 * install and a failed rename each leave the updater frozen. The installer is the one thing that lifts a lever (it renames the updater's binaries back, so the
 * MSI's own `MicrosoftEdgeUpdate.exe /install` can run), and the `always:` puts it back.
 *
 * The line `edge-pin-parity.test.ts` and this file draw: that one holds two COPIES of a pin equal, this one holds the ORDER of one file's tasks. The YAML is
 * parsed by PyYAML in a subprocess because this package takes no npm dependency (ADR 0012).
 *
 * THE NEGATIVE CONTROL IS THE ASSERTION ITSELF, run on the same file with one property mutated, so the check is shown to fail on the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Task = Record<string, any>;
const PATH = fileURLToPath(new URL("../../ansible/roles/worker/tasks/edge-version.yml", import.meta.url));
const TASKS: Task[] = JSON.parse(execFileSync("python3", ["-I", "-c",
  "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", PATH], { encoding: "utf8" }));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const INSTALL_BLOCK = "Install the pinned Edge when the box is not on it, and leave the updater frozen whatever happens";
/** The block's tasks in the order they must run: each can stop the role, so each must have the freeze behind it. */
const INSTALL_ORDER = [
  "Freeze the box before anything is fetched, so the updater cannot start between here and the install",
  "Fetch the pinned installer",
  "Refuse to upgrade a worker that is mid-capture",
  "Stop Edge, or the installer cannot replace the launcher",
  "Stop any Edge-updater process that is already running, so the pinned MSI's own installer does not meet it",
  "Refuse a DOWNGRADE unless it was explicitly authorised, and say which remedy applies",
  "Let the installer run the updater it brings, by naming the updater's binaries as they were",
  "Install it",
  "Complete the launcher rename, which is what actually makes the new build the running one",
];
const CLOSING_ASSERTION = "Refuse to call this provisioned unless Edge is the pinned build and the updater is frozen";
const GUARD = "Register the guard that REPORTS when the Edge updater is not frozen";

const heads = (tasks: Task[]) => tasks.map((task) => String(task.name));
const blockOf = (tasks: Task[]): Task | undefined => tasks.find((task) => task.name === INSTALL_BLOCK);
const isFreeze = (task: Task | undefined): boolean => {
  const include = task?.["ansible.builtin.include_tasks"];
  return include?.file === "freeze.yml";
};

/** What is wrong with where the freeze sits, as a list. Empty means the updater is frozen whatever stops the install. */
function freezeViolations(tasks: Task[]): string[] {
  const block = blockOf(tasks);
  if (!block) return ["the install block is not found"];
  const inner: Task[] = block.block ?? [];
  const always: Task[] = block.always ?? [];
  const problems: string[] = [];
  const at = (name: string) => heads(inner).indexOf(name);
  for (const name of INSTALL_ORDER) if (at(name) < 0) problems.push(`task not found in the block: ${name}`);
  for (let i = 1; i < INSTALL_ORDER.length; i += 1) {
    if (at(INSTALL_ORDER[i - 1]) >= 0 && at(INSTALL_ORDER[i]) >= 0 && at(INSTALL_ORDER[i]) < at(INSTALL_ORDER[i - 1])) {
      problems.push(`"${INSTALL_ORDER[i]}" comes before "${INSTALL_ORDER[i - 1]}"`);
    }
  }
  if (!always.some(isFreeze)) problems.push("the freeze is not in the block's `always:`, so a run that stops at a step leaves the updater live");
  if (always.length > 0 && !isFreeze(always[always.length - 1])) problems.push("something comes after the freeze in `always:` and could undo it");
  // The ONE freeze the block may hold is its first task, taken before the download so the updater cannot start between there and the install.
  if (!isFreeze(inner[0])) problems.push("the block does not open with the freeze, so the updater is live through the download");
  if (inner.slice(1).some(isFreeze)) problems.push("the freeze is in the block itself, where a failure before it skips it");
  const beforeBlock = tasks.slice(0, tasks.indexOf(block));
  if (beforeBlock.some(isFreeze)) problems.push("the freeze runs BEFORE the install, which the installer then undoes (a11ign#4948)");
  const heading = heads(tasks);
  if (heading.indexOf(CLOSING_ASSERTION) < heading.indexOf(INSTALL_BLOCK)) problems.push("the closing assertion comes before the install");
  if (heading.indexOf(GUARD) < heading.indexOf(INSTALL_BLOCK)) problems.push("the guard is registered before the install");
  return problems;
}

test("the freeze is the install block's `always:`, and the block runs fetch, refusals, restore, install and rename in that order", () => {
  assert.deepEqual(freezeViolations(TASKS), [],
    "a box that stops at one of these steps has a live updater, and a live updater moves Edge past the pin while the role is stopped (a11ign#4732)");
});

test("the early and the late pair that raced the updater are gone, and nothing in this file disables the updater's tasks by hand", () => {
  for (const gone of ["Stop and disable EVERY Edge-updater scheduled task", "Stop and disable the updater's services", "Stop any Edge-updater process that is already running"]) {
    assert.ok(!heads(TASKS).some((name) => name.startsWith(gone)), `${gone} is back: the freeze does it`);
  }
  assert.ok(!JSON.stringify(TASKS).includes("Disable-ScheduledTask"), "the guard reports; the freeze unregisters");
});

test("control: a block with no `always:`, a freeze outside it, or one before the install FAILS", () => {
  const noAlways = clone(TASKS);
  delete (blockOf(noAlways) as Task).always;
  assert.match(freezeViolations(noAlways).join("|"), /not in the block's `always:`/);

  const insideBlock = clone(TASKS);
  const block = blockOf(insideBlock) as Task;
  block.block.push(block.always[0]);
  block.always = [];
  assert.match(freezeViolations(insideBlock).join("|"), /not in the block's `always:`/);
  assert.match(freezeViolations(insideBlock).join("|"), /in the block itself/, "a second freeze mid-block is not the always");

  const notFirst = clone(TASKS);
  const opening = blockOf(notFirst) as Task;
  opening.block.push(opening.block.shift());
  assert.match(freezeViolations(notFirst).join("|"), /does not open with the freeze/);

  const before = clone(TASKS);
  const beforeBlock = blockOf(before) as Task;
  before.splice(before.indexOf(beforeBlock), 0, clone(beforeBlock.always[0]));
  assert.match(freezeViolations(before).join("|"), /runs BEFORE the install/);

  const undone = clone(TASKS);
  (blockOf(undone) as Task).always.push({ name: "x", "ansible.builtin.debug": { msg: "after" } });
  assert.match(freezeViolations(undone).join("|"), /something comes after the freeze/);

  const wrongFile = clone(TASKS);
  (blockOf(wrongFile) as Task).always[0]["ansible.builtin.include_tasks"].file = "policy.yml";
  assert.match(freezeViolations(wrongFile).join("|"), /not in the block's `always:`/);
});

test("control: the installer's lift put after the install, or a step dropped, FAILS", () => {
  const swapped = clone(TASKS);
  const inner = (blockOf(swapped) as Task).block as Task[];
  const lift = inner.findIndex((task) => task.name === INSTALL_ORDER[6]);
  const install = inner.findIndex((task) => task.name === "Install it");
  [inner[lift], inner[install]] = [inner[install], inner[lift]];
  assert.match(freezeViolations(swapped).join("|"), /"Install it" comes before "Let the installer run the updater/);

  for (const name of INSTALL_ORDER) {
    const dropped = clone(TASKS);
    const droppedBlock = blockOf(dropped) as Task;
    droppedBlock.block = droppedBlock.block.filter((task: Task) => task.name !== name);
    assert.match(freezeViolations(dropped).join("|"), /task not found in the block/, name);
  }
});

test("control: a closing assertion or a guard ahead of the install FAILS, and a file with no install block is refused, not passed", () => {
  const early = clone(TASKS);
  const closing = early.splice(heads(early).indexOf(CLOSING_ASSERTION), 1)[0];
  early.unshift(closing);
  assert.match(freezeViolations(early).join("|"), /closing assertion comes before the install/);
  const guardEarly = clone(TASKS);
  const guard = guardEarly.splice(heads(guardEarly).indexOf(GUARD), 1)[0];
  guardEarly.unshift(guard);
  assert.match(freezeViolations(guardEarly).join("|"), /guard is registered before the install/);
  assert.deepEqual(freezeViolations(TASKS.filter((task) => task.name !== INSTALL_BLOCK)), ["the install block is not found"]);
});

test("the installer lifts exactly one lever and says so: the updater binaries it brings are named as they were, then frozen again in `always:`", () => {
  const lift = ((blockOf(TASKS) as Task).block as Task[]).find((task) => task.name === INSTALL_ORDER[6]) as Task;
  const script = String(lift["ansible.windows.win_powershell"].script);
  assert.match(script, /Where-Object \{ \$_\.Name -like "MicrosoftEdgeUpdate\*\.exe\$Suffix" \}/);
  assert.match(script, /Move-Item -LiteralPath \$f\.FullName -Destination \$original -Force/);
  assert.match(String(lift.when), /!= worker_edge_version/, "only a box that is installing pays for it");
  assert.doesNotMatch(script, /Start-Service|Enable-ScheduledTask|Register-ScheduledTask|Set-ItemProperty/, "no service, task or policy lever is lifted for an install");
});
