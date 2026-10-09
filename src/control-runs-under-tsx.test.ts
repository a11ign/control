/**
 * EVERY PLACE THAT RUNS A CONTROL MODULE BY PATH NAMES THE LOADER THAT RESOLVES ON ITS BOX (#4341, following #4268).
 *
 * The modules are TypeScript, and the boxes differ in what they hold. The control plane's loader is `/opt/a11y-tsx`
 * (#4292), named by absolute path because a bare `--import tsx` resolves from the working directory and a laid layer
 * has no `node_modules`. The lab's is `lab_tsx`. A `.ts` path handed to plain `node` is not a loud failure on every box:
 * where the unit's `node` is 24 it strips the types and runs, and where it is 22 it dies at the first annotation, so
 * the spelling is pinned here rather than left to whichever box runs it first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ansible = (path: string) => readFileSync(new URL(`../ansible/${path}`, import.meta.url), "utf8");
const CONTROL_PATH = /packages\/control\/src\/[a-z-]+\.(mjs|ts)/;

/** The one spelling `control-host-install.yml` asserts is present, which is what the units and tasks may name. */
const LOADER = /^\s*control_tsx_loader:\s*(\S+)\s*$/m.exec(ansible("control-host-install.yml"))?.[1] ?? "";

test("the loader control-host-install.yml asserts is the /opt/a11y-tsx install (the positive control for the rest)", () => {
  assert.equal(LOADER, "/opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs");
});

test("the two control-plane units run their module through that loader, by absolute path", () => {
  for (const [unit, module] of [["a11y-fleet-auto-off", "fleet-auto-off"], ["a11y-gate-heartbeat", "gate-heartbeat"]]) {
    const execStart = ansible(`files/${unit}.service`).split("\n").filter((l) => l.startsWith("ExecStart="));
    assert.equal(execStart.length, 1, `${unit}: one ExecStart`);
    assert.match(execStart[0], new RegExp(`^ExecStart=/usr/bin/node --import ${LOADER.replaceAll(".", "\\.")} \\S*/packages/control/src/${module}\\.ts( --apply)?$`));
  }
});

test("deploy.yml and the worker bespoke task, which run on the control plane, import the module through that loader", () => {
  for (const file of ["deploy.yml", "roles/worker/tasks/bespoke.yml"]) {
    const text = ansible(file);
    assert.ok(text.includes(LOADER), `${file}: does not name ${LOADER}`);
    assert.doesNotMatch(text, /packages\/control\/src\/[a-z-]+\.mjs/, `${file}: still names an .mjs control module`);
  }
});

test("the lab's argvs run the module with lab_tsx, and no ansible file outside comments names a control .mjs", () => {
  const status = ansible("lab-status.yml").split("\n").filter((l) => /packages\/control\/src\//.test(l) && !/^\s*#/.test(l));
  assert.equal(status.length, 3, "lab-status.yml: --list-failed, --report, --report --json");
  for (const line of status) assert.match(line, /^\s*argv: \["\{\{ lab_tsx \}\}", packages\/control\/src\/lab-failed-units\.ts,/, line);
  const group = ansible("group_vars/a11y_lab.yml");
  assert.match(group, /^lab_laid_copy_check: \["\{\{ lab_tsx \}\}", "packages\/control\/src\/lab-laid-copy\.ts"\]$/m);
});

test("no ansible file runs a control .mjs: the pattern finds the .ts spelling, so an empty answer means it was looked for", () => {
  const files = ["deploy.yml", "inventory-install.yml", "lab-status.yml", "fleet-link-view.yml", "group_vars/a11y_lab.yml", "roles/worker/tasks/bespoke.yml",
    "files/a11y-fleet-auto-off.service", "files/a11y-gate-heartbeat.service"];
  assert.ok(files.length > 0, "no ansible files listed, so nothing below would be examined");
  const named = files.filter((f) => CONTROL_PATH.test(ansible(f)));
  assert.ok(named.length >= 6, `the pattern should find control modules in most of these (found in ${named.length})`);
  const mjs = files.filter((f) => ansible(f).split("\n").some((l) => /packages\/control\/src\/[a-z-]+\.mjs/.test(l)));
  assert.deepEqual(mjs, []);
});
