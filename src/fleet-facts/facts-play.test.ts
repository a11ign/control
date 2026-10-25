/**
 * THE PLAY'S READ-ONLY ASSERTION (A11-283, ADR 0005): `ansible/facts.yml` is the one play the job service runs, so it is held to a short allowlist, and a task
 * or a cmdlet outside it fails here before it reaches a box. The other two holds are the runner's check of the callback's `changed` and the script's own
 * `$Ansible.Changed = $false`.
 *
 * Control declares no dependency, so the play is read as text: a task starts at a `- name:` line, and a module is a fully qualified key at the task's depth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLAYBOOK = fileURLToPath(new URL("../../ansible/facts.yml", import.meta.url));
const lines = readFileSync(PLAYBOOK, "utf8").split("\n").filter((line) => !/^\s*#/.test(line));
const text = lines.join("\n");

/** The only modules the play may call, and why each is read-only. */
const MODULES = new Set([
  "ansible.builtin.include_tasks",   // the zero-host precondition on localhost: an assert
  "ansible.windows.win_powershell", // the one read, whose script is held below
]);
/** The only cmdlets and verbs the script may use: every one reads. */
const CMDLETS = new Set(["Get-CimInstance", "Get-ItemProperty", "Get-PhysicalDisk", "Get-Tpm", "Confirm-SecureBootUEFI", "ForEach-Object"]);
/** Keys that make a task able to change something it does not name. */
const FORBIDDEN_KEYS = ["become", "become_user", "become_method", "delegate_to", "when", "notify", "register", "loop", "with_items", "environment"];

type Task = { name: string; body: string[] };

function tasks(): Task[] {
  const found: Task[] = [];
  for (const line of lines) {
    const start = /^\s+- name:\s*(.+?)\s*$/.exec(line);
    if (start) found.push({ name: start[1]!, body: [] });
    else if (found.length) found.at(-1)!.body.push(line);
  }
  return found;
}

const modulesOf = (task: Task): string[] => task.body.flatMap((line) => /^\s+([a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+):/.exec(line)?.[1] ?? []);

test("the play has the precondition and the one read, and every task calls only an allowlisted module", () => {
  const all = tasks();
  assert.deepEqual(all.map((task) => task.name), ["The workers must be in the inventory", "Read the box's hardware"]);
  for (const task of all) {
    const modules = modulesOf(task);
    assert.equal(modules.length, 1, `${task.name} calls one module`);
    assert.ok(MODULES.has(modules[0]!), `${task.name} calls ${modules[0]}, which is not on the read-only allowlist`);
  }
});

test("the read task says changed_when: false", () => {
  const read = tasks().find((task) => task.name === "Read the box's hardware")!;
  assert.ok(read.body.some((line) => /^\s+changed_when:\s*false\s*$/.test(line)), "changed_when: false");
});

test("no task escalates, delegates, loops, registers, notifies or sets an environment", () => {
  for (const key of FORBIDDEN_KEYS) assert.ok(!new RegExp(`^\\s+${key}:`, "m").test(text), `${key} is not used`);
});

test("the script sets $Ansible.Changed to false itself, and never to true", () => {
  assert.match(text, /\$Ansible\.Changed = \$false/);
  assert.ok(!/\$Ansible\.Changed = \$true/.test(text));
});

test("the script calls only read cmdlets", () => {
  const script = text.slice(text.indexOf("script: |"));
  const used = new Set([...script.matchAll(/\b([A-Z][a-z]+-[A-Z][A-Za-z]+)\b/g)].map((match) => match[1]!));
  assert.ok(used.size >= 5, "positive control: the cmdlets were found");
  for (const cmdlet of used) assert.ok(CMDLETS.has(cmdlet), `${cmdlet} is not a read-only cmdlet the play may use`);
});

test("the script cannot write by the back door: no redirection to a file, no call operator on a string, no Invoke- or script-block-from-text", () => {
  const script = text.slice(text.indexOf("script: |"));
  assert.ok(!/(^|[^-])>>?\s*[$"'\w.\\]/m.test(script.replace(/-gt|=>/g, "")), "no redirection");
  assert.ok(!/\bInvoke-|\bStart-Process|\biex\b|\[scriptblock\]::Create/i.test(script));
});

test("the precondition is the shared one and runs on localhost, before any box is opened", () => {
  assert.match(text, /hosts: localhost[\s\S]*ansible\.builtin\.include_tasks: tasks\/require-inventory-group\.yml[\s\S]*hosts: a11y_workers/);
  assert.match(text, /gather_facts: false/);
});
