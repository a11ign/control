/**
 * THE FREEZE: EVERY LEVER THAT STOPS A BOX UPGRADING ITSELF IS IN `tasks/freeze.yml`, WITH ITS VALUE, AND IS READ BACK (A11-205, docs/adr/0001).
 *
 * `freeze.yml` holds the levers as data (`freeze_registry_values`, `freeze_services`, `freeze_tasks_disabled`, `freeze_tasks_unregistered`) and four
 * scripts that apply them and one that reads every one back from the box. This file holds an INDEPENDENT COPY of what each lever must be, as literals, so a
 * change to a value, or a lever dropped, is what fails here: the role's own read-back only proves the box matches the role, not that the role still
 * asks for the right thing (the shape `update-deferral-policy.test.ts` and `worker-port.test.ts` use).
 *
 * What this cannot show is that a lever HOLDS. A value that reads back is a value that is stored, and the EdgeUpdate policies read back clean on every box
 * while Edge updated itself. That is `ansible/freeze-proof.yml`'s job, on one box, and its output is in the pull request.
 *
 * The YAML is parsed by PyYAML in a subprocess because this package takes no npm dependency (ADR 0012), as `patch-playbook.test.ts` does.
 *
 * EACH CONTROL runs the same predicate on the real file with ONE lever mutated, so the check is shown to fail on the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const FREEZE_PATH = path("../../ansible/roles/worker/tasks/freeze.yml");
const DEFAULTS = readFileSync(path("../../ansible/roles/worker/defaults/main.yml"), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Yaml = any;
type Lever = { path: string; name: string; value?: string | number; type?: string; lift?: string; soft?: boolean; state?: string };
type Service = { name: string; lift_start?: number };
type TaskSpec = { path: string; name: string };
type Freeze = { vars: { registry: Lever[]; services: Service[]; disabled: TaskSpec[]; unregistered: TaskSpec[]; raw: Record<string, Yaml> }; tasks: Yaml[]; text: string };

function parseFreeze(): Freeze {
  const parsed = JSON.parse(execFileSync("python3", ["-I", "-c",
    "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", FREEZE_PATH], { encoding: "utf8" }));
  assert.equal(parsed.length, 1, "freeze.yml is one block task");
  const raw = parsed[0].vars as Record<string, Yaml>;
  return {
    vars: { registry: raw.freeze_registry_values, services: raw.freeze_services, disabled: raw.freeze_tasks_disabled,
      unregistered: raw.freeze_tasks_unregistered, raw },
    tasks: parsed[0].block,
    text: readFileSync(FREEZE_PATH, "utf8"),
  };
}
const FREEZE = parseFreeze();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// ---- the independent copy: what every lever must be --------------------------------------------------------------------------------------------------

const WU = "{{ freeze_wu_policy }}";
const AU = `${WU}\\AU`;
const DEFENDER = "{{ freeze_defender_policy }}";
/** Name -> [key, value, type, dropped by the upgrade's lift]. The ticket's list, lever for lever. */
const REGISTRY: Record<string, [string, string | number, string, boolean]> = {
  NoAutoUpdate: [AU, 1, "dword", true],
  UseWUServer: [AU, 1, "dword", true],
  WUServer: [WU, "{{ freeze_unreachable_server }}", "string", true],
  WUStatusServer: [WU, "{{ freeze_unreachable_server }}", "string", true],
  DoNotConnectToWindowsUpdateInternetLocations: [WU, 1, "dword", true],
  TargetReleaseVersion: [WU, 1, "dword", false],
  TargetReleaseVersionInfo: [WU, "{{ worker_fleet_pins.windows.release }}", "string", false],
  ProductVersion: [WU, "Windows 11", "string", false],
  ExcludeWUDriversInQualityUpdate: [WU, 1, "dword", false],
  SearchOrderConfig: ["HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DriverSearching", 0, "dword", false],
  AutoDownload: ["HKLM:\\SOFTWARE\\Policies\\Microsoft\\WindowsStore", 2, "dword", false],
};
const DEFENDER_LEVERS: Record<string, string | number> = {
  FallbackOrder: "FileShares", DefinitionUpdateFileSharesSources: "", SignatureUpdateInterval: 0, UpdateOnStartUp: 0, ForceUpdateFromMU: 0,
};
const DEFERRALS = ["DeferFeatureUpdates", "DeferFeatureUpdatesPeriodInDays", "DeferQualityUpdates", "DeferQualityUpdatesPeriodInDays"];
/** Service -> the start type the upgrade's lift gives it, or null when it is never lifted. The Edge updater's two come from the role's list. */
const SERVICES: Record<string, number | null> = { wuauserv: 3, UsoSvc: 3, WaaSMedicSvc: null, InstallService: null };
const EDGE_SERVICES = ["edgeupdate", "edgeupdatem"];
const DISABLED_TASKS: Array<[string, string]> = [
  ["\\Microsoft\\Windows\\UpdateOrchestrator\\*", "*"],
  ["\\Microsoft\\Windows\\WindowsUpdate\\*", "*"],
  ["\\Microsoft\\Windows\\WaaSMedic\\*", "*"],
  ["\\Microsoft\\Windows\\InstallService\\*", "*"],
  ["\\Microsoft\\Windows\\UNP\\*", "*"],
  ["\\Microsoft\\Windows\\Flighting\\*", "*"],
  ["\\Microsoft\\Windows\\Speech\\", "SpeechModelDownloadTask"],
  ["\\Microsoft\\Windows\\Maps\\", "MapsUpdateTask"],
  ["\\Microsoft\\Windows\\Application Experience\\", "PcaPatchDbTask"],
  ["\\Microsoft\\Windows\\Device Setup\\", "Metadata Refresh"],
  ["\\Microsoft\\Windows\\PI\\", "Secure-Boot-Update"],
  ["\\Microsoft\\Windows\\PCRPF\\", "PCR Prediction Framework Firmware Update Task"],
  ["\\Microsoft\\Windows\\DirectX\\", "DirectXDatabaseUpdater"],
  ["\\Microsoft\\Windows\\WindowsAI\\ClickToDo\\", "ModelCachingUpdate"],
];
const UNREGISTERED_TASKS: Array<[string, string]> = [["\\", "MicrosoftEdgeUpdate*"], ["\\", "OneDrive Startup Task-*"]];

