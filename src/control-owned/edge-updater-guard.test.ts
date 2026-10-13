/**
 * THE EDGE UPDATER STAYS OFF BECAUSE SOMETHING RE-ASSERTS IT (a11ign#5015, part of #4405).
 *
 * `edge-version.yml` disabled the updater's tasks and services once per provision. Between provisions
 * nothing kept them off, and Edge puts a task back: 12 boxes ended a11ign#4948's first run at the closing
 * assertion with `MicrosoftEdgeUpdateBrowserReplacementTask` `Ready`. The role now registers a SYSTEM task that
 * repeats the same two levers at startup and on an interval, and writes down what it had to undo.
 *
 * What this pins, read off the file's text (this package has no dependencies, ADR 0012, so no YAML parser):
 * the guard runs as SYSTEM with a startup trigger and a repeating one; it matches the updater's tasks by
 * the `MicrosoftEdgeUpdate*` PREFIX, because the set grew once already; it STOPS before it disables (the
 * 2026-08-25 lesson in the same file); it writes the record; and the closing assertion requires the guard.
 *
 * Policy was NOT added: the header of `edge-version.yml` records that the EdgeUpdate policies are stored and
 * never honoured on these standalone boxes, so there is no policy assertion here and none is wanted.
 *
 * EACH CONTROL RUNS THE SAME ASSERTION on the same file with ONE property mutated, so the check is shown to
 * fail on the defect rather than pass on a file that cannot contain it. The positive control is the first test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/edge-version.yml", import.meta.url)), "utf8");

const GUARD_BLOCK = "Register the guard that re-asserts the Edge updater, because disabling it once is not keeping it off";
const CLOSING_ASSERTION = "Refuse to call this provisioned unless Edge is the pinned build and the updater is off";
const GUARD_TASK_NAME = "a11y-edge-updater-guard";
const RECORD = "edge-updater-guard.json";

/** The text of one top-level task: from its `- name:` line to the next top-level task, or to the end. */
function taskBlock(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `edge-version.yml has no task named "${name}": this test examines nothing`);
  const next = text.indexOf("\n- name: ", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

/** The guard's script: the `content: |` of "Lay the guard script", up to the next nested task. */
function guardScript(text: string): string {
  const block = taskBlock(text, GUARD_BLOCK);
  const at = block.indexOf("content: |\n");
  assert.ok(at >= 0, "the guard block lays no script");
  const rest = block.slice(at);
  const next = rest.indexOf("\n    - name: ");
  // Comments name the very cmdlets under test ("Disable-ScheduledTask does not terminate ..."), so an order
  // read off the raw text would find them there.
  return (next < 0 ? rest : rest.slice(0, next)).replace(/^\s*#.*$/gm, "");
}

/** The registration: the nested "Register the guard task" task. */
function guardRegistration(text: string): string {
  const block = taskBlock(text, GUARD_BLOCK);
  const at = block.indexOf("    - name: Register the guard task");
  assert.ok(at >= 0, "the guard block registers no task");
  return block.slice(at);
}

const ORDER_AFTER_INSTALL = "the guard is registered before the install";
const NOT_FOUND = "guard block or closing assertion not found";

/** Where the guard sits among the file's top-level tasks. */
function placementViolations(text: string): string[] {
  const heads = [...text.matchAll(/^- name: (.+)$/gm)].map((m) => m[1].trim());
  const guardAt = heads.indexOf(GUARD_BLOCK);
  const closingAt = heads.indexOf(CLOSING_ASSERTION);
  if (guardAt < 0 || closingAt < 0) return [NOT_FOUND];
  return [
    guardAt > closingAt ? "the guard is registered AFTER the closing assertion that requires it" : "",
    guardAt < heads.indexOf("Install it") ? ORDER_AFTER_INSTALL : "",
  ].filter(Boolean);
}

/** [what is wrong, whether it is wrong] for the registration: who it runs as and when. */
function registrationChecks(text: string): Array<[string, boolean]> {
  const reg = guardRegistration(text);
  const has = (re: RegExp) => re.test(reg);
  return [
    ["the guard does not run as SYSTEM", !has(/^\s+username: SYSTEM$/m)],
    ["the guard does not run at the highest run level", !has(/^\s+run_level: highest$/m)],
    ["no startup trigger", !has(/^\s+- type: boot$/m)],
    ["no repeating trigger", !has(/^\s+repetition:$/m)
      || !has(/^\s+- interval: "PT\{\{ edge_guard_interval_minutes \}\}M"$/m)],
    ["the guard task is not enabled", !has(/^\s+enabled: true$/m)],
    ["the guard task's name is not pinned",
      !reg.includes(`name: "{{ edge_guard_task }}"`) || !text.includes(`edge_guard_task: ${GUARD_TASK_NAME}`)],
  ];
}

/** [what is wrong, whether it is wrong] for the script: what it matches, in what order, and what it writes. */
function scriptChecks(text: string): Array<[string, boolean]> {
  const script = guardScript(text);
  const before = (first: string, second: string) => script.indexOf(first) < 0 || script.indexOf(first) > script.indexOf(second);
  return [
    ["tasks are not matched by prefix", !script.includes("Get-ScheduledTask -TaskName 'MicrosoftEdgeUpdate*'")],
    ["the script names tasks instead of matching them", /MicrosoftEdgeUpdateTask(MachineCore|MachineUA)/.test(script)],
    ["a task is disabled before it is stopped", before("Stop-ScheduledTask", "Disable-ScheduledTask")],
    ["a service is disabled before it is stopped", before("Stop-Service", "Set-Service")],
    ["services are not set Disabled", !script.includes("-StartupType Disabled")],
    ["the record is not written with checkedAt and reenabled",
      !script.includes(RECORD) || !script.includes("checkedAt") || !script.includes("reenabled")],
    ["the record is not written atomically", !script.includes("Move-Item")],
    ["the previous record is not read before the new one is written",
      script.indexOf("Get-Content -LiteralPath $record") < 0
      || script.indexOf("Get-Content -LiteralPath $record") > script.indexOf("Set-Content")],
    ["a run that changed something does not set lastReenabledAt and lastReenabled from itself",
      !/if \(\$reenabled\.Count -gt 0\) \{\s+\$entry\.lastReenabledAt = \$entry\.checkedAt\s+\$entry\.lastReenabled = @\(\$reenabled\)/.test(script)],
    ["a run that changed nothing does not carry the previous lastReenabledAt and lastReenabled forward",
      !/elseif \(\$previous -and \$previous\.lastReenabledAt\) \{\s+\$entry\.lastReenabledAt = \$previous\.lastReenabledAt\s+\$entry\.lastReenabled = @\(\$previous\.lastReenabled\)/.test(script)],
    ["a run that changed nothing invents lastReenabledAt for a box that never re-enabled",
      /^\s*\$entry\.lastReenabledAt = (Get-Date|\$entry\.checkedAt)/m.test(script.replace(/if \(\$reenabled\.Count -gt 0\) \{[^}]*\}/, ""))],
  ];
}

function closingAssertionChecks(text: string): Array<[string, boolean]> {
  const closing = taskBlock(text, CLOSING_ASSERTION);
  return [["the closing assertion does not require the guard task",
    !closing.includes(`Guard: ${GUARD_TASK_NAME}`) || !/Get-ScheduledTask -TaskName \$Guard/.test(closing)]];
}

/** Everything the guard must be, as a list of what is wrong. Empty means the guard holds. */
function guardViolations(text: string): string[] {
  const placed = placementViolations(text);
  if (placed.includes(NOT_FOUND)) return placed;
  const checks = [...registrationChecks(text), ...scriptChecks(text), ...closingAssertionChecks(text)];
  return [...placed, ...checks.filter(([, wrong]) => wrong).map(([message]) => message)];
}

/** TASKS with substitutions made inside the guard block only, each asserted to have changed it. */
function mutatedGuard(...edits: Array<[string, string]>): string {
  const block = taskBlock(TASKS, GUARD_BLOCK);
  const mutated = edits.reduce((text, [from, to]) => {
    assert.ok(text.includes(from), `"${from}" is not in the guard block, so the control mutates nothing`);
    return text.replace(from, to);
  }, block);
  return TASKS.replace(block, mutated);
}

test("the guard holds: SYSTEM, startup and repeating triggers, prefix match, stop before disable, a record", () => {
  assert.deepEqual(guardViolations(TASKS), [],
    "without these, Edge puts a task back between provisions and the updater moves the pin (a11ign#5015)");
});

test("the interval is a variable at the top of the block, not a new defaults key", () => {
  assert.match(TASKS, /edge_guard_interval_minutes: 15\n/);
  assert.doesNotMatch(readFileSync(
    fileURLToPath(new URL("../../ansible/roles/worker/defaults/main.yml", import.meta.url)), "utf8"),
    /edge_guard/);
});

test("control: prefix replaced by a two-name list FAILS", () => {
  const v = guardViolations(mutatedGuard(["Get-ScheduledTask -TaskName 'MicrosoftEdgeUpdate*'",
    "Get-ScheduledTask -TaskName @('MicrosoftEdgeUpdateTaskMachineCore','MicrosoftEdgeUpdateTaskMachineUA')"]));
  assert.ok(v.includes("tasks are not matched by prefix") && v.includes("the script names tasks instead of matching them"), v.join("|"));
});

const STOP_TASK = "if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath; $changed = $true }\n";
const DISABLE_TASK = "            if ($t.State -ne 'Disabled') {";
const STOP_SERVICE = "if ($svc.Status -ne 'Stopped') { Stop-Service -Name $name -Force; $changed = $true }\n";
const DISABLE_SERVICE = "            if ($svc.StartType -ne 'Disabled') {";

test("control: disabling a task before stopping it FAILS", () => {
  const stop = "            " + STOP_TASK;
  const v = guardViolations(mutatedGuard([stop, ""], [DISABLE_TASK, DISABLE_TASK + " Disable-ScheduledTask -TaskName $t.TaskName }\n"
    + "            if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName $t.TaskName }\n            if (0) {"]));
  assert.ok(v.includes("a task is disabled before it is stopped"), v.join("|"));
});

test("control: disabling a service before stopping it FAILS", () => {
  const stop = "            " + STOP_SERVICE;
  const v = guardViolations(mutatedGuard([stop, ""], [DISABLE_SERVICE, DISABLE_SERVICE + " Set-Service -Name $name -StartupType Disabled }\n"
    + "            if ($svc.Status -ne 'Stopped') { Stop-Service -Name $name }\n            if (0) {"]));
  assert.ok(v.includes("a service is disabled before it is stopped"), v.join("|"));
});

test("control: not SYSTEM, no startup trigger, no repetition, no record, not required by the closing assertion each FAIL", () => {
  const cases: Array<[string, string]> = [
    ["username: SYSTEM", "username: {{ ansible_user }}"],
    ["- type: boot", "- type: logon"],
    ["repetition:", "repeat_not:"],
    [RECORD, "something-else.json"],
    [`Guard: ${GUARD_TASK_NAME}`, "Guard: nothing"],
  ];
  const expected = ["does not run as SYSTEM", "no startup trigger", "no repeating trigger", "the record is not written",
    "does not require the guard task"];
  cases.forEach(([from, to], i) => {
    const out = TASKS.split(from).join(to);
    assert.notEqual(out, TASKS, `mutation ${i} changed nothing`);
    assert.match(guardViolations(out).join("|"), new RegExp(expected[i]), `mutation ${i} was not noticed`);
  });
});

test("control: a file with no guard is refused, not passed", () => {
  const v = guardViolations(TASKS.replace(taskBlock(TASKS, GUARD_BLOCK), ""));
  assert.deepEqual(v, [NOT_FOUND]);
});

test("the record keeps the last re-enable across clean runs (a11ign#5048)", () => {
  const script = guardScript(TASKS);
  assert.match(script, /\$previous\.lastReenabledAt/);
  assert.match(script, /\$entry\.lastReenabled = @\(\$reenabled\)/);
});

test("control: a record rewritten fresh every run, with no read of the previous one, FAILS", () => {
  const v = guardViolations(mutatedGuard(["Get-Content -LiteralPath $record", "Get-Content -LiteralPath $other"]));
  assert.ok(v.includes("the previous record is not read before the new one is written"), v.join("|"));
});

test("control: a clean run that does not carry the previous last re-enable FAILS", () => {
  const v = guardViolations(mutatedGuard(["$entry.lastReenabledAt = $previous.lastReenabledAt", "$entry.lastSeen = $previous.lastReenabledAt"]));
  assert.ok(v.includes("a run that changed nothing does not carry the previous lastReenabledAt and lastReenabled forward"), v.join("|"));
});

test("control: a run that changed something and does not set its own last re-enable FAILS", () => {
  const v = guardViolations(mutatedGuard(["$entry.lastReenabledAt = $entry.checkedAt", "$entry.lastSeen = $entry.checkedAt"]));
  assert.ok(v.includes("a run that changed something does not set lastReenabledAt and lastReenabled from itself"), v.join("|"));
});

test("control: a clean run that stamps lastReenabledAt for itself (a drift invented) FAILS", () => {
  const v = guardViolations(mutatedGuard(["$entry.lastReenabledAt = $previous.lastReenabledAt", "$entry.lastReenabledAt = $entry.checkedAt"]));
  assert.ok(v.includes("a run that changed nothing invents lastReenabledAt for a box that never re-enabled")
    || v.includes("a run that changed nothing does not carry the previous lastReenabledAt and lastReenabled forward"), v.join("|"));
});
