/**
 * NOTHING THAT RUNS ON A CLOCK INSTALLS ANYTHING (A11-205, docs/adr/0001).
 *
 * The decision: nothing on a fleet box upgrades by itself; a person edits `deploy-pins.json` and runs `fleet:patch -- --apply`. The 28-day patch window
 * was a timer that ran an installing play, so the check that replaces it is not "the timer is gone" but "no unit control ships can start an installing play".
 *
 * THREE READINGS, each over every file that could hold the answer:
 *
 *   1. EVERY SYSTEMD UNIT control ships (`ansible/files/*.service`, and any `[Service]` text inside a playbook such as the old `patch-schedule.yml`) runs commands
 *      from an ALLOWLIST of read-only or freeze-only ones, each with the reason it is safe. A command the list does not name FAILS, so the next timer someone adds is
 *      classified by an argument, not by luck. The old patch window's `ExecStart` is a fixture below and is refused.
 *   2. NO FILE THAT THE FREEZE RUNS reaches an install module: `freeze.yml` (the play and the role's task file) and `freeze-proof.yml`.
 *   3. NO SCHEDULED TASK ON A BOX runs an installer or an updater.
 *
 * The allowlist is a list of what each unit IS, restated here as literals: the file itself cannot be trusted to say it is safe. EACH CONTROL runs the same
 * predicate on a mutation, so it is shown to fail on the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deriveShippedUnits } from "../control-unit-drift.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ANSIBLE = `${ROOT}ansible/`;
const read = (relative: string) => readFileSync(`${ROOT}${relative}`, "utf8");

/** A command a unit may run, and WHY it installs nothing. A reason, never a bare pattern. */
const ALLOWED: Array<{ command: RegExp; why: string }> = [
  { command: /^\/usr\/bin\/env ansible-playbook freeze\.yml$/,
    why: "The daily freeze: the role's freeze.yml only, which sets policy values, disables services and tasks, and renames and firewalls the Edge updater. No install module is reachable from it (reading 2)." },
  { command: /^\/usr\/bin\/node --import \/opt\/a11y-tsx\/node_modules\/tsx\/dist\/esm\/index\.mjs \/root\/control\/src\/fleet-drift\.ts --record$/,
    why: "The hourly drift check: it asks each box's /health what it runs, compares that with deploy-pins.json and writes runs/fleet-drift.json. It reads; `fleet-drift.ts` starts no process and runs no play (the test below reads it)." },
  { command: /^\/usr\/bin\/node --import \/opt\/a11y-tsx\/node_modules\/tsx\/dist\/esm\/index\.mjs \/root\/control\/src\/fleet-auto-off\.ts --apply$/,
    why: "Powers an idle worker off through sleep.yml. A shutdown, never an install." },
  { command: /^\/usr\/bin\/node --import \/opt\/a11y-tsx\/node_modules\/tsx\/dist\/esm\/index\.mjs \/root\/control\/src\/gate-heartbeat\.ts$/,
    why: "Posts the gate's heartbeat. Read-only on the fleet." },
  { command: /^\/usr\/bin\/systemd-run --unit=a11y-job-corpus-snapshot /,
    why: "Dispatches the corpus snapshot as a lab job on the lab host. It touches no fleet box." },
];

/** The commands a unit's follow-main and skip-condition steps may run: they read systemd and move control's own checkout, and install nothing on a box. */
const ALLOWED_GUARDS: Array<{ command: RegExp; why: string }> = [
  { command: /^-?\/usr\/bin\/systemctl (reset-failed|stop) a11y-job-corpus-snapshot$/, why: "Clears the corpus snapshot's own lab job before it is dispatched again." },
  { command: /^-?\/bin\/sh -c '(playing=\$\$\(systemctl list-units |\{ find \.git\/FETCH_HEAD|git fetch --quiet origin \+refs\/heads\/main:refs\/remotes\/origin\/main)/,
    why: "Follows main with git fetch and merge --ff-only, after asking systemd whether a play is running. It moves control's checkout, never a box." },
];

type Exec = { key: string; command: string };

