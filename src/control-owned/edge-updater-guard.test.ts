/**
 * THE EDGE UPDATER GUARD IS A DETECTOR, NOT THE MECHANISM (A11-205, docs/adr/0001; before that a11ign#5015 and A11-183).
 *
 * The guard used to race the updater: every fifteen minutes it disabled whatever had come back, and it lost often enough that Edge moved itself on four
 * occasions. The freeze (`tasks/freeze.yml`) holds the updater off now, and the daily freeze run puts a lever back. The guard only LOOKS: a task present, a
 * service not at `Start` 4 or running, an updater binary under its own name, an updater process. It writes down what it found and changes nothing.
 *
 * What this pins, read off the file's text (this package has no dependencies, ADR 0012, so no YAML parser): the guard runs as SYSTEM with a startup trigger
 * and a repeating one; it matches the updater's tasks by the `MicrosoftEdgeUpdate*` PREFIX; it calls NO cmdlet that writes, stops, disables, renames or
 * removes anything but its own record; it keeps the record's shape (`checkedAt`, `reenabled`, `failed`, `lastReenabled*`), so screenreader-worker's
 * `edgeUpdaterGuardFrom` (a non-empty `reenabled` reads `drift`) and `fleet:status`'s "Edge updater NOT HELD" keep their meaning and no worker release is
 * needed; and the closing assertion RUNS it and requires result 0 and nothing found. A11-183 (2026-10-24) found the old guard failing on twelve boxes for days
 * and nothing saying so, so the record is always written and the script exits non-zero when anything was found or could not be read.
 *
 * EACH CONTROL RUNS THE SAME ASSERTION on the same file with ONE property mutated, so the check is shown to fail on the defect rather than pass on a file that
 * cannot contain it. The positive control is the first test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/edge-version.yml", import.meta.url)), "utf8");

const GUARD_BLOCK = "Register the guard that REPORTS when the Edge updater is not frozen";
const CLOSING_ASSERTION = "Refuse to call this provisioned unless Edge is the pinned build and the updater is frozen";
const GUARD_TASK_NAME = "a11y-edge-updater-guard";
const RECORD = "edge-updater-guard.json";

/** The text of one top-level task: from its `- name:` line to the next top-level task, or to the end. */
function taskBlock(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `edge-version.yml has no task named "${name}": this test examines nothing`);
  const next = text.indexOf("\n- name: ", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

/** The guard's script: the `content: |` of "Lay the guard script", up to the next nested task, comments removed (they name the very cmdlets under test). */
function guardScript(text: string): string {
  const block = taskBlock(text, GUARD_BLOCK);
  const at = block.indexOf("content: |\n");
  assert.ok(at >= 0, "the guard block lays no script");
  const rest = block.slice(at);
  const next = rest.indexOf("\n    - name: ");
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
    guardAt < heads.indexOf("Install the pinned Edge when the box is not on it, and leave the updater frozen whatever happens") ? ORDER_AFTER_INSTALL : "",
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
    // A daily trigger with a one-day repetition does not begin repeating when the task is registered after 00:00 until the next midnight
    // (measured on the fleet, A11-183): the repetition must hang off a time trigger, and have no duration so it never ends.
    ["the repetition hangs off a daily trigger, which does not repeat after a registration until the next midnight", has(/^\s+- type: daily$/m)],
    ["the repetition is not on a time trigger", !has(/^\s+- type: time\n\s+start_boundary: '2026-01-01T00:00:00'\n\s+repetition:/m)],
    ["the repetition ends after a duration", has(/^\s+duration:/m)],
    // A LIST here reads as an array to win_scheduled_task, which tests `-is [Hashtable]` and hands the array to
    // COM as Repetition: "failed to set trigger property 'Repetition' ... Index was outside the bounds" (a11ign#5472).
    ["repetition is a list, which the module cannot set", has(/^\s+repetition:\n\s+- /m)],
    ["the guard task is not enabled", !has(/^\s+enabled: true$/m)],
    ["the guard task's name is not pinned",
      !reg.includes(`name: "{{ edge_guard_task }}"`) || !text.includes(`edge_guard_task: ${GUARD_TASK_NAME}`)],
  ];
}

