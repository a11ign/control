// a11ign/a11ign#5551: the `a11ysrv` scheduled task launches the PUBLISHED launcher, the file the provision stamp hashes, and passes the repo
// root as argument 2. The release launcher refuses to start without argument 2 (`FATAL: no working directory`), so a task that drops it
// registers fine and dies at launch. The row's Acceptance is a source-text grep and cannot see that; these tests parse the task file the way
// Ansible does and read the action's own `path` and `arguments`, so they fail if either is reverted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// The worker registration lives in `worker-task.yml` since A11-204, so `deploy.yml` runs the same definition; the capture-check task stays in `tasks.yml`.
const WORKER_TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/worker-task.yml", import.meta.url)), "utf8");
const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/tasks.yml", import.meta.url)), "utf8");

interface ScheduledTaskAction { path?: string; arguments?: string }

/** The first action of the named task, read from the YAML as Ansible reads it: comments gone, quoting resolved. */
function firstActionOf(file: string, name: string): ScheduledTaskAction | undefined {
  const tasks = parse(file) as Array<Record<string, unknown>>;
  const task = tasks.find((candidate) => candidate.name === name);
  assert.ok(task, `the task '${name}' is gone -- this test examines nothing`);
  const registration = task["community.windows.win_scheduled_task"] as { actions?: ScheduledTaskAction[] };
  return registration.actions?.[0];
}

const WORKER_TASK = "Register the worker task";
const CHECK_TASK = "Register the capture-check task";

const PUBLISHED_PATH = String.raw`{{ worker_repo_path }}\node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd`;
const LAID_SRC_PATH = String.raw`{{ worker_repo_path }}\packages\nvda-worker\src\run-server.cmd`;
const NODE_THEN_REPO_ROOT = `"{{ node_exe.output | first }}" "{{ worker_repo_path }}"`;

test("a11ysrv launches the published run-server.cmd, the file the provision stamp hashes (#5551)", () => {
  assert.equal(firstActionOf(WORKER_TASKS, WORKER_TASK)?.path, PUBLISHED_PATH);
});

test("a11ysrv passes node.exe as argument 1 and the repo root as argument 2 (the release launcher refuses without it) (#5551)", () => {
  assert.equal(firstActionOf(WORKER_TASKS, WORKER_TASK)?.arguments, NODE_THEN_REPO_ROOT);
});

test("a11ycheck stays on the laid run-capture-check.cmd, because release 0.13.1 ships no capture-check launcher (#5551)", () => {
  assert.equal(
    firstActionOf(TASKS, CHECK_TASK)?.path,
    String.raw`{{ worker_repo_path }}\packages\nvda-worker\src\run-capture-check.cmd`);
});

test("NEGATIVE CONTROL: a registration that drops argument 2 or keeps the laid path is refused by the same readers (#5551)", () => {
  const dropsRepoRoot = `- name: ${WORKER_TASK}\n  community.windows.win_scheduled_task:\n    actions:\n      - path: '${PUBLISHED_PATH}'\n        arguments: '"{{ node_exe.output | first }}"'\n`;
  const keepsLaidPath = `- name: ${WORKER_TASK}\n  community.windows.win_scheduled_task:\n    actions:\n      - path: '${LAID_SRC_PATH}'\n        arguments: '${NODE_THEN_REPO_ROOT}'\n`;
  assert.notEqual(firstActionOf(dropsRepoRoot, WORKER_TASK)?.arguments, NODE_THEN_REPO_ROOT, "a registration without argument 2 must not read as passing");
  assert.notEqual(firstActionOf(keepsLaidPath, WORKER_TASK)?.path, PUBLISHED_PATH, "a registration on the laid src launcher must not read as passing");
});