/** Every `Exec*=` line of a unit's text, with its `\` continuations joined. */
function execsOf(unit: string): Exec[] {
  const joined = unit.replace(/\s*\\\n\s*/g, " ");
  return [...joined.matchAll(/^\s*(Exec[A-Za-z]*)=(.*)$/gm)].map((m) => ({ key: m[1], command: m[2].trim() }));
}

/** Why a command is not allowed, or null when the allowlist names it. `ExecStart` must be a main command; the others may also be guards. */
function refusal({ key, command }: Exec): string | null {
  const lists = key === "ExecStart" ? [ALLOWED] : [ALLOWED, ALLOWED_GUARDS];
  return lists.some((list) => list.some((entry) => entry.command.test(command))) ? null : `${key}=${command.slice(0, 160)}`;
}

/** The text of every unit control ships: the files, and any `[Service]` text a playbook writes. */
function shippedUnits(): Array<{ source: string; text: string }> {
  const files = readdirSync(`${ANSIBLE}files`).filter((name) => name.endsWith(".service"))
    .map((name) => ({ source: `ansible/files/${name}`, text: read(`ansible/files/${name}`) }));
  const embedded = readdirSync(ANSIBLE).filter((name) => name.endsWith(".yml") && existsSync(`${ANSIBLE}${name}`))
    .map((name) => ({ source: `ansible/${name}`, text: read(`ansible/${name}`) }))
    .filter(({ text }) => /^\s*\[Service\]\s*$/m.test(text));
  return [...files, ...embedded];
}

const unitViolations = (units: Array<{ source: string; text: string }>): string[] =>
  units.flatMap(({ source, text }) => execsOf(text).map(refusal).filter((r): r is string => r !== null).map((r) => `${source}: ${r}`));

/** The old patch window's service, as it stood at `origin/main` before A11-205: the thing this whole test exists to refuse. */
const OLD_PATCH_WINDOW_UNIT = `[Service]
Type=oneshot
ExecStart=/usr/bin/node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs /root/control/src/fleet-playbook.ts --playbook=patch.yml --apply --scheduled --window-days=28 --retry-days=7 --weekday=6 --window-start-hour=2 --window-end-hour=6
`;

test("every unit control ships runs only commands on the read-only or freeze-only allowlist", () => {
  const units = shippedUnits();
  assert.ok(units.length >= 4, `positive control: found ${units.length} units, so the reading is not of nothing`);
  assert.deepEqual(unitViolations(units), [], "a unit control ships starts a command that is not on the allowlist");
  for (const unit of ["a11y-fleet-freeze-daily", "a11y-fleet-drift"]) {
    assert.ok(units.some(({ source }) => source === `ansible/files/${unit}.service`), `${unit} is among them`);
  }
});

test("control: the old patch window's service, and any unit that starts an installing play, is REFUSED", () => {
  assert.deepEqual(unitViolations([{ source: "patch-schedule.yml (before A11-205)", text: OLD_PATCH_WINDOW_UNIT }]).length, 1);
  for (const command of [
    "/usr/bin/env ansible-playbook patch.yml",
    "/usr/bin/env ansible-playbook provision-role.yml",
    "/usr/bin/env ansible-playbook deploy.yml",
    "/usr/bin/env ansible-playbook freeze.yml patch.yml",
    "/usr/bin/env ansible-playbook freeze-proof.yml",
    "/usr/bin/node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs /root/control/src/fleet-playbook.ts --playbook=freeze.yml",
    "/usr/bin/node --import /opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs /root/control/src/fleet-playbook.ts --playbook=patch.yml --apply",
    "/usr/bin/pnpm run fleet:patch -- --apply",
  ]) {
    assert.equal(unitViolations([{ source: "x", text: `[Service]\nExecStart=${command}\n` }]).length, 1, command);
  }
  // A guard step may not be an install either, and ExecStartPre does not widen what ExecStart may be.
  assert.equal(unitViolations([{ source: "x", text: "[Service]\nExecStartPre=/usr/bin/env ansible-playbook patch.yml\nExecStart=/usr/bin/env ansible-playbook freeze.yml\n" }]).length, 1);
  assert.equal(unitViolations([{ source: "x", text: "[Service]\nExecStart=/bin/sh -c 'playing=$$(systemctl list-units --no-legend)'\n" }]).length, 1, "a guard command is not a main command");
});

