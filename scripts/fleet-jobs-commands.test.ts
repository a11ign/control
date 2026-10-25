/**
 * THE FLEET JOB SERVICE'S COMMANDS ARE CONTROL'S (A11-243). It lives in `scripts/` because it READS the `scripts` of `package.json`, which the core's laid copy of this
 * package deletes (see `control-commands.test.ts`). `fleet` is the CLI an agent submits and waits with, and `fleet:jobs-install` is the one route that changes the service on
 * the control plane (Ansible only). Neither may reach into a laid `packages/control`, and each must name a file this repository holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { scripts: Record<string, string>; bin?: unknown };

test("`fleet` runs the CLI's own file, and that file is here", () => {
  assert.equal(manifest.scripts.fleet, "node src/fleet-jobs/cli.ts");
  assert.ok(existsSync(`${ROOT}src/fleet-jobs/cli.ts`));
});

test("`fleet:jobs-install` runs the playbook with this repository's ansible config, like the schedule installers", () => {
  assert.equal(manifest.scripts["fleet:jobs-install"], "ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/fleet-jobs-install.yml");
  assert.ok(existsSync(`${ROOT}ansible/fleet-jobs-install.yml`));
  assert.equal(manifest.scripts["fleet:auto-off-schedule"], "ANSIBLE_CONFIG=ansible/ansible.cfg ansible-playbook ansible/auto-off-schedule.yml", "positive control: the shape compared with is the schedule installer's");
});

test("neither command reaches into a laid packages/control, and the CLI refuses to run when merely imported", () => {
  for (const name of ["fleet", "fleet:jobs-install"]) assert.ok(!manifest.scripts[name]!.includes("packages/control"), name);
  const source = readFileSync(`${ROOT}src/fleet-jobs/cli.ts`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.ok(source.includes("import.meta.url ==="), "cli.ts runs only when it is the entry point");
});