// ---- the predicate ---------------------------------------------------------------------------------------------------------------------------------

const byName = <T extends { name: string }>(list: T[]): Map<string, T> => new Map(list.map((item) => [item.name, item]));

/** What is wrong with the registry levers the ticket lists: each present, under its key, with its value and type, and dropped by the lift or not. */
function registryViolations(registry: Map<string, Lever>): string[] {
  return Object.entries(REGISTRY).flatMap(([name, [key, value, type, lifted]]) => {
    const have = registry.get(name);
    if (!have) return [`registry lever ${name} is missing`];
    return [
      have.path !== key ? `${name} is under '${have.path}', wanted '${key}'` : "",
      have.value !== value ? `${name} is '${have.value}', wanted '${value}'` : "",
      have.type !== type ? `${name} is a ${have.type}, wanted a ${type}` : "",
      (have.lift === "absent") !== lifted ? `${name} ${lifted ? "is not dropped by" : "is dropped by"} the upgrade's lift` : "",
      have.state === "absent" ? `${name} is deleted instead of set` : "",
    ].filter(Boolean);
  });
}

/** Defender's signature levers are soft (reported, not fought) and the deferral values are deleted from the box. */
function defenderAndDeferralViolations(registry: Map<string, Lever>): string[] {
  const defender = Object.entries(DEFENDER_LEVERS).flatMap(([name, value]) => {
    const have = registry.get(name);
    if (!have) return [`Defender lever ${name} is missing`];
    return [
      have.path !== DEFENDER || have.value !== value ? `${name} is '${have.value}' under '${have.path}', wanted '${value}' under the signature-updates key` : "",
      have.soft !== true ? `${name} is not soft: Tamper Protection may revert it, and that is reported, not fought` : "",
    ].filter(Boolean);
  });
  const deferrals = DEFERRALS.filter((name) => registry.get(name)?.state !== "absent").map((name) => `${name} is not deleted from the box`);
  return [...defender, ...deferrals];
}

/** Each service present, with the start type the upgrade's lift gives it (or none). */
function serviceViolations(services: Map<string, Service>): string[] {
  return Object.entries(SERVICES).flatMap(([name, lift]) => {
    const have = services.get(name);
    if (!have) return [`service ${name} is missing`];
    return (have.lift_start ?? null) !== lift ? [`service ${name} lift_start is ${have.lift_start ?? "none"}, wanted ${lift ?? "none"}`] : [];
  });
}