/** Every cmdlet that WRITES, STOPS, DISABLES, RENAMES or REMOVES something. The detector may call none of them but `Set-Content`/`Move-Item` on its own record. */
const CHANGING_CMDLETS = /\b(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Set-Service|Stop-Service|Start-Service|Restart-Service|Stop-Process|Kill|Stop-ScheduledTask|Start-ScheduledTask|Disable-ScheduledTask|Enable-ScheduledTask|Unregister-ScheduledTask|Register-ScheduledTask|Rename-Item|Remove-Item|Copy-Item|New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewallRule|sc(\.exe)?\s+(config|stop))\b/;

/** [what is wrong, whether it is wrong] for the script: what it looks for, that it changes nothing, and what it writes. */
function scriptChecks(text: string): Array<[string, boolean]> {
  const script = guardScript(text);
  const moves = script.split("\n").filter((line) => /\bMove-Item\b/.test(line));
  return [
    ["tasks are not matched by prefix", !script.includes("Get-ScheduledTask -TaskName 'MicrosoftEdgeUpdate*'")],
    ["the script names tasks instead of matching them", /MicrosoftEdgeUpdateTask(MachineCore|MachineUA)/.test(script)],
    ["any updater task at all is not a finding", !script.includes('$found += "task:$($t.TaskName)"')],
    ["a service's start type is not read from the Services registry key",
      !/\$start = \(Get-ItemProperty -LiteralPath \$key -Name Start -ErrorAction Stop\)\.Start/.test(script)
      || !script.includes('$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$name"')],
    ["a service that is not at Start 4 is not a finding", !/if \(\$start -ne 4\) \{ \$found \+= "service:\$name" \}/.test(script)],
    ["a running service is not a finding", !/\$svc\.Status -ne 'Stopped'\) \{ \$found \+= "service:\$name" \}/.test(script)],
    ["a running MicrosoftEdgeUpdate process is not a finding",
      !script.includes("Get-Process -Name 'MicrosoftEdgeUpdate*', 'MicrosoftEdge_X64_*'") || !script.includes('$found += "process:$($p.ProcessName)"')],
    ["an updater binary under its own name is not a finding",
      !/Get-ChildItem -LiteralPath \$updaterDir -Recurse -File/.test(script) || !script.includes('$found += "binary:$($f.FullName)"')],
    // The pinned MSI runs `MicrosoftEdgeUpdate.exe /install` itself and the install restores the binaries: neither is a finding while it runs.
    ["the process and binary findings do not wait for the role's own Edge install",
      !/Get-CimInstance Win32_Process -Filter "Name = 'msiexec\.exe'"[^\n]*MicrosoftEdgeEnterprise/.test(script) || !/if \(\$installing\.Count -eq 0\) \{/.test(script)],
    ["the detector changes something: " + (CHANGING_CMDLETS.exec(script)?.[0] ?? ""), CHANGING_CMDLETS.test(script)],
    ["a Move-Item is not on the detector's own record", moves.some((line) => !line.includes("$record"))],
    ["the first failure aborts the run before the record is written", /\$ErrorActionPreference = 'Stop'/.test(script)],
    ["an item is not read on its own: a task, service or binary failure is not caught and recorded",
      (script.match(/catch \{[^\n]*\$failed \+= /g) ?? []).length < 3],
    // Windows PowerShell 5.1 emits a JSON array as ONE object, so each service must be a string of its own (A11-183, a11y-worker-11).
    ["the service list is not cast to string[], so 5.1 reads it as one name", !/\$services = \[string\[\]\]\('/.test(script)],
    ["the record does not say what could not be read", !/failed = @\(\$failed\)/.test(script)],
    ["the record does not say what was found", !/reenabled = @\(\$found\)/.test(script)],
    ["the record is written before the items are read", script.indexOf("Set-Content") < script.lastIndexOf("$failed += ")],
    ["the script does not exit non-zero when something was found or could not be read",
      !/\} catch \{ exit 1 \}\s*(#[^\n]*\s*)*if \(\$found\.Count -gt 0 -or \$failed\.Count -gt 0\) \{ exit 1 \}\s*$/.test(script.replace(/^\s*#.*$/gm, ""))],
    ["a record that cannot be written ends the task zero", !/Move-Item[^\n]*-ErrorAction Stop\s*\} catch \{ exit 1 \}/.test(script)],
    ["the record is not written with checkedAt and reenabled",
      !script.includes(RECORD) || !script.includes("checkedAt") || !script.includes("reenabled")],
    ["the record is not written atomically", !script.includes("Move-Item")],
    ["the previous record is not read before the new one is written",
      script.indexOf("Get-Content -LiteralPath $record") < 0
      || script.indexOf("Get-Content -LiteralPath $record") > script.indexOf("Set-Content")],
    ["a run that found something does not set lastReenabledAt and lastReenabled from itself",
      !/if \(\$found\.Count -gt 0\) \{\s+\$entry\.lastReenabledAt = \$entry\.checkedAt\s+\$entry\.lastReenabled = @\(\$found\)/.test(script)],
    ["a run that found nothing does not carry the previous lastReenabledAt and lastReenabled forward",
      !/elseif \(\$previous -and \$previous\.lastReenabledAt\) \{\s+\$entry\.lastReenabledAt = \$previous\.lastReenabledAt\s+\$entry\.lastReenabled = @\(\$previous\.lastReenabled\)/.test(script)],
    ["a run that found nothing invents lastReenabledAt for a box that was never found unfrozen",
      /^\s*\$entry\.lastReenabledAt = (Get-Date|\$entry\.checkedAt)/m.test(script.replace(/if \(\$found\.Count -gt 0\) \{[^}]*\}/, ""))],
  ];
}

function closingAssertionChecks(text: string): Array<[string, boolean]> {
  const closing = taskBlock(text, CLOSING_ASSERTION);
  return [
    ["the closing assertion does not require the guard task",
      !closing.includes(`Guard: ${GUARD_TASK_NAME}`) || !/Get-ScheduledTask -TaskName \$Guard/.test(closing)],
    ["the closing assertion does not start the guard", !/Start-ScheduledTask -TaskName \$Guard/.test(closing)],
    // `win_powershell` runs under --check, and running the guard writes its record.
    ["the closing assertion runs the guard under --check", !/elseif \(-not \$Ansible\.CheckMode\) \{[\s\S]*Start-ScheduledTask -TaskName \$Guard/.test(closing)],
    ["the closing assertion does not require a record newer than the start",
      !/\(\[datetime\]\$r\.checkedAt\)\.ToUniversalTime\(\) -gt \$started\)/.test(closing)],
    ["the closing assertion does not wait for the guard with a bound", !/\$deadline = \(Get-Date\)\.AddSeconds\(120\)/.test(closing)],
    ["the closing assertion does not require the guard's result to be 0",
      !/\(Get-ScheduledTaskInfo -TaskName \$Guard\)\.LastTaskResult/.test(closing) || !/if \(\$result -ne 0\) \{ \$wrong \+= /.test(closing)],
    ["the closing assertion does not require an empty list of what the guard found", !/@\(\$fresh\.reenabled\)\.Count -gt 0/.test(closing)],
    ["the closing assertion does not require an empty list of what the guard could not read", !/@\(\$fresh\.failed\)\.Count -gt 0/.test(closing)],
    ["the closing assertion does not require the registry start type of the updater's services to be 4",
      !/-Name Start -ErrorAction SilentlyContinue\)\.Start/.test(closing) || !/\$start -ne 4/.test(closing)],
    ["the closing assertion accepts a registered updater task, which the freeze unregisters", /scheduled task [^\n]*expected Disabled/.test(closing) || !/is registered \(\$\(\$task\.State\)\), expected none/.test(closing)],
    ["the closing assertion accepts an updater binary under its own name", !/has its own name, expected it renamed/.test(closing)],
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

test("the guard holds: SYSTEM, startup and repeating triggers, prefix match, it only looks, and it writes a record", () => {
  assert.deepEqual(guardViolations(TASKS), [],
    "without a detector nothing says the updater came back between provisions, and the freeze would be a claim nobody checks (A11-205)");
});

test("the guard CHANGES NOTHING: no cmdlet that writes, stops, disables, renames or removes is called, which is the whole of A11-205's change to it", () => {
  const script = guardScript(TASKS);
  assert.doesNotMatch(script, CHANGING_CMDLETS);
  // Control: the very calls the old guard made, put back one at a time, are each caught.
  for (const call of ["Set-ItemProperty -LiteralPath $key -Name Start -Value 4", "Stop-Service -Name $name -Force", "Disable-ScheduledTask -TaskName $t.TaskName",
    "Stop-Process -Id $p.Id -Force", "Stop-ScheduledTask -TaskName $t.TaskName", "Unregister-ScheduledTask -TaskName $t.TaskName", "Rename-Item -LiteralPath $f.FullName"]) {
    const v = guardViolations(mutatedGuard(["$found = @($found | Sort-Object -Unique)", `$found = @($found | Sort-Object -Unique); ${call}`]));
    assert.ok(v.some((message) => message.startsWith("the detector changes something")), `${call} was not noticed: ${v.join("|")}`);
  }
  const moved = guardViolations(mutatedGuard(["$found = @($found | Sort-Object -Unique)", "$found = @($found | Sort-Object -Unique); Move-Item -LiteralPath $f.FullName -Destination x"]));
  assert.ok(moved.includes("a Move-Item is not on the detector's own record"), moved.join("|"));
});

test("control: the daily trigger with a one-day repetition (the shape that went quiet after a registration) FAILS", () => {
  const v = guardViolations(mutatedGuard([
    `- type: time\n            start_boundary: '2026-01-01T00:00:00'\n            repetition:\n              interval: "PT{{ edge_guard_interval_minutes }}M"\n`,
    `- type: daily\n            start_boundary: '2026-01-01T00:00:00'\n            repetition:\n              interval: "PT{{ edge_guard_interval_minutes }}M"\n              duration: P1D\n`]));
  assert.ok(v.includes("the repetition hangs off a daily trigger, which does not repeat after a registration until the next midnight"), v.join("|"));
  assert.ok(v.includes("the repetition ends after a duration"), v.join("|"));
  assert.ok(v.includes("the repetition is not on a time trigger"), v.join("|"));
});

test("control: repetition written as a list FAILS, because win_scheduled_task cannot set it (a11ign#5472)", () => {
  const v = guardViolations(mutatedGuard([
    `repetition:\n              interval: "PT{{ edge_guard_interval_minutes }}M"\n`,
    `repetition:\n              - interval: "PT{{ edge_guard_interval_minutes }}M"\n`]));
  assert.ok(v.includes("repetition is a list, which the module cannot set"), v.join("|"));
});

test("the interval is a variable at the top of the block, not a new defaults key", () => {
  assert.match(TASKS, /edge_guard_interval_minutes: 15\n/);
  assert.doesNotMatch(readFileSync(
    fileURLToPath(new URL("../../ansible/roles/worker/defaults/main.yml", import.meta.url)), "utf8"),
    /edge_guard/);
});

/** One mutation of the script, the message it must draw. */
const SCRIPT_CONTROLS: Array<[string, Array<[string, string]>, string]> = [
  ["prefix replaced by a two-name list", [["Get-ScheduledTask -TaskName 'MicrosoftEdgeUpdate*'", "Get-ScheduledTask -TaskName @('MicrosoftEdgeUpdateTaskMachineCore','MicrosoftEdgeUpdateTaskMachineUA')"]], "tasks are not matched by prefix"],
  ["a registered task that is not a finding", [['$found += "task:$($t.TaskName)"', "$null = $t"]], "any updater task at all is not a finding"],
  ["a service not at Start 4 that is not a finding", [['if ($start -ne 4) { $found += "service:$name" }', "if ($start -ne 4) { }"]], "a service that is not at Start 4 is not a finding"],
  ["a running service that is not a finding", [['$svc.Status -ne \'Stopped\') { $found += "service:$name" }', "$svc.Status -ne 'Stopped') { }"]], "a running service is not a finding"],
  ["a running updater process that is not a finding", [['$found += "process:$($p.ProcessName)"', "$null = $p"]], "a running MicrosoftEdgeUpdate process is not a finding"],
  ["an updater binary under its own name that is not a finding", [['$found += "binary:$($f.FullName)"', "$null = $f"]], "an updater binary under its own name is not a finding"],
  ["a stop of the updater while the role's own MSI is installing", [["if ($installing.Count -eq 0) {", "if ($true) {"]], "do not wait for the role's own Edge install"],
  ["a guard under `$ErrorActionPreference = 'Stop'`", [["$ErrorActionPreference = 'Continue'", "$ErrorActionPreference = 'Stop'"]], "the first failure aborts the run before the record is written"],
  ["a service list read as one object (the 5.1 ConvertFrom-Json shape)", [["$services = [string[]](", "$services = @("]], "the service list is not cast to string[]"],
  ["a record that does not say what could not be read", [["reenabled = @($found); failed = @($failed) }", "reenabled = @($found) }"]], "the record does not say what could not be read"],
  ["a record that cannot be written and ends the task 0", [["} catch { exit 1 }", "} catch { }"]], "a record that cannot be written ends the task zero"],
  ["a guard that exits 0 whatever it found", [["if ($found.Count -gt 0 -or $failed.Count -gt 0) { exit 1 }", "if ($found.Count -gt 0 -or $failed.Count -gt 0) { exit 0 }"]], "does not exit non-zero when something was found"],
  ["a record rewritten fresh every run, with no read of the previous one", [["Get-Content -LiteralPath $record", "Get-Content -LiteralPath $other"]], "the previous record is not read before the new one is written"],
  ["a clean run that does not carry the previous last finding", [["$entry.lastReenabledAt = $previous.lastReenabledAt", "$entry.lastSeen = $previous.lastReenabledAt"]], "does not carry the previous lastReenabledAt and lastReenabled forward"],
  ["a run that found something and does not set its own last finding", [["$entry.lastReenabledAt = $entry.checkedAt", "$entry.lastSeen = $entry.checkedAt"]], "does not set lastReenabledAt and lastReenabled from itself"],
];

test("control: each property of the detector's script removed FAILS", () => {
  for (const [label, edits, expected] of SCRIPT_CONTROLS) {
    assert.match(guardViolations(mutatedGuard(...edits)).join("|"), new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label} was not noticed`);
  }
});

test("the detector never stops a process, so a process that exits between the listing and the read has nothing to race", () => {
  assert.doesNotMatch(guardScript(TASKS), /Stop-Process/);
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

test("the closing assertion starts the guard, waits a bounded time for a newer record, and requires result 0, nothing found and nothing unread", () => {
  const closing = taskBlock(TASKS, CLOSING_ASSERTION);
  assert.match(closing, /Start-ScheduledTask -TaskName \$Guard/);
  assert.match(closing, /\$deadline = \(Get-Date\)\.AddSeconds\(120\)/);
  assert.match(closing, /\(\[datetime\]\$r\.checkedAt\)\.ToUniversalTime\(\) -gt \$started\)/);
  assert.match(closing, /\(Get-ScheduledTaskInfo -TaskName \$Guard\)\.LastTaskResult/);
  assert.match(closing, /if \(\$result -ne 0\) \{ \$wrong \+= "guard task \$Guard ended with result \$result, expected 0" \}/);
  assert.match(closing, /@\(\$fresh\.reenabled\)\.Count -gt 0/);
  assert.match(closing, /@\(\$fresh\.failed\)\.Count -gt 0/);
  assert.match(closing, /\$start -ne 4/);
  assert.match(closing, /scheduled task \$\(\$task\.TaskName\) is registered \(\$\(\$task\.State\)\), expected none/, "the freeze UNREGISTERS the updater's tasks: a disabled one is a fault");
});

test("control: a closing assertion that never starts the guard, ignores its result, or accepts an old record FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["Start-ScheduledTask -TaskName $Guard", "Get-ScheduledTask -TaskName $Guard | Out-Null", "does not start the guard"],
    ["if ($result -ne 0) { $wrong += ", "if ($result -ne 0) { $ignored = ", "does not require the guard's result to be 0"],
    ["-gt $started", "-gt $started.AddYears(-1)", "does not require a record newer than the start"],
    ["@($fresh.failed).Count -gt 0", "@($fresh.failed).Count -gt 99", "does not require an empty list of what the guard could not read"],
    ["@($fresh.reenabled).Count -gt 0", "@($fresh.reenabled).Count -gt 99", "does not require an empty list of what the guard found"],
    ["$start -ne 4", "$start -ne $null", "does not require the registry start type"],
    ["$deadline = (Get-Date).AddSeconds(120)", "$deadline = [datetime]::MaxValue", "does not wait for the guard with a bound"],
    ["elseif (-not $Ansible.CheckMode) {", "else {", "runs the guard under --check"],
    ["is registered ($($task.State)), expected none", "is $($task.State), expected Disabled", "accepts a registered updater task"],
    ["has its own name, expected it renamed", "has its own name", "accepts an updater binary under its own name"],
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

test("the guard is registered after the install block, so it never reports the install's own restored binaries", () => {
  assert.deepEqual(placementViolations(TASKS), []);
  const heads = [...TASKS.matchAll(/^- name: (.+)$/gm)].map((m) => m[1].trim());
  assert.ok(!heads.some((name) => /^Stop and disable EVERY Edge-updater/.test(name)), "the tasks that raced the updater are gone");
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