test("control: the units that ship are each read, including a continuation line, so a command hidden after a backslash is seen", () => {
  const hidden = "[Service]\nExecStart=/usr/bin/env ansible-playbook freeze.yml \\\n  patch.yml\n";
  assert.equal(unitViolations([{ source: "x", text: hidden }]).length, 1);
  assert.equal(execsOf(hidden)[0].command, "/usr/bin/env ansible-playbook freeze.yml patch.yml");
});

test("the patch window is gone: no unit, playbook or package script installs or starts it", () => {
  assert.equal(existsSync(`${ANSIBLE}patch-schedule.yml`), false, "patch-schedule.yml is deleted");
  for (const unit of ["a11y-fleet-patch-window.service", "a11y-fleet-patch-window.timer"]) {
    assert.equal(existsSync(`${ANSIBLE}files/${unit}`), false, unit);
  }
  const freezeSchedule = read("ansible/freeze-schedule.yml");
  assert.match(freezeSchedule, /removed_patch_window_units:\n\s+- a11y-fleet-patch-window\.timer\n\s+- a11y-fleet-patch-window\.service/, "the schedule removes the old pair from the control plane");
  assert.match(freezeSchedule, /state: absent/, "and deletes their files");
  assert.match(freezeSchedule, /patch_window_files\.stdout \| trim \| length == 0/, "and reads the removal back");
  // The package scripts are pinned in `scripts/control-commands.test.ts`: the package.json this test sees laid inside the core carries no `scripts`.
});

test("the hourly drift check READS: its program starts no process and runs no play, and its unit is the only thing that schedules it", () => {
  const program = read("src/fleet-drift.ts").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(program, /child_process|spawn|execFile|ansible|systemctl|\bssh\b/, "fleet-drift.ts must not run anything");
  const unit = read("ansible/files/a11y-fleet-drift.service");
  assert.match(unit, /^ExecStart=.*\/root\/control\/src\/fleet-drift\.ts --record$/m);
  assert.match(read("ansible/files/a11y-fleet-drift.timer"), /^OnCalendar=\*-\*-\* \*:\d\d:00$/m, "hourly");
  // negative control: the predicate sees a program that does run something
  assert.match("import { spawnSync } from 'node:child_process';", /child_process|spawn/);
});

test("control-unit-drift derives the freeze and drift pairs as shipped, and the patch window's names as NOT shipped", () => {
  const playbooks = readdirSync(ANSIBLE).filter((name) => name.endsWith(".yml")).map((name) => read(`ansible/${name}`));
  const derived = deriveShippedUnits({ playbooks: () => playbooks });
  assert.ok("units" in derived, JSON.stringify(derived));
  for (const unit of ["a11y-fleet-freeze-daily.timer", "a11y-fleet-freeze-daily.service", "a11y-fleet-drift.timer", "a11y-fleet-drift.service"]) {
    assert.ok(derived.units.includes(unit), `${unit} is derived as shipped`);
  }
  // Listed beside the units a play installs, a removed unit is derived as shipped, its repository copy is gone, and the whole control-plane reading is CANNOT_TELL.
  assert.deepEqual(derived.units.filter((unit) => unit.startsWith("a11y-fleet-patch-window")), []);
  const together = deriveShippedUnits({ playbooks: () => [`- name: x\n  hosts: a11y_control\n  tasks:\n    - ansible.builtin.copy:\n        src: "files/{{ item }}"\n        dest: "/etc/systemd/system/{{ item }}"\n      loop:\n        - a11y-fleet-patch-window.timer\n`] });
  assert.ok("units" in together && together.units.includes("a11y-fleet-patch-window.timer"), "negative control: in the same play the name IS derived as shipped");
  // and every derived unit has the repository copy `shippedText` will read
  for (const unit of derived.units) assert.ok(existsSync(`${ANSIBLE}files/${unit}`), `${unit} has a file under ansible/files`);
});

