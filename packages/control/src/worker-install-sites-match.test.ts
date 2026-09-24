/**
 * The two places a Windows worker installs its dependencies run ONE script (#2299).
 *
 * `deploy.yml` installs on every deploy and `roles/worker/tasks/nvda.yml` on every provision. The first
 * carried a comment saying the two MUST match; a comment is what stops being true the day someone edits
 * one site, and the damage is quiet -- a box provisioned one way and deployed another, each step proving
 * nothing is wrong about the other. This reads both, so the next edit to one breaks a test.
 *
 * It also pins the property the move from `npm install` to pnpm exists to keep: the install is FROZEN. A
 * plain `pnpm install` would reconcile a drifted lockfile instead of refusing it, and every worker would
 * then run a tree no other machine has -- with guidepup's version, which is evidence in the capture cache
 * key, decided by whatever the registry said that day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));
const INSTALL_TASK = "Install dependencies";
const WIN_SHELL = "ansible.windows.win_shell";

/** Every task in a parsed playbook or task file, descending into plays, blocks, rescue and always. */
function allTasks(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(allTasks);
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const nested = ["tasks", "pre_tasks", "post_tasks", "block", "rescue", "always"].flatMap((key) => allTasks(record[key]));
  return [record, ...nested];
}

/** The `win_shell` script of every task named "Install dependencies" in one file, whitespace-normalised. */
export function installScripts(text: string): string[] {
  return allTasks(parse(text))
    .filter((task) => task.name === INSTALL_TASK && typeof task[WIN_SHELL] === "string")
    .map((task) => (task[WIN_SHELL] as string).replace(/\s+/g, " ").trim());
}

/** Whether two files' install scripts are one and the same script, exactly once each. */
export function sameSingleScript(a: string[], b: string[]): boolean {
  return a.length === 1 && b.length === 1 && a[0] === b[0];
}

const DEPLOY = installScripts(readFileSync(`${ANSIBLE}deploy.yml`, "utf8"));
const ROLE = installScripts(readFileSync(`${ANSIBLE}roles/worker/tasks/nvda.yml`, "utf8"));

test("each worker install site is found exactly once, so the comparison below compares something", () => {
  assert.equal(DEPLOY.length, 1, `deploy.yml has ${DEPLOY.length} win_shell tasks named "${INSTALL_TASK}"`);
  assert.equal(ROLE.length, 1, `roles/worker/tasks/nvda.yml has ${ROLE.length} win_shell tasks named "${INSTALL_TASK}"`);
});

test("deploy.yml and the worker role install with the SAME script", () => {
  assert.ok(sameSingleScript(DEPLOY, ROLE),
    `the two worker install sites have diverged:\n  deploy.yml: ${DEPLOY[0]}\n  nvda.yml:   ${ROLE[0]}`);
});

test("the shared script is a FROZEN pnpm install that refuses to hand its exit code away", () => {
  const [script] = DEPLOY;
  assert.match(script, /corepack pnpm install --frozen-lockfile\b/);
  assert.doesNotMatch(script, /--no-frozen-lockfile|--fix-lockfile|\bnpm (?:install|ci)\b/);
  assert.match(script, /exit \$LASTEXITCODE\s*$/, "a failed install must fail the deploy, not vanish into the last statement");
});

test("the comparator fails on a site that drifted (positive control for the equality above)", () => {
  const drifted = [DEPLOY[0].replace("--frozen-lockfile", "--no-frozen-lockfile")];
  assert.equal(sameSingleScript(DEPLOY, drifted), false);
  assert.equal(sameSingleScript(DEPLOY, []), false, "a missing site is a divergence, not an agreement");
  assert.equal(sameSingleScript([], []), false, "two empty readings agree about nothing");
  assert.deepEqual(installScripts("- name: Something else\n  ansible.windows.win_shell: echo hi\n"), []);
});
