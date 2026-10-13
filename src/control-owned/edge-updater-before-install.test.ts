/**
 * THE EDGE UPDATER IS STOPPED BEFORE ANYTHING THAT CAN STOP THE ROLE AT THE EDGE STEP (a11ign#4732).
 *
 * `edge-version.yml` used to stop the updater AFTER "Install it". A box that stopped at the Edge step never
 * reached the two tasks that stop it, so it kept a live updater by construction. a11y-worker-7, -8 and -9 were
 * those boxes: Edge moved to 154 and then 155 on its own, Chromium's MSI declined the 152 pin and still
 * logged success, `--rename-chrome-exe` threw, and the role stopped. Worker 11, whose updater was off, held the
 * pin. The bootstrap already stopped the updater first (`edge-pin-parity.test.ts` pins that copy); this pins
 * the role.
 *
 * ONE STOP BEFORE THE INSTALL IS NOT ENOUGH (a11ign#4948): the installer re-registers the updater as it runs, so
 * the same pair runs again after the rename, and the second run is pinned too.
 *
 * The line `edge-pin-parity.test.ts` and this file draw: that one holds two COPIES of a pin equal, this one
 * holds the ORDER of one file's tasks. The order is read off the file's own top-level `- name:` lines, so no
 * YAML parser is needed (this package has no dependencies, ADR 0012).
 *
 * THE NEGATIVE CONTROL IS THE ASSERTION ITSELF, run on the same file with the two updater blocks put back
 * where they were, so the check is shown to fail on the defect rather than pass on a file that cannot
 * contain it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/edge-version.yml", import.meta.url)), "utf8");

const UPDATER_TASKS = [
  "Stop and disable EVERY Edge-updater scheduled task",
  "Stop and disable the updater's services",
];
/** Every task after which the role can stop at the Edge step, so every one the updater must precede. */
const STEPS_THAT_CAN_STOP_THE_ROLE = [
  "Fetch the pinned installer",
  "Refuse a DOWNGRADE unless it was explicitly authorised, and say which remedy applies",
  "Install it",
  "Complete the launcher rename, which is what actually makes the new build the running one",
];
const CLOSING_ASSERTION = "Refuse to call this provisioned unless Edge is the pinned build and the updater is off";
const RENAME = "Complete the launcher rename, which is what actually makes the new build the running one";
/**
 * The same pair, repeated after the install (a11ign#4948). The installer re-registers the updater as it runs, so the
 * early pair alone leaves a box that installed Edge this run with a live updater at the closing assertion.
 */
const LATE_UPDATER_TASKS = [
  "Stop and disable EVERY Edge-updater scheduled task again, after the install",
  "Stop and disable the updater's services again, after the install",
];

const taskHeads = (text: string) => [...text.matchAll(/^- name: (.+)$/gm)].map((m) => m[1].trim());

