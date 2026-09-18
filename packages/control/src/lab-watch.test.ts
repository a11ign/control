// #866: "a failed unit becomes visible without anyone asking." These tests never touch the lab or `gh` --
// `runLabStatus`'s `run` is injected throughout, exactly as the amendment describes this as buildable and
// testable offline.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runLabStatus, extractReportJson, watchBody, REPORT_TASK_NAME } from "./lab-watch.mjs";
import { describeFailures } from "./lab-failed-units.mjs";

/** A minimal ansible `json` stdout-callback document carrying one task's result on one host. */
function playbookRun(taskName: string, hostStdout: string) {
  return {
    plays: [
      {
        tasks: [
          { task: { name: "Which a11y jobs exist at all" }, hosts: { "a11y-lab": { stdout: "" } } },
          { task: { name: taskName }, hosts: { "a11y-lab": { stdout: hostStdout } } },
        ],
      },
    ],
    stats: { "a11y-lab": { ok: 2, failures: 0 } },
  };
}

test("runLabStatus forces the json callback for this one call, leaving ansible.cfg's default untouched", () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const run = (argv: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    assert.deepEqual(argv, ["ansible-playbook", "packages/control/ansible/lab-status.yml"]);
    capturedEnv = opts?.env;
    return JSON.stringify(playbookRun(REPORT_TASK_NAME, "{}"));
  };
  runLabStatus(run);
  assert.equal(capturedEnv?.ANSIBLE_CONFIG, "packages/control/ansible/ansible.cfg");
  assert.equal(capturedEnv?.ANSIBLE_STDOUT_CALLBACK, "json");
});

test("extractReportJson finds the report task BY NAME, not by position", () => {
  const run = playbookRun(REPORT_TASK_NAME, '{"attention":true,"entries":[]}');
  assert.equal(extractReportJson(run), '{"attention":true,"entries":[]}');
});

test("extractReportJson is null when the named task never ran -- never a stale or fabricated answer", () => {
  const run = playbookRun("Some other task entirely", "{}");
  assert.equal(extractReportJson(run), null);
});

test("extractReportJson is null on empty stdout, not on the empty string itself", () => {
  const run = playbookRun(REPORT_TASK_NAME, "   ");
  assert.equal(extractReportJson(run), null);
});

test("watchBody names every failed unit and the count, over renderReport's own lines", () => {
  const now = new Date("2026-09-18T16:30:00Z");
  const described = describeFailures(
    [{ unit: "a11y-job-gate-stability.service", activeEnterTimestamp: "Sun 2026-09-06 16:30:00 UTC" }],
    now,
  );
  const body = watchBody(described);
  assert.match(body, /\*\*1 a11y-job-\* unit\(s\) in a `failed` state\*\* \(#866\)\./);
  assert.match(body, /a11y-job-gate-stability\.service: failed, since 12 days ago/);
});
