// A11-204: `fleet:deploy` converges the `a11ysrv` registration before it restarts the task, and reads the registered action back.
//
// a11y-worker-11 failed its code read-back after a restart AND a reboot, because its task still started the orphaned laid
// `packages\nvda-worker\src\run-server.cmd` (v0.9.0) and `deploy.yml` only ever restarted a task it never registered: the logon trigger
// after the reboot launches the REGISTERED action, whatever code the deploy laid. Read from the box 2026-10-24 (the PR names the readings):
// the serving process was `node packages\nvda-worker\src\server.ts`, started at the 12:40 logon, and the task file was rewritten at 13:18.
//
// These tests parse the plays the way Ansible does, so a comment that names the right file cannot satisfy them, and each reader has a negative
// control: a play that restarts without converging is refused by the same reader that passes the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../ansible/${path}`, import.meta.url)), "utf8");
const DEPLOY = read("deploy.yml");
const ROLE_TASKS = read("roles/worker/tasks/tasks.yml");
const WORKER_TASK = read("roles/worker/tasks/worker-task.yml");

type Step = Record<string, unknown> & { name?: string; vars?: Record<string, string>; };

/** The steps of the play's `tasks:` section, in order, as Ansible reads them (comments gone, quoting resolved). */
function stepsOf(play: string): Step[] {
  const [first] = parse(play) as Array<{ tasks?: Step[]; }>;
  assert.ok(first?.tasks, "the play has no `tasks:` -- this test examines nothing");
  return first.tasks;
}

const RESTART_FILE = "tasks/restart-worker.yml";
const indexOfRestart = (steps: Step[]) => steps.findIndex((step) => step["ansible.builtin.import_tasks"] === RESTART_FILE);
const indexOfConverge = (steps: Step[]) => steps.findIndex((step) => {
  const role = step["ansible.builtin.include_role"] as { name?: string; tasks_from?: string; } | undefined;
  return role?.name === "worker" && role.tasks_from === "worker-task.yml";
});
const indexOfLayerAssertion = (steps: Step[]) => steps.findIndex((step) => step.name === "Each layer is ON its pin after the install, laid or cloned");

/** True when the play runs the role's worker-task file after the install's layer assertion and before it restarts the task. */
function convergesBeforeRestart(play: string): boolean {
  const steps = stepsOf(play);
  const [converge, restart, layers] = [indexOfConverge(steps), indexOfRestart(steps), indexOfLayerAssertion(steps)];
  return layers !== -1 && converge !== -1 && restart !== -1 && layers < converge && converge < restart;
}

test("deploy.yml runs the role's worker-task.yml after the layer assertion and before it restarts the task (A11-204)", () => {
  assert.equal(convergesBeforeRestart(DEPLOY), true);
});

test("deploy.yml hands the role the repo path and task name that provision-role.yml hands it (A11-204)", () => {
  const steps = stepsOf(DEPLOY);
  const converge = steps[indexOfConverge(steps)];
  assert.deepEqual(converge.vars, { worker_repo_path: "{{ a11y_repo_path }}", worker_task_name: "{{ a11y_task_name }}" });
  const [provisionRole] = parse(read("provision-role.yml")) as Array<{ roles?: Array<{ role?: string; vars?: Record<string, string>; }>; }>;
  const worker = provisionRole.roles?.find((role) => role.role === "worker");
  assert.equal(worker?.vars?.worker_repo_path, converge.vars?.worker_repo_path);
  assert.equal(worker?.vars?.worker_task_name, converge.vars?.worker_task_name);
});

test("the registration is defined once: worker-task.yml holds it, and tasks.yml imports that file at the same point (A11-204)", () => {
  const names = (file: string) => (parse(file) as Step[]).map((step) => step.name);
  assert.ok(names(WORKER_TASK).includes("Register the worker task"), "worker-task.yml must register the worker task");
  assert.ok(names(WORKER_TASK).includes("Find the node the task must launch"), "the registration reads node_exe, so the lookup travels with it");
  assert.ok(!names(ROLE_TASKS).includes("Register the worker task"), "tasks.yml must not define the registration a second time");
  const roleSteps = parse(ROLE_TASKS) as Step[];
  const imports = roleSteps.filter((step) => step["ansible.builtin.import_tasks"] === "worker-task.yml");
  assert.equal(imports.length, 1, "tasks.yml imports worker-task.yml exactly once");
  assert.equal(roleSteps.indexOf(imports[0]), 0, "and first, where the two steps were");
});

/** The read-back and the assertion that follow the convergence: what the scheduler holds, judged against the published launcher. */
function readBackJudgesPublishedLauncher(play: string): boolean {
  const steps = stepsOf(play);
  const converge = indexOfConverge(steps);
  const readsExecute = (step: Step) => /Get-ScheduledTask[\s\S]*\.Actions\[0\]\.Execute/.test(JSON.stringify(step));
  const read = steps.findIndex((step, at) => at > converge && readsExecute(step));
  const judge = steps.findIndex((step, at) => at > read && read !== -1 && "ansible.builtin.assert" in step);
  if (converge === -1 || read === -1 || judge === -1) return false;
  const assertion = steps[judge];
  const expected = assertion.vars?.expected ?? "";
  const that = String((assertion["ansible.builtin.assert"] as { that?: string; }).that);
  return expected.endsWith(String.raw`\node_modules\@a11ign\screenreader-worker\launcher\run-server.cmd`)
    && expected.startsWith("{{ a11y_repo_path }}") && /\bfound\b.*\bexpected\b/.test(that) && judge < indexOfRestart(steps);
}

test("deploy.yml reads the registered action back and asserts it is the published launcher, before the restart (A11-204)", () => {
  assert.equal(readBackJudgesPublishedLauncher(DEPLOY), true);
});

test("NEGATIVE CONTROL: a play that restarts without converging, or converges after the restart, or never judges the action, is refused (A11-204)", () => {
  const without = DEPLOY.replace(/- name: Register the worker task on the published launcher[\s\S]*?(?=\n {4}- name: Read back the action)/, "");
  assert.notEqual(without, DEPLOY, "the control did not remove the convergence -- it examines nothing");
  assert.equal(convergesBeforeRestart(without), false, "no convergence step must not read as passing");

  const steps = stepsOf(DEPLOY);
  const converge = steps[indexOfConverge(steps)];
  const late = [...steps.filter((step) => step !== converge), converge];
  assert.ok(indexOfConverge(late) > indexOfRestart(late), "the control did not move the convergence after the restart -- it examines nothing");
  // JSON is YAML, so the reordered steps go back through the same parser the real play does.
  assert.equal(convergesBeforeRestart(JSON.stringify([{ tasks: late }])), false, "a convergence after the restart must not read as passing");

  const unjudged = DEPLOY.replace(/- name: The worker task starts the published launcher[\s\S]*?(?=\n {4}- name: Restart the worker task)/, "");
  assert.notEqual(unjudged, DEPLOY, "the control did not remove the assertion -- it examines nothing");
  assert.equal(readBackJudgesPublishedLauncher(unjudged), false, "a read-back nobody judges must not read as passing");

  const laid = DEPLOY.replace(String.raw`\\node_modules\\@a11ign\\screenreader-worker\\launcher\\run-server.cmd`, String.raw`\\packages\\nvda-worker\\src\\run-server.cmd`);
  assert.notEqual(laid, DEPLOY, "the control did not swap the launcher -- it examines nothing");
  assert.equal(readBackJudgesPublishedLauncher(laid), false, "an assertion against the laid launcher must not read as passing");
});
