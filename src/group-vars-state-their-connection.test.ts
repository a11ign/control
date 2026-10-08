import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const GROUP_VARS = join(import.meta.dirname, "../ansible/group_vars");

/**
 * EVERY LINUX GROUP STATES ITS OWN CONNECTION FACTS, and none may be left to inherit.
 *
 * `a11y_control` had no `group_vars` file at all until #1138. A playbook targeting it from a developer's
 * Mac therefore inherited NOTHING and Ansible fell back to the local username:
 *
 *     fatal: [a11y-control]: UNREACHABLE! => Permission denied (publickey,password).
 *
 * **That message names a credential problem rather than a missing variable**, which is why the absence
 * survived for as long as it did -- an operator reads it and checks their key. `fleet-playbook.mjs`
 * documents the identical failure at a different call site, and the remedy reached that call site and not
 * the class. This is the class.
 *
 * The rule is general rather than "a11y_control is special": a new Linux group added tomorrow with an
 * address and no connection facts fails here, in a test, rather than on somebody's first outage.
 *
 * `a11y_workers` is EXCLUDED and that is not an oversight -- it is Windows, reached with
 * `ansible_shell_type: powershell` and a different key, so asserting the Linux shape on it would be
 * asserting the wrong thing. `group_vars/a11y_lab.yml` records what half-specifying this costs:
 * overriding only the connection produced `/bin/sh: 1: PowerShell: not found`.
 */
const LINUX_GROUPS = readdirSync(GROUP_VARS)
  .filter((f) => f.endsWith(".yml") && f !== "a11y_workers.yml");

test("there is a group_vars file for every Linux group, and a11y_control is among them", () => {
  assert.ok(LINUX_GROUPS.includes("a11y_control.yml"),
    `a11y_control.yml is missing from ${GROUP_VARS}. Without it, any playbook targeting the control `
    + "plane falls back to the local username and fails with a message about a key.");
  assert.ok(LINUX_GROUPS.length >= 3,
    `expected at least a11y_control, a11y_lab and a11y_hypervisor; found ${LINUX_GROUPS.join(", ")}`);
});

for (const file of LINUX_GROUPS) {
  test(`${file} states its connection facts rather than inheriting them`, () => {
    const body = readFileSync(join(GROUP_VARS, file), "utf8");
    for (const fact of ["ansible_connection:", "ansible_user:", "ansible_shell_type:"]) {
      assert.match(body, new RegExp(`^${fact}`, "m"),
        `${file} does not state ${fact} at the top level. A group does not inherit another group's vars, `
        + "and a half-specified connection fails with a message about the wrong layer.");
    }
    // The KEY, and by lookup rather than by filename: a real key path committed here would be somebody's
    // infrastructure written down (#255), and `tasks/require-control-plane-key.yml` is what makes the
    // variable required rather than defaulted.
    assert.match(body, /^ansible_ssh_private_key_file: "\{\{ lookup\('env', 'A11Y_PVE_KEY'\) \}\}"$/m,
      `${file} must take its key from the A11Y_PVE_KEY lookup with no default -- see #255.`);
  });
}
