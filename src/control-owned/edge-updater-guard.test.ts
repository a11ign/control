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
 * A11-183 (2026-10-24) found the guard had been failing on twelve boxes for days and nothing said so: it runs as SYSTEM, and the `edgeupdate`
 * service's security descriptor withholds SERVICE_CHANGE_CONFIG from SYSTEM, so `Set-Service -StartupType Disabled` threw under
 * `$ErrorActionPreference = 'Stop'` BEFORE the record was written. The guard now writes the start type through the Services registry key, stops
 * any running `MicrosoftEdgeUpdate*` process, handles each task, service and process on its own, always writes its record, and exits non-zero when
 * anything stayed on. The closing assertion RUNS the guard and requires result 0, because a guard that is registered but cannot work is not a hold.
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
      || !has(/^\s+interval: "PT\{\{ edge_guard_interval_minutes \}\}M"$/m)],
    // A LIST here reads as an array to win_scheduled_task, which tests `-is [Hashtable]` and hands the array to
    // COM as Repetition: "failed to set trigger property 'Repetition' ... Index was outside the bounds" (a11ign#5472).
    ["repetition is a list, which the module cannot set", has(/^\s+repetition:\n\s+- /m)],
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
    ["a service's start type is set before it is stopped", before("Stop-Service", "Set-ItemProperty")],
    ["the start type is not written through the Services registry key as Start 4",
      !/Set-ItemProperty -LiteralPath \$key -Name Start -Value 4 -Type DWord/.test(script)
      || !script.includes('$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$name"')],
    // SYSTEM has no SERVICE_CHANGE_CONFIG on `edgeupdate`, so any call through the service manager throws there (A11-183).
    ["the start type is changed through the service manager, which SYSTEM may not do", /Set-Service|sc(\.exe)?\s+config|-StartupType/.test(script)],
    ["running MicrosoftEdgeUpdate processes are not stopped",
      !script.includes("Get-Process -Name 'MicrosoftEdgeUpdate*'") || !/Stop-Process -Id \$p\.Id -Force/.test(script)],
    // The pinned MSI runs `MicrosoftEdgeUpdate.exe /install` itself: killing that one fails the role's install (A11-183).
    ["the process stop does not wait for the role's own Edge install",
      !/Get-CimInstance Win32_Process -Filter "Name = 'msiexec\.exe'"[^\n]*MicrosoftEdgeEnterprise/.test(script)
      || !/\$installing\.Count -gt 0\) \{ @\(\) \}/.test(script)],
    ["the first failure aborts the run before the record is written", /\$ErrorActionPreference = 'Stop'/.test(script)],
    ["an item is not handled on its own: a task, service or process failure is not caught and recorded",
      (script.match(/\} catch \{[^\n]*\$failed \+= /g) ?? []).length < 5],
    ["the record does not say what could not be changed", !/failed = @\(\$failed\)/.test(script)],
    ["the record is written before the items are handled", script.indexOf("Set-Content") < script.lastIndexOf("$failed += ")],
    ["the script does not exit non-zero when something stayed on",
      !/\} catch \{ exit 1 \}\s*(#[^\n]*\s*)*if \(\$failed\.Count -gt 0\) \{ exit 1 \}\s*$/.test(script.replace(/^\s*#.*$/gm, ""))],
    ["a record that cannot be written ends the task zero", !/Move-Item[^\n]*-ErrorAction Stop\s*\} catch \{ exit 1 \}/.test(script)],
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
  return [
    ["the closing assertion does not require the guard task",
      !closing.includes(`Guard: ${GUARD_TASK_NAME}`) || !/Get-ScheduledTask -TaskName \$Guard/.test(closing)],
    ["the closing assertion does not start the guard", !/Start-ScheduledTask -TaskName \$Guard/.test(closing)],
    // `win_powershell` runs under --check, and running the guard changes the box: the registry, the services and the processes.
    ["the closing assertion runs the guard under --check", !/elseif \(-not \$Ansible\.CheckMode\) \{[\s\S]*Start-ScheduledTask -TaskName \$Guard/.test(closing)],
    ["the closing assertion does not require a record newer than the start",
      !/\(\[datetime\]\$r\.checkedAt\)\.ToUniversalTime\(\) -gt \$started\)/.test(closing)],
    ["the closing assertion does not wait for the guard with a bound", !/\$deadline = \(Get-Date\)\.AddSeconds\(120\)/.test(closing)],
    ["the closing assertion does not require the guard's result to be 0",
      !/\(Get-ScheduledTaskInfo -TaskName \$Guard\)\.LastTaskResult/.test(closing) || !/if \(\$result -ne 0\) \{ \$wrong \+= /.test(closing)],
    ["the closing assertion does not require an empty list of what the guard could not change",
      !/@\(\$fresh\.failed\)\.Count -gt 0/.test(closing)],
    ["the closing assertion does not require the registry start type of the updater's services to be 4",
      !/-Name Start -ErrorAction SilentlyContinue\)\.Start/.test(closing) || !/\$start -ne 4/.test(closing)],
  ];
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