/** Each task disabled or unregistered as wanted, and none both: the Edge updater re-registers a task that is only disabled. */
function taskViolations(freeze: Freeze): string[] {
  const keys = (list: TaskSpec[]) => list.map((spec) => `${spec.path}|${spec.name}`);
  const disabled = keys(freeze.vars.disabled);
  const unregistered = keys(freeze.vars.unregistered);
  return [
    ...DISABLED_TASKS.filter(([taskPath, name]) => !disabled.includes(`${taskPath}|${name}`)).map(([taskPath, name]) => `task ${taskPath}${name} is not disabled`),
    ...UNREGISTERED_TASKS.filter(([taskPath, name]) => !unregistered.includes(`${taskPath}|${name}`)).map(([taskPath, name]) => `task ${taskPath}${name} is not unregistered`),
    ...unregistered.filter((key) => disabled.includes(key)).map((key) => `${key.split("|")[1]} is both disabled and unregistered`),
  ];
}

/** What is wrong with the freeze, as a list. Empty means every lever is there with its value and is read back from the same data. */
function leverViolations(freeze: Freeze): string[] {
  const registry = byName(freeze.vars.registry);
  return [...registryViolations(registry), ...defenderAndDeferralViolations(registry), ...serviceViolations(byName(freeze.vars.services)), ...taskViolations(freeze)];
}

const freezeLifted = (): Lever[] => FREEZE.vars.registry.filter((lever) => lever.lift === "absent");

test("every lever the ticket lists is in the freeze with its value, and the upgrade's lift drops exactly the five that stop Windows Update being asked", () => {
  assert.deepEqual(leverViolations(FREEZE), []);
  assert.equal(freezeLifted().length, Object.values(REGISTRY).filter(([, , , lifted]) => lifted).length, "positive control: five levers are dropped by the lift");
});

test("control: each registry lever removed, or given another value, FAILS", () => {
  for (const name of [...Object.keys(REGISTRY), ...Object.keys(DEFENDER_LEVERS), ...DEFERRALS]) {
    const removed = clone(FREEZE);
    removed.vars.registry = removed.vars.registry.filter((lever) => lever.name !== name);
    assert.notDeepEqual(removed.vars.registry, FREEZE.vars.registry, `${name} was not in the data, so removing it controls nothing`);
    assert.match(leverViolations(removed).join("|"), new RegExp(`${name} (is|lever)`), `${name} removed was not noticed`);
  }
  for (const name of Object.keys(REGISTRY)) {
    const changed = clone(FREEZE);
    const lever = changed.vars.registry.find((candidate) => candidate.name === name) as Lever;
    lever.value = lever.type === "dword" ? Number(lever.value) + 1 : "other";
    assert.match(leverViolations(changed).join("|"), new RegExp(`${name} is '`), `${name} changed was not noticed`);
  }
});

test("control: a service, a disabled task or an unregistered task removed FAILS", () => {
  for (const name of Object.keys(SERVICES)) {
    const removed = clone(FREEZE);
    removed.vars.services = removed.vars.services.filter((service) => service.name !== name);
    assert.match(leverViolations(removed).join("|"), new RegExp(`service ${name} is missing`));
  }
  const lifted = clone(FREEZE);
  (lifted.vars.services.find((service) => service.name === "WaaSMedicSvc") as Service).lift_start = 3;
  assert.match(leverViolations(lifted).join("|"), /WaaSMedicSvc lift_start is 3/, "Medic is never given back to the box");
  for (const [taskPath, name] of DISABLED_TASKS) {
    const removed = clone(FREEZE);
    removed.vars.disabled = removed.vars.disabled.filter((spec) => !(spec.path === taskPath && spec.name === name));
    assert.match(leverViolations(removed).join("|"), /is not disabled/, `${name} removed was not noticed`);
  }
  for (const [taskPath, name] of UNREGISTERED_TASKS) {
    const removed = clone(FREEZE);
    removed.vars.unregistered = removed.vars.unregistered.filter((spec) => !(spec.path === taskPath && spec.name === name));
    assert.match(leverViolations(removed).join("|"), /is not unregistered/, `${name} removed was not noticed`);
  }
  const both = clone(FREEZE);
  both.vars.disabled.push({ path: "\\", name: "MicrosoftEdgeUpdate*" });
  assert.match(leverViolations(both).join("|"), /both disabled and unregistered/, "the Edge updater re-registers a task that is only disabled");
});