/** The text of one task: from its `- name:` line to the next top-level task, or to the end. */
function taskBlock(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `edge-version.yml has no task named "${name}": this test examines nothing`);
  const next = text.indexOf("\n- name: ", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

/** Which of the tasks the updater must precede come at or before an updater task. Empty means the order holds. */
function updaterOrderViolations(text: string): string[] {
  const heads = taskHeads(text);
  const at = (name: string) => heads.indexOf(name);
  const missing = [...UPDATER_TASKS, ...STEPS_THAT_CAN_STOP_THE_ROLE, CLOSING_ASSERTION].filter((n) => at(n) < 0);
  if (missing.length > 0) return [`task not found: ${missing.join("; ")}`];
  return UPDATER_TASKS.flatMap((updater) =>
    STEPS_THAT_CAN_STOP_THE_ROLE.filter((step) => at(updater) > at(step))
      .map((step) => `"${updater}" comes AFTER "${step}"`));
}

/** The late pair sits after the rename and before the closing assertion. Empty means it holds. */
function lateUpdaterViolations(text: string): string[] {
  const heads = taskHeads(text);
  const at = (name: string) => heads.indexOf(name);
  const missing = [...LATE_UPDATER_TASKS, RENAME, CLOSING_ASSERTION].filter((n) => at(n) < 0);
  if (missing.length > 0) return [`task not found: ${missing.join("; ")}`];
  return LATE_UPDATER_TASKS.flatMap((late) => [
    ...(at(late) <= at(RENAME) ? [`"${late}" comes BEFORE "${RENAME}"`] : []),
    ...(at(late) >= at(CLOSING_ASSERTION) ? [`"${late}" comes AFTER the closing assertion`] : []),
  ]);
}

/** The file with the late pair deleted: the role as it stood before a11ign#4948. */
function withoutLatePair(text: string): string {
  return LATE_UPDATER_TASKS.reduce((rest, name) => rest.replace(taskBlock(text, name), ""), text);
}

/** The file with the late pair moved to sit just after the closing assertion. */
function withLatePairAfterRefusal(text: string): string {
  const blocks = LATE_UPDATER_TASKS.map((name) => taskBlock(text, name));
  const without = blocks.reduce((rest, block) => rest.replace(block, ""), text);
  const closing = taskBlock(without, CLOSING_ASSERTION);
  return without.replace(closing, closing + blocks.join(""));
}

/** The file as it was before #4732: both updater blocks moved to sit just before the closing assertion. */
function withUpdaterAfterInstall(text: string): string {
  const blocks = UPDATER_TASKS.map((name) => taskBlock(text, name));
  const without = blocks.reduce((rest, block) => rest.replace(block, ""), text);
  const closing = `- name: ${CLOSING_ASSERTION}\n`;
  assert.equal(without.split(closing).length, 2, "the closing assertion must appear exactly once");
  return without.replace(closing, blocks.join("") + closing);
}

test("the updater's tasks and services come BEFORE every Edge step that can stop the role", () => {
  assert.deepEqual(updaterOrderViolations(TASKS), [],
    "a box that stops at one of these steps has a live updater, and a live updater moves Edge past the pin "
    + "while the role is stopped (a11ign#4732)");
});

test("the late pair sits after the rename and before the closing assertion (a11ign#4948)", () => {
  assert.deepEqual(lateUpdaterViolations(TASKS), [],
    "a box that installed Edge this run ends the install with a live updater, and the closing assertion refuses it");
});

test("the closing assertion stays, and comes after the install and the updater", () => {
  const heads = taskHeads(TASKS);
  const closing = heads.indexOf(CLOSING_ASSERTION);
  assert.ok(closing >= 0, "the task that refuses to call the box provisioned is gone");
  for (const earlier of [...UPDATER_TASKS, ...LATE_UPDATER_TASKS, "Install it"]) {
    assert.ok(heads.indexOf(earlier) < closing, `"${earlier}" must come before the closing assertion`);
  }
});

test("control: the late-pair assertion FAILS when the late pair is deleted", () => {
  const before = withoutLatePair(TASKS);
  assert.notEqual(before, TASKS, "the mutation changed nothing, so it controls nothing");
  assert.match(lateUpdaterViolations(before).join(" "), /task not found/);
});

test("control: the late-pair assertion FAILS when the late pair moves after the refusal", () => {
  const after = withLatePairAfterRefusal(TASKS);
  assert.deepEqual([...taskHeads(after)].sort(), [...taskHeads(TASKS)].sort(), "the mutation lost or added a task");
  assert.ok(lateUpdaterViolations(after).some((v) => v.includes("AFTER the closing assertion")),
    "the late-pair assertion passed with the pair after the refusal, so it cannot see the defect");
});

test("control: the same assertion FAILS on the file with the updater blocks put back after the install", () => {
  const before = withUpdaterAfterInstall(TASKS);
  assert.notEqual(before, TASKS, "the mutation changed nothing, so it controls nothing");
  assert.deepEqual([...taskHeads(before)].sort(), [...taskHeads(TASKS)].sort(), "the mutation lost or added a task");
  const violations = updaterOrderViolations(before);
  assert.ok(violations.length > 0, "the order assertion passed on the pre-#4732 order, so it cannot see the defect");
  assert.ok(violations.some((v) => v.includes("AFTER \"Install it\"")),
    `the violations did not name the install: ${violations.join(" | ")}`);
});

test("control: a file missing an updater task is refused, not passed", () => {
  const without = TASKS.replace(taskBlock(TASKS, UPDATER_TASKS[0]), "");
  assert.match(updaterOrderViolations(without).join(" "), /task not found/);
});
