// no-token: gh -- reads `collect-logs.yml` as text; no network, no fleet.
/**
 * A11-31: `collect-logs.yml` fetches Setup's own Panther logs, so a feature update's install phase can be read through
 * Ansible rather than by hand on a box. The brief names this as the way to read the cause of a staged-but-not-switched
 * box, and it was missing.
 *
 * Each requirement carries a control: the same test reads the file as it is, so a file without the fetch fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COLLECT_LOGS_YML = readFileSync(fileURLToPath(new URL("../ansible/collect-logs.yml", import.meta.url)), "utf8");

test("A11-31: the Panther logs of a feature update are fetched from the box, with the log files named", () => {
  assert.match(COLLECT_LOGS_YML, /src: 'C:\\\$WINDOWS\.~BT\\Sources\\Panther\\setupact\.log'/,
    "setupact.log is the first log of a Setup run: without this fetch the install phase cannot be read through Ansible");
  assert.match(COLLECT_LOGS_YML, /src: 'C:\\\$WINDOWS\.~BT\\Sources\\Panther\\setuperr\.log'/,
    "setuperr.log is where Setup's fatal error by line is written");
});

test("A11-31: a box with no Panther directory is an answer, not a failed play", () => {
  const block = COLLECT_LOGS_YML.slice(COLLECT_LOGS_YML.indexOf("Setup's own logs"));
  assert.match(block.slice(0, block.indexOf("Say where they went")), /fail_on_missing: false/,
    "a box that never staged an upgrade has no Panther directory, so the fetch must not fail the play");
});

test("A11-31: the fetch writes only to the control plane, and the guest is only read", () => {
  // `collect-logs.yml` is READ-ONLY on the guest (fleet-playbook.test.ts pins it in the allowlist). A new task that
  // changes the guest would make that allowlist entry a lie, so this checks the file names no writing module.
  // `win_shell` stays allowed: the existing task that lists NVDA's logs uses it to read, and nothing else does.
  for (const writer of ["win_reboot", "win_regedit", "win_updates", "win_command", "win_copy", "win_file"]) {
    const used = COLLECT_LOGS_YML.split("\n").filter((line) => line.trim().startsWith(`ansible.windows.${writer}`));
    assert.deepEqual(used, [], `${writer} would change the guest, and collect-logs.yml is read-only on it`);
  }
});
