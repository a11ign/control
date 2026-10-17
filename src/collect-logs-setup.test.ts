// no-token: gh -- parses `collect-logs.yml` and runs `ansible-playbook --syntax-check`; no network, no fleet.
/**
 * A11-31: `collect-logs.yml` fetches Setup's own Panther logs, so a feature update's install phase can be read through
 * Ansible rather than by hand on a box.
 *
 * These tests exercise the playbook, not its text. The file is parsed (PyYAML, through python3) and the Setup task is
 * read as the structure Ansible would run: its module, its `src` and `dest` for each item, and its `fail_on_missing`.
 * `ansible-playbook --syntax-check` must accept the file. Neither runs a fetch against a Windows guest, because none is
 * reachable from a test; a fetch on a real box is the live reading on A11-31.
 *
 * Each requirement carries a control: the base file has no Setup task, so the same assertions fail on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COLLECT_LOGS = fileURLToPath(new URL("../ansible/collect-logs.yml", import.meta.url));

type Task = { name?: string; [module: string]: unknown };

/** The playbook's tasks, parsed by PyYAML: the structure Ansible reads, not the text of it. */
function parsedTasks(path: string): Task[] {
  const parse = spawnSync("python3", ["-c",
    "import sys, json, yaml\n" +
    "plays = yaml.safe_load(open(sys.argv[1]))\n" +
    "print(json.dumps([t for p in plays for t in p.get('tasks', [])]))",
    path], { encoding: "utf8" });
  assert.equal(parse.status, 0, `python3 could not parse ${path}: ${parse.stderr}`);
  return JSON.parse(parse.stdout) as Task[];
}

const setupTask = (tasks: Task[]) => tasks.find((t) => String(t.name ?? "").includes("Setup's own logs"));

test("A11-31: the playbook is valid Ansible", (t) => {
  const check = spawnSync("ansible-playbook", ["--syntax-check", "-i", "localhost,", COLLECT_LOGS], { encoding: "utf8" });
  if (check.error && (check.error as NodeJS.ErrnoException).code === "ENOENT") {
    t.skip("ansible-playbook is not installed on this machine");
    return;
  }
  assert.equal(check.status, 0, `ansible-playbook --syntax-check failed:\n${check.stdout}\n${check.stderr}`);
});

test("A11-31: the Setup task fetches both Panther logs, from the path Setup writes them to", () => {
  const task = setupTask(parsedTasks(COLLECT_LOGS));
  assert.ok(task, "a task named for Setup's own logs must exist");
  assert.ok("ansible.builtin.fetch" in task, "it must use the fetch module, which reads from the guest");
  const fetch = task["ansible.builtin.fetch"] as { src: string; dest: string; flat: boolean };
  assert.equal(fetch.src, "{{ item.src }}", "the source is the loop's own path, not a shared value");
  assert.equal(fetch.flat, true, "flat, so the log lands as one file and not a directory tree");
  const items = task.loop as Array<{ src: string; dest: string }>;
  assert.deepEqual(items.map((i) => i.src), [
    "C:\\$WINDOWS.~BT\\Sources\\Panther\\setupact.log",
    "C:\\$WINDOWS.~BT\\Sources\\Panther\\setuperr.log",
  ], "both Panther logs, at the path Setup writes them to");
  assert.deepEqual(items.map((i) => i.dest), ["setup-setupact.log", "setup-setuperr.log"],
    "each lands under its own name, so the two logs cannot overwrite each other");
});

test("A11-31: a box with no Panther directory is an answer, not a failed play", () => {
  const fetch = setupTask(parsedTasks(COLLECT_LOGS))?.["ansible.builtin.fetch"] as { fail_on_missing: boolean } | undefined;
  assert.ok(fetch, "the Setup fetch must exist");
  assert.equal(fetch.fail_on_missing, false,
    "a box that never staged an upgrade has no Panther directory, and the play must not fail on it");
});

test("A11-31: the playbook still changes nothing on the guest", () => {
  // `collect-logs.yml` is READ-ONLY on the guest (fleet-playbook.test.ts pins it in the allowlist). Checks the parsed
  // module of every task, so a writing task added later fails here rather than in a box.
  const writers = ["ansible.windows.win_reboot", "ansible.windows.win_regedit", "ansible.windows.win_updates",
    "ansible.windows.win_command", "ansible.windows.win_copy", "ansible.windows.win_file", "ansible.windows.win_service"];
  for (const task of parsedTasks(COLLECT_LOGS)) {
    for (const writer of writers) {
      assert.equal(writer in task, false, `"${task.name}" uses ${writer}, which changes the guest`);
    }
  }
});