test("the Edge updater's two services come from the role's list, and the role declares them", () => {
  assert.match(DEFAULTS, /^worker_edge_updater_services:\n {2}- edgeupdate\n {2}- edgeupdatem$/m);
  for (const name of EDGE_SERVICES) assert.ok(DEFAULTS.includes(`  - ${name}\n`), name);
  const scripts = FREEZE.tasks.filter((task) => /EdgeServices/.test(JSON.stringify(task)));
  assert.equal(scripts.length, 2, "both the apply and the read-back handle them");
  for (const task of scripts) assert.equal(task["ansible.windows.win_powershell"].parameters.EdgeServices, "{{ worker_edge_updater_services }}");
});

// ---- the read-back, and the single source -------------------------------------------------------------------------------------------------------

const taskNamed = (prefix: string): Yaml => {
  const found = FREEZE.tasks.find((task) => typeof task.name === "string" && task.name.startsWith(prefix));
  assert.ok(found, `freeze.yml has no task starting "${prefix}"`);
  return found;
};
const parametersOf = (task: Yaml): Record<string, string> => task["ansible.windows.win_powershell"].parameters;
const scriptOf = (task: Yaml): string => String(task["ansible.windows.win_powershell"].script);

const APPLY_TASKS: Array<[string, string, string]> = [
  ["Windows Update, the Store", "Values", "{{ freeze_registry_values }}"],
  ["Services are frozen", "Services", "{{ freeze_services }}"],
  ["Scheduled tasks are frozen", "Disabled", "{{ freeze_tasks_disabled }}"],
  ["Scheduled tasks are frozen", "Unregistered", "{{ freeze_tasks_unregistered }}"],
  ["Refuse to call this box frozen", "Values", "{{ freeze_registry_values }}"],
  ["Refuse to call this box frozen", "Services", "{{ freeze_services }}"],
  ["Refuse to call this box frozen", "Disabled", "{{ freeze_tasks_disabled }}"],
  ["Refuse to call this box frozen", "Unregistered", "{{ freeze_tasks_unregistered }}"],
];

test("the apply scripts and the read-back take the SAME data, so a lever added to one cannot be missed by the other", () => {
  for (const [task, parameter, expression] of APPLY_TASKS) {
    assert.equal(parametersOf(taskNamed(task))[parameter], expression, `${task} / ${parameter}`);
  }
});

test("the read-back refuses the box by name when a lever did not hold, and reads absent as wrong", () => {
  const script = scriptOf(taskNamed("Refuse to call this box frozen"));
  assert.match(script, /\$Ansible\.Failed = \$true; "freeze did not hold: "/, "a lever that did not hold fails the task");
  assert.match(script, /\$null -eq \$cur -or "\$cur" -ne "\$\(\$v\.value\)"/, "an absent value is not a value that is right");
  assert.match(script, /\$bad = if \(\$remove\) \{ \$null -ne \$cur \}/, "a value that should be deleted but is there is wrong");
  assert.match(script, /if \(\$v\.soft\) \{ \$soft \+= \$line \} else \{ \$wrong \+= \$line \}/, "only Defender's soft values are reported instead of failing");
  assert.match(script, /service \$\(\$s\.name\) is \$\(\$svc\.Status\), wanted Stopped/, "a frozen service must also be stopped");
  assert.match(script, /"\$\(\$svc\.StartType\)" -ne \$mode\[\$want\]\) \{ \$wrong \+= "service \$\(\$s\.name\) is \$\(\$svc\.StartType\) in the service manager/,
    "the service manager's own copy of the start type is read, because a registry value it has not read yet does not stop Start-Service");
  assert.match(script, /still exists, wanted it unregistered/);
  assert.match(script, /updater binary \$\(\$f\.FullName\) has its own name/);
  assert.match(script, /return "no enabled outbound block rule for \$path"/);
  assert.equal(taskNamed("Refuse to call this box frozen").when, "not ansible_check_mode", "under --check nothing was written, so nothing is read back");
});

