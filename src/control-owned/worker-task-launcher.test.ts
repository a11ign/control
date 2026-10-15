// a11ign/a11ign#5551: the `a11ysrv` scheduled task launches the PUBLISHED launcher, the file the provision stamp hashes, and passes the repo
// root as argument 2. The release launcher refuses to start without argument 2 (`FATAL: no working directory`), so a task that drops it
// registers fine and dies at launch. The row's Acceptance is a source-text grep and cannot see that; these tests read the action's own
// `path` and `arguments` and fail if either is reverted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TASKS = readFileSync(
  fileURLToPath(new URL("../../ansible/roles/worker/tasks/tasks.yml", import.meta.url)), "utf8");

/** The named task's registration with its comment lines removed, so only what Ansible would read is left. */
function registrationOf(file: string, name: string): string {
  const at = file.indexOf(`- name: ${name}`);
  assert.notEqual(at, -1, `the task '${name}' is gone -- this test examines nothing`);
  const next = file.indexOf("\n- name: ", at + 1);
  const block = next === -1 ? file.slice(at) : file.slice(at, next);
  return block.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

const WORKER_TASK = "Register the worker task";
const CHECK_TASK = "Register the capture-check task";

/** The `path:` of the one action in a registration, as written in the file (YAML double-quoted, so backslashes are doubled). */
const actionPath = (block: string): string | undefined => /^\s*- path:\s*"([^"]*)"/m.exec(block)?.[1];
/** The `arguments:` of the one action in a registration, without its surrounding YAML single quotes. */
const actionArguments = (block: string): string | undefined => /^\s*arguments:\s*'([^']*)'/m.exec(block)?.[1];

const PUBLISHED_PATH = String.raw`{{ worker_repo_path }}\\node_modules\\@a11ign\\screenreader-worker\\launcher\\run-server.cmd`;
const LAID_SRC_PATH = String.raw`{{ worker_repo_path }}\\packages\\nvda-worker\\src\\run-server.cmd`;
const NODE_THEN_REPO_ROOT = String.raw`"{{ node_exe.output | first }}" "{{ worker_repo_path }}"`;

test("a11ysrv launches the published run-server.cmd, the file the provision stamp hashes (#5551)", () => {
  assert.equal(actionPath(registrationOf(TASKS, WORKER_TASK)), PUBLISHED_PATH);
});

test("a11ysrv passes node.exe as argument 1 and the repo root as argument 2 (the release launcher refuses without it) (#5551)", () => {
  assert.equal(actionArguments(registrationOf(TASKS, WORKER_TASK)), NODE_THEN_REPO_ROOT);
});

test("a11ycheck stays on the laid run-capture-check.cmd, because release 0.13.1 ships no capture-check launcher (#5551)", () => {
  assert.equal(actionPath(registrationOf(TASKS, CHECK_TASK)), String.raw`{{ worker_repo_path }}\\packages\\nvda-worker\\src\\run-capture-check.cmd`);
});

test("NEGATIVE CONTROL: a registration that drops argument 2 or keeps the laid path is refused by the same readers (#5551)", () => {
  const dropsRepoRoot = `- name: ${WORKER_TASK}\n    actions:\n      - path: "${PUBLISHED_PATH}"\n        arguments: '"{{ node_exe.output | first }}"'\n`;
  const keepsLaidPath = `- name: ${WORKER_TASK}\n    actions:\n      - path: "${LAID_SRC_PATH}"\n        arguments: '${NODE_THEN_REPO_ROOT}'\n`;
  assert.notEqual(actionArguments(dropsRepoRoot), NODE_THEN_REPO_ROOT, "a registration without argument 2 must not read as passing");
  assert.notEqual(actionPath(keepsLaidPath), PUBLISHED_PATH, "a registration on the laid src launcher must not read as passing");
});