test("control: repetition written as a list FAILS, because win_scheduled_task cannot set it (a11ign#5472)", () => {
  const v = guardViolations(mutatedGuard([
    `repetition:\n              interval: "PT{{ edge_guard_interval_minutes }}M"\n              duration: P1D`,
    `repetition:\n              - interval: "PT{{ edge_guard_interval_minutes }}M"\n                duration: P1D`]));
  assert.ok(v.includes("repetition is a list, which the module cannot set"), v.join("|"));
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

const STOP_TASK_CALL = "Stop-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop";
const DISABLE_TASK_CALL = "Disable-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -ErrorAction Stop | Out-Null }";
const STOP_SERVICE_CALL = "Stop-Service -Name $name -Force -ErrorAction Stop";
const WRITE_START_CALL = "Set-ItemProperty -LiteralPath $key -Name Start -Value 4 -Type DWord -ErrorAction Stop }";

test("control: disabling a task before stopping it FAILS", () => {
  const v = guardViolations(mutatedGuard([STOP_TASK_CALL, "$null"], [DISABLE_TASK_CALL, DISABLE_TASK_CALL.replace(" }", "; Stop-ScheduledTask -TaskName $t.TaskName }")]));
  assert.ok(v.includes("a task is disabled before it is stopped"), v.join("|"));
});

test("control: writing a service's start type before stopping it FAILS", () => {
  const v = guardViolations(mutatedGuard([STOP_SERVICE_CALL, "$null"], [WRITE_START_CALL, WRITE_START_CALL.replace(" }", "; Stop-Service -Name $name -Force }")]));
  assert.ok(v.includes("a service's start type is set before it is stopped"), v.join("|"));
});

test("the guard writes the service's start type through the Services registry key, and never through the service manager", () => {
  const script = guardScript(TASKS);
  assert.match(script, /\$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\\$name"/);
  assert.match(script, /Set-ItemProperty -LiteralPath \$key -Name Start -Value 4 -Type DWord/);
  assert.doesNotMatch(script, /Set-Service|-StartupType/, "SYSTEM has no SERVICE_CHANGE_CONFIG on edgeupdate: the call throws there (A11-183)");
});

test("control: Set-Service -StartupType Disabled in place of the registry write FAILS", () => {
  const v = guardViolations(mutatedGuard([WRITE_START_CALL, "Set-Service -Name $name -StartupType Disabled -ErrorAction Stop }"]));
  assert.ok(v.includes("the start type is not written through the Services registry key as Start 4"), v.join("|"));
  assert.ok(v.includes("the start type is changed through the service manager, which SYSTEM may not do"), v.join("|"));
});

test("the guard stops any running MicrosoftEdgeUpdate* process", () => {
  assert.match(guardScript(TASKS), /Get-Process -Name 'MicrosoftEdgeUpdate\*'[\s\S]*Stop-Process -Id \$p\.Id -Force/);
});

test("control: a guard that stops the updater while the role's own MSI is installing FAILS", () => {
  const v = guardViolations(mutatedGuard(["if ($installing.Count -gt 0) { @() }", "if ($false) { @() }"]));
  assert.ok(v.includes("the process stop does not wait for the role's own Edge install"), v.join("|"));
});

test("the role stops an updater process that is already running BEFORE it installs, and says why", () => {
  const block = taskBlock(TASKS, "Stop any Edge-updater process that is already running");
  assert.match(block, /Get-Process -Name 'MicrosoftEdgeUpdate\*', 'MicrosoftEdge_X64_\*'/);
  assert.match(block, /Stop-Process -Id \$p\.Id -Force/);
  assert.ok(TASKS.indexOf(block) < TASKS.indexOf("- name: Install it\n"), "the stop must come before the install");
});

test("control: a guard that leaves the updater process running FAILS", () => {
  const v = guardViolations(mutatedGuard(["Stop-Process -Id $p.Id -Force", "Get-Process -Id $p.Id"]));
  assert.ok(v.includes("running MicrosoftEdgeUpdate processes are not stopped"), v.join("|"));
});

test("the record is written on a failing path: nothing aborts the run, every item is caught, and the record says what could not be changed", () => {
  const script = guardScript(TASKS);
  assert.doesNotMatch(script, /\$ErrorActionPreference = 'Stop'/);
  assert.equal((script.match(/\} catch \{[^\n]*\$failed \+= /g) ?? []).length, 5, "one catch each for the task's stop and its disable, the service's stop and its start type, and the process");
  assert.ok(script.indexOf("Set-Content") > script.lastIndexOf("$failed += "), "the record is written after every item had its turn");
  assert.match(script, /failed = @\(\$failed\)/);
});

test("control: a guard under `$ErrorActionPreference = 'Stop'`, or one that does not catch an item, FAILS", () => {
  const aborting = guardViolations(mutatedGuard(["$ErrorActionPreference = 'Continue'", "$ErrorActionPreference = 'Stop'"]));
  assert.ok(aborting.includes("the first failure aborts the run before the record is written"), aborting.join("|"));
  const uncaught = guardViolations(mutatedGuard(["catch { $changed = $true; $failed += \"task:$($t.TaskName): disable:", "catch { $changed = $true; $other += \"task:$($t.TaskName): disable:"]));
  assert.ok(uncaught.includes("an item is not handled on its own: a task, service or process failure is not caught and recorded"), uncaught.join("|"));
  const silent = guardViolations(mutatedGuard(["reenabled = @($reenabled); failed = @($failed) }", "reenabled = @($reenabled) }"]));
  assert.ok(silent.includes("the record does not say what could not be changed"), silent.join("|"));
});

test("the guard exits non-zero when something stayed on, after the record is written", () => {
  assert.match(guardScript(TASKS), /\} catch \{ exit 1 \}\s*if \(\$failed\.Count -gt 0\) \{ exit 1 \}\s*$/);
});

test("control: a record that cannot be written and ends the task 0 FAILS (the failure that made the old record go stale unseen)", () => {
  const v = guardViolations(mutatedGuard(["} catch { exit 1 }", "} catch { }"]));
  assert.ok(v.includes("a record that cannot be written ends the task zero"), v.join("|"));
});

test("a process that exited between the listing and the stop is not a failure", () => {
  assert.match(guardScript(TASKS), /catch \{ if \(Get-Process -Id \$p\.Id -ErrorAction SilentlyContinue\) \{ \$failed \+= /);
});

test("control: a guard that exits 0 whatever stayed on FAILS", () => {
  const v = guardViolations(mutatedGuard(["if ($failed.Count -gt 0) { exit 1 }", "if ($failed.Count -gt 0) { exit 0 }"]));
  assert.ok(v.includes("the script does not exit non-zero when something stayed on"), v.join("|"));
});

/** The closing assertion with one property mutated, asserted to have changed it. */
function mutatedClosing(...edits: Array<[string, string]>): string {
  const block = taskBlock(TASKS, CLOSING_ASSERTION);
  const mutated = edits.reduce((text, [from, to]) => {
    assert.ok(text.includes(from), `"${from}" is not in the closing assertion, so the control mutates nothing`);
    return text.replace(from, to);
  }, block);
  return TASKS.replace(block, mutated);
}

test("the closing assertion starts the guard, waits a bounded time for a newer record, and requires result 0 and nothing it could not change", () => {
  const closing = taskBlock(TASKS, CLOSING_ASSERTION);
  assert.match(closing, /Start-ScheduledTask -TaskName \$Guard/);
  assert.match(closing, /\$deadline = \(Get-Date\)\.AddSeconds\(120\)/);
  assert.match(closing, /\(\[datetime\]\$r\.checkedAt\)\.ToUniversalTime\(\) -gt \$started\)/);
  assert.match(closing, /\(Get-ScheduledTaskInfo -TaskName \$Guard\)\.LastTaskResult/);
  assert.match(closing, /if \(\$result -ne 0\) \{ \$wrong \+= "guard task \$Guard ended with result \$result, expected 0" \}/);
  assert.match(closing, /@\(\$fresh\.failed\)\.Count -gt 0/);
  assert.match(closing, /\$start -ne 4/);
});

test("control: a closing assertion that never starts the guard, ignores its result, or accepts an old record FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["Start-ScheduledTask -TaskName $Guard", "Get-ScheduledTask -TaskName $Guard | Out-Null", "does not start the guard"],
    ["if ($result -ne 0) { $wrong += ", "if ($result -ne 0) { $ignored = ", "does not require the guard's result to be 0"],
    ["-gt $started", "-gt $started.AddYears(-1)", "does not require a record newer than the start"],
    ["@($fresh.failed).Count -gt 0", "@($fresh.failed).Count -gt 99", "does not require an empty list of what the guard could not change"],
    ["$start -ne 4", "$start -ne $null", "does not require the registry start type"],
    ["$deadline = (Get-Date).AddSeconds(120)", "$deadline = [datetime]::MaxValue", "does not wait for the guard with a bound"],
    ["elseif (-not $Ansible.CheckMode) {", "else {", "runs the guard under --check"],
  ];
  for (const [from, to, expected] of cases) {
    assert.match(guardViolations(mutatedClosing([from, to])).join("|"), new RegExp(expected), `"${from}" mutated was not noticed`);
  }
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

const DIRECTORY_TASK = "    - name: Create the guard directory";
const LAY_SCRIPT = "    - name: Lay the guard script";
const NOT_CREATED = "the guard directory is not created before the script is laid, so the copy fails where it is absent (#5466)";

/** The guard block up to the script copy: the directory, its ACL, and nothing that runs the guard. */
function directorySection(text: string): string {
  const block = taskBlock(text, GUARD_BLOCK);
  const at = block.indexOf(DIRECTORY_TASK);
  const lay = block.indexOf(LAY_SCRIPT);
  return at < 0 || lay < at ? "" : block.slice(at, lay);
}

/** What the guard directory must be, as a list of what is wrong. Empty means it holds. */
function directoryViolations(text: string): string[] {
  const section = directorySection(text);
  if (!section) return [NOT_CREATED];
  const checks: Array<[string, boolean]> = [
    ["the guard directory is not created", !/ansible\.windows\.win_file:\n\s+path: "\{\{ edge_guard_dir \}\}"\n\s+state: directory$/m.test(section)],
    ["the guard directory keeps the ACL it inherits from ProgramData",
      !/ansible\.windows\.win_acl_inheritance:\n\s+path: "\{\{ edge_guard_dir \}\}"\n\s+state: absent\n\s+reorganize: false/.test(section)],
    ["Users may do more than read the guard directory",
      !/\{ user: 'BUILTIN\\Users', rights: ReadAndExecute \}/.test(section) || /BUILTIN\\Users', rights: (?!ReadAndExecute)/.test(section)],
    ["SYSTEM and Administrators are not the only writers",
      !/\{ user: 'BUILTIN\\Administrators', rights: FullControl \}/.test(section) || !/\{ user: 'NT AUTHORITY\\SYSTEM', rights: FullControl \}/.test(section)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([message]) => message);
}

test("the guard directory exists before the script is laid, owned by SYSTEM and Administrators, readable by Users", () => {
  assert.deepEqual(directoryViolations(TASKS), [],
    "a SYSTEM script in a directory Users can write is a privilege escalation, and nothing creates the directory (#5466)");
});

test("control: the directory task removed FAILS, and so does one laid after the script", () => {
  assert.deepEqual(directoryViolations(mutatedGuard([directorySection(TASKS), ""])), [NOT_CREATED]);
  // Moved to the end of the block, after the script copy and the registration: the copy would already have failed.
  const block = taskBlock(TASKS, GUARD_BLOCK);
  const head = block.slice(0, block.indexOf(DIRECTORY_TASK));
  const afterScript = head + block.slice(block.indexOf(LAY_SCRIPT)) + directorySection(TASKS);
  assert.deepEqual(directoryViolations(TASKS.replace(block, afterScript)), [NOT_CREATED]);
});

test("control: Users granted write, or the inherited ACL kept, FAILS", () => {
  const v = directoryViolations(mutatedGuard(["{ user: 'BUILTIN\\Users', rights: ReadAndExecute }", "{ user: 'BUILTIN\\Users', rights: Modify }"]));
  assert.ok(v.includes("Users may do more than read the guard directory"), v.join("|"));
  const kept = directoryViolations(mutatedGuard(["        reorganize: false\n", "        reorganize: true\n"]));
  assert.ok(kept.includes("the guard directory keeps the ACL it inherits from ProgramData"), kept.join("|"));
});