// ---- reading 2: the freeze reaches no install module ---------------------------------------------------------------------------------------------

const INSTALLERS = /\b(win_updates|win_package|win_get_url|win_chocolatey|win_hotfix|win_feature|win_dsc|a11y_nvda(?!_updates)|msiexec(\.exe)?["']?\s+\/[a-z]|choco(latey)?\b|winget|Install-WindowsUpdate|Install-Package|Install-Module|Start-BitsTransfer|Invoke-WebRequest|wuauclt|UsoClient[^\n]*Start(Download|Install))\b/;
const code = (text: string) => text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

const FREEZE_FILES = ["ansible/freeze.yml", "ansible/freeze-proof.yml", "ansible/roles/worker/tasks/freeze.yml"];

test("freeze.yml, freeze-proof.yml and the role's freeze task file use no install module", () => {
  for (const file of FREEZE_FILES) {
    assert.doesNotMatch(code(read(file)), INSTALLERS, `${file} reaches an install module`);
  }
  // The proof does start `UsoClient StartScan`, which asks and installs nothing: StartDownload and StartInstall would act on what is staged.
  assert.match(code(read("ansible/freeze-proof.yml")), /ArgumentList 'StartScan'/);
});

test("control: each install module, put into the freeze, is seen", () => {
  for (const module of ["ansible.windows.win_updates:", "ansible.windows.win_package:", "ansible.windows.win_get_url:", "chocolatey.chocolatey.win_chocolatey:",
    "msiexec /i x.msi", "winget install x", "UsoClient.exe StartInstall", "Install-Package x", "a11y.worker.a11y_nvda:"]) {
    assert.match(module, INSTALLERS, module);
  }
  assert.doesNotMatch("a11y.worker.a11y_nvda_updates:", INSTALLERS, "negative control: the module that turns NVDA's updates OFF is not an installer");
  assert.doesNotMatch("UsoClient.exe StartScan", INSTALLERS, "negative control: a scan installs nothing");
});

test("the plays the freeze's units start import only the freeze: freeze.yml's role call is the freeze task file", () => {
  const play = read("ansible/freeze.yml");
  const roleCalls = [...code(play).matchAll(/include_role:\n\s+name: (\S+)\n\s+tasks_from: (\S+)/g)].map((m) => `${m[1]}/${m[2]}`);
  assert.deepEqual(roleCalls, ["worker/freeze.yml"], "the daily play runs the role's freeze task file and nothing else of the role");
  assert.doesNotMatch(code(play), /import_role|import_playbook|include_tasks: (?!tasks\/require-inventory-group)/);
});

// ---- reading 3: no scheduled task on a box installs or updates ----------------------------------------------------------------------------------

test("no scheduled task the role or a play registers on a box runs an installer or an updater", () => {
  const files = ["ansible/roles/worker/tasks/tasks.yml", "ansible/roles/worker/tasks/worker-task.yml", "ansible/roles/worker/tasks/edge-version.yml",
    "ansible/tasks/run-interactive.yml", "ansible/auth-leak-check.yml"];
  for (const file of files) {
    const actions = [...code(read(file)).matchAll(/^\s+actions:\n((?:\s+.*\n)+?)\s+(?:triggers|state|enabled|username|logon_type|run_level|description|name):/gm)].map((m) => m[1]);
    for (const action of actions) assert.doesNotMatch(action, INSTALLERS, `${file}: a scheduled task runs an installer`);
    assert.doesNotMatch(code(read(file)), /MicrosoftEdgeUpdate\.exe["']?\s+\/(ua|install|update)|UsoClient[^\n]*Start(Install|Download)/, `${file} runs an updater`);
  }
  const edge = read("ansible/roles/worker/tasks/edge-version.yml");
  assert.match(edge, /arguments: -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\{\{ edge_guard_dir \}\}\\edge-updater-guard\.ps1"/, "the one task this role registers for Edge is the detector");
});