test("the lift is read back as the LIFTED state, and a lever the lift drops is expected absent only while lifted", () => {
  const script = scriptOf(taskNamed("Refuse to call this box frozen"));
  assert.match(script, /\$remove = \(\$v\.state -eq 'absent'\) -or \(\$Lift -and \$v\.lift -eq 'absent'\)/);
  assert.match(script, /\$lifting = \$Lift -and \(\$null -ne \$s\.lift_start\)/);
  const apply = scriptOf(taskNamed("Windows Update, the Store"));
  assert.match(apply, /\$remove = \(\$v\.state -eq 'absent'\) -or \(\$Lift -and \$v\.lift -eq 'absent'\)/, "the writer and the reader decide 'removed' the same way");
  assert.equal(parametersOf(taskNamed("Windows Update, the Store")).Lift, "{{ freeze_lift_windows }}");
  assert.equal(FREEZE.vars.raw.freeze_lift_windows, "{{ worker_freeze_lift_windows | default(false) | bool }}", "off unless a caller lifts");
});

test("the service manager is told EVERY run, not only when what it reports already differs: its own copy of the start type is what is enforced (measured live)", () => {
  const apply = scriptOf(taskNamed("Services are frozen"));
  const gate = apply.indexOf("if ($differs)");
  const call = apply.indexOf("try { Set-Service -Name $s.name -StartupType $mode[$want] -ErrorAction Stop }");
  assert.ok(call >= 0 && gate >= 0, "both the unconditional call and the record of a change are there");
  assert.ok(call < gate, "the call comes before, and is not inside, the `if ($differs)` that only decides whether it is recorded");
  assert.doesNotMatch(apply.slice(0, call).split("\n").slice(-6).join("\n"), /if \(\$cur -ne \$want/, "the call is not guarded by the mismatch it would otherwise skip on");
});

test("Medic is handled: its service and tasks are frozen, and what SYSTEM is refused is done as TrustedInstaller through a task that is removed again", () => {
  const medic = taskNamed("What SYSTEM was refused");
  const script = scriptOf(medic);
  assert.match(script, /NT SERVICE\\TrustedInstaller/);
  assert.match(script, /Unregister-ScheduledTask -TaskName \$name/, "the one-shot task does not outlive its run");
  assert.match(script, /\} finally \{\s*Unregister-ScheduledTask/, "and is removed even when the run fails");
  assert.match(JSON.stringify(medic.when), /refused/, "it runs only when something was refused");
  const apply = scriptOf(taskNamed("Services are frozen"));
  assert.match(apply, /\$refused \+= "Set-Service -Name '\$\(\$s\.name\)' -StartupType \$\(\$mode\[\$want\]\)[^"]*Set-ItemProperty -LiteralPath '\$key' -Name Start -Value \$want -Type DWord"/, "a refused start type is handed on, not lost");
  assert.match(apply, /Set-Service -Name \$s\.name -StartupType \$mode\[\$want\] -ErrorAction Stop[\s\S]*Set-ItemProperty -LiteralPath \$key/, "the service manager is asked first, the registry second");
  assert.match(apply, /\$refused \+= "Stop-Service -Name '\$\(\$s\.name\)' -Force/, "a stop SYSTEM is refused is handed on too, or Medic's service could never read Stopped");
  const tasks = scriptOf(taskNamed("Scheduled tasks are frozen"));
  assert.match(tasks, /\$refused \+= "Disable-ScheduledTask /, "a refused task is handed on, not lost");
});

test("a box whose connection dropped mid-freeze is not marked frozen: the fact that says so is set only when no step was unreachable", () => {
  const remember = taskNamed("Remember what this run had to put back");
  assert.deepEqual([...remember.when].sort(), ["freeze_edge_levers", "freeze_firewall_levers", "freeze_proof", "freeze_registry", "freeze_service_levers", "freeze_task_levers"]
    .map((name) => `${name} is not unreachable`).sort(),
  "the daily play runs with ignore_unreachable, which lets an unreachable task fall through: each registered result is asked");
});

test("what only TrustedInstaller could change is recorded as put back, so Medic re-arming a lever is named by the daily run", () => {
  const remember = taskNamed("Remember what this run had to put back");
  const facts = JSON.stringify(remember["ansible.builtin.set_fact"]);
  for (const source of ["freeze_registry.result.changed_levers", "freeze_service_levers.output", "freeze_task_levers.output", "freeze_edge_levers.output", "freeze_firewall_levers.output",
    "freeze_service_levers.result.refused", "freeze_task_levers.result.refused"]) {
    assert.ok(facts.includes(source), `${source} is not in what the box reports as put back`);
  }
  assert.match(facts, /as TrustedInstaller: /);
  assert.equal(remember["ansible.builtin.set_fact"].worker_freeze_done, true, "set LAST, after the read-back: a box that failed part way has neither fact");
  const names = FREEZE.tasks.map((task) => String(task.name));
  assert.ok(names.indexOf(remember.name) > names.findIndex((name) => name.startsWith("Refuse to call this box frozen")), "after the read-back");
});

// ---- the Edge updater, the Store, and the image ------------------------------------------------------------------------------------------------

test("the Edge updater is frozen five ways: services, unregistered tasks, stopped processes, renamed binaries, and a block rule for each binary", () => {
  const edge = scriptOf(taskNamed("The Edge updater is frozen"));
  assert.match(edge, /Get-Process -Name 'MicrosoftEdgeUpdate\*', 'MicrosoftEdge_X64_\*'/, "by prefix: the updater and the installer it stages");
  assert.match(edge, /Where-Object \{ \$_\.Name -like 'MicrosoftEdgeUpdate\*\.exe' \}/, "every image under the folder, not the root one alone");
  assert.match(edge, /Get-ChildItem -LiteralPath \$Dir -Recurse -File/, "recursive: the versioned folders hold copies");
  assert.match(edge, /Move-Item -LiteralPath \$f\.FullName -Destination "\$\(\$f\.FullName\)\$Suffix" -Force/);
  assert.match(edge, /MicrosoftEdgeEnterprise/, "not while the role's own MSI is installing");
  assert.equal(FREEZE.vars.raw.freeze_frozen_suffix, ".a11y-frozen");
  assert.equal(FREEZE.vars.raw.freeze_edge_updater_dir, "{{ worker_edge_updater_exe | win_dirname }}");
  const unregistered = scriptOf(taskNamed("Scheduled tasks are frozen"));
  assert.match(unregistered, /Unregister-ScheduledTask -TaskName \$t\.TaskName -TaskPath \$t\.TaskPath -Confirm:\$false -ErrorAction Stop/, "unregistered, not disabled");
});

test("the Store, Defender and the other self-updaters are all in the freeze, and the Store is held two ways", () => {
  assert.ok(FREEZE.vars.registry.some((lever) => lever.name === "AutoDownload" && lever.value === 2), "Store AutoDownload=2");
  assert.ok(FREEZE.vars.services.some((service) => service.name === "InstallService"), "the Store's install service is disabled too: Pro may not honour the policy alone");
  assert.ok(FREEZE.vars.disabled.some((spec) => spec.path === "\\Microsoft\\Windows\\InstallService\\*" && spec.name === "*"),
    "the Store's scan tasks (ScanForUpdates, ScanForUpdatesAsUser, SmartRetry) are disabled as the whole InstallService folder");
});

// ---- the single source ---------------------------------------------------------------------------------------------------------------------------

test("no lever's name or value is in defaults/main.yml: the freeze does not move provisionRevision", () => {
  const code = DEFAULTS.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  const names = [...Object.keys(REGISTRY), ...Object.keys(DEFENDER_LEVERS), ...DEFERRALS].filter((name) => name !== "FallbackOrder");
  for (const name of names) assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `${name} is in defaults/main.yml, which the stamp hashes`);
  for (const [, [, value]] of Object.entries(REGISTRY)) {
    if (typeof value === "string" && value.startsWith("http")) assert.doesNotMatch(code, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  // Control: the check would see a lever put in the defaults.
  assert.match(DEFAULTS + "\nworker_x:\n  - name: NoAutoUpdate\n", /\bNoAutoUpdate\b/);
});

test("the release the target-release lever holds comes from the manifest, and is written nowhere in the role", () => {
  const info = FREEZE.vars.registry.find((lever) => lever.name === "TargetReleaseVersionInfo");
  assert.equal(info?.value, "{{ worker_fleet_pins.windows.release }}");
  const manifest = JSON.parse(readFileSync(path("../../deploy-pins.json"), "utf8")) as { windows: { release: string } };
  assert.match(manifest.windows.release, /^[0-9]{2}H[12]$/);
  assert.ok(!FREEZE.text.includes(manifest.windows.release), "the release is not restated in freeze.yml");
});

test("the freeze installs nothing: no install module is reachable from it", () => {
  const code = FREEZE.text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /win_updates|win_package|win_get_url|win_chocolatey|a11y_nvda\b|msiexec\s+\/|Install-Package|Install-Module|Start-BitsTransfer|Invoke-WebRequest/);
  assert.match(code, /become: true/);
});
