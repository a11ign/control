/**
 * `ansible/freeze.yml`, THE DAILY PLAY: IT REFUSES TO RUN UNDER AN UPGRADE, FREEZES EVERY BOX THAT ANSWERS, AND NAMES THE ONES THAT DID NOT (A11-205).
 *
 * Two kinds of test, as `patch-playbook.test.ts` has:
 *   - BEHAVIOUR, through the real `ansible-playbook` over a SYNTHETIC inventory of local hosts carrying invented readings (it reaches no box): the closing play's
 *     record and verdict, and the guard that refuses while `fleet:patch` is running (a stand-in `systemctl` answers). It needs Ansible, which the control plane always
 *     has; where it is absent the tests say so by name rather than pass.
 *   - STRUCTURE, read off the parsed playbook: the freeze task ignores its own failure so the closing play ALWAYS runs and writes the record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ANSIBLE = fileURLToPath(new URL("../../ansible/", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Yaml = any;
const PLAYS: Yaml[] = JSON.parse(execFileSync("python3", ["-I", "-c",
  "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", join(ANSIBLE, "freeze.yml")], { encoding: "utf8" }));

const HAVE_ANSIBLE = spawnSync("ansible-playbook", ["--version"], { encoding: "utf8" }).status === 0;
const NO_ANSIBLE = "ansible-playbook is not installed on this machine, so the play cannot be run (the control plane has it)";

/** A copy of the playbook where its `../runs` is a scratch directory, so the record it writes is read back and nothing real is touched. */
function scratch(): { dir: string; play: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), "freeze-play-"));
  mkdirSync(join(dir, "ansible"));
  mkdirSync(join(dir, "bin"));
  cpSync(join(ANSIBLE, "freeze.yml"), join(dir, "ansible", "freeze.yml"));
  cpSync(join(ANSIBLE, "tasks"), join(dir, "ansible", "tasks"), { recursive: true });
  writeFileSync(join(dir, "ansible", "ansible.cfg"), "[defaults]\nlocalhost_warning = False\n");
  return { dir, play: join(dir, "ansible", "freeze.yml"), record: join(dir, "runs", "fleet-freeze-last-run.json") };
}

function run(options: { hosts: Record<string, Record<string, unknown>>; tags: string; systemctl?: string }): { status: number | null; out: string; record: Yaml | null } {
  const { dir, play, record } = scratch();
  const inventory = join(dir, "inventory.json");
  writeFileSync(inventory, JSON.stringify({ a11y_workers: { hosts: Object.fromEntries(Object.entries(options.hosts).map(([name, vars]) => [name, { ansible_connection: "local", ...vars }])) } }));
  if (options.systemctl !== undefined) {
    writeFileSync(join(dir, "bin", "systemctl"), `#!/bin/sh\necho ${options.systemctl}\n`);
    chmodSync(join(dir, "bin", "systemctl"), 0o755);
  }
  const result = spawnSync("ansible-playbook", ["-i", inventory, play, "--tags", options.tags], {
    cwd: join(dir, "ansible"), encoding: "utf8",
    env: { ...process.env, ANSIBLE_CONFIG: join(dir, "ansible", "ansible.cfg"), ANSIBLE_NOCOLOR: "1", PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
  let written: Yaml | null = null;
  try { written = JSON.parse(readFileSync(record, "utf8")); } catch { written = null; }
  return { status: result.status, out: `${result.stdout}\n${result.stderr}`, record: written };
}

const FROZEN = { freeze_ping: { ping: "pong" }, worker_freeze_done: true, worker_freeze_put_back: [] };

test("the closing play passes and records a clean day: every box answered, froze, and had nothing to put back", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, out, record } = run({ tags: "freeze_verdict", hosts: { "a11y-worker-2": FROZEN, "a11y-worker-3": FROZEN } });
  assert.equal(status, 0, out);
  assert.deepEqual(record?.frozen, ["a11y-worker-2", "a11y-worker-3"]);
  assert.deepEqual(record?.putBack, {});
  assert.deepEqual(record?.unreachable, []);
  assert.deepEqual(record?.failed, []);
});

test("the closing play FAILS and names a lever that had to be put back, the box that was not reached, and the box that did not hold", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const hosts = {
    "a11y-worker-2": FROZEN,
    "a11y-worker-3": { freeze_ping: { unreachable: true, msg: "no route" } },
    "a11y-worker-4": { ...FROZEN, worker_freeze_put_back: ["wuauserv Start=4"] },
    "a11y-worker-5": { freeze_ping: { ping: "pong" } },
  };
  const { status, out, record } = run({ tags: "freeze_verdict", hosts });
  assert.notEqual(status, 0, out);
  assert.deepEqual(record?.unreachable, ["a11y-worker-3"], "a box that was off is named, so it is frozen the next day it is awake");
  assert.deepEqual(record?.putBack, { "a11y-worker-4": ["wuauserv Start=4"] }, "the lever that had come back, by box");
  assert.deepEqual(record?.failed, ["a11y-worker-5"], "reached, but the freeze never reached its last task");
  assert.deepEqual(record?.frozen, ["a11y-worker-2", "a11y-worker-4"]);
  assert.match(out, /a11y-worker-3/);
  // Each cause alone fails the run (the negative control is the clean day above).
  for (const only of [{ "a11y-worker-2": hosts["a11y-worker-3"] }, { "a11y-worker-2": hosts["a11y-worker-4"] }, { "a11y-worker-2": hosts["a11y-worker-5"] }]) {
    assert.notEqual(run({ tags: "freeze_verdict", hosts: only }).status, 0, JSON.stringify(only));
  }
});

test("a box with no ping result at all was not asked, so it is not counted frozen", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const { status, record } = run({ tags: "freeze_verdict", hosts: { "a11y-worker-2": FROZEN, "a11y-worker-3": { worker_freeze_done: true, worker_freeze_put_back: [] } } });
  assert.notEqual(status, 0);
  assert.deepEqual(record?.unreachable, ["a11y-worker-3"]);
});

test("the freeze task ignores its own failure, so the closing play still runs and writes the record when EVERY box fails", () => {
  const freeze = PLAYS[1].tasks.find((task: Yaml) => task.name === "Freeze it");
  assert.equal(freeze.ignore_errors, true);
  assert.equal(PLAYS[1].ignore_unreachable, true, "a box that is off does not end the run for the rest");
  assert.equal(freeze["ansible.builtin.include_role"].tasks_from, "freeze.yml");
  // The closing play is a separate play on localhost: a play that ended with every host failed would never reach it, which is why the task above ignores errors.
  assert.equal(PLAYS[2].hosts, "localhost");
  assert.deepEqual(PLAYS[2].tags, ["freeze_verdict"]);
});

test("the play refuses to run while the deliberate upgrade is running, and not after it finished (the unit stays `active (exited)` for ever)", { skip: HAVE_ANSIBLE ? false : NO_ANSIBLE }, () => {
  const hosts = { "a11y-worker-2": FROZEN };
  for (const running of ["running", "start", "start-pre"]) {
    const refused = run({ tags: "freeze_guard", hosts, systemctl: running });
    assert.notEqual(refused.status, 0, `${running}: ${refused.out}`);
    assert.match(refused.out, /deliberate upgrade has lifted the Windows levers/);
  }
  for (const finished of ["exited", "dead", "failed", ""]) {
    assert.equal(run({ tags: "freeze_guard", hosts, systemctl: finished }).status, 0, `SubState '${finished}' must not refuse`);
  }
});
