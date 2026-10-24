/**
 * THE EDGE UPDATER'S NETWORK IS BLOCKED, AS A SECOND LEVER BESIDE THE TASKS AND THE SERVICES (A11-183).
 *
 * Disabling the updater's scheduled tasks and services has been undone four times (a11ign#4732, #4948, #5015, and A11-183): an Edge install
 * re-registers both, and the guard that re-disables them could not change the service's start type as SYSTEM. The EdgeUpdate policies are
 * documented as honoured only on a domain-joined machine and measured as not honoured on these standalone boxes. A firewall rule is honoured, and an
 * installer that re-registers the tasks and the service does not remove it. `MicrosoftEdgeUpdate.exe` is the image the EdgeUpdate log shows
 * running `/ua` hourly.
 *
 * What this pins, read off the files' text (this package has no dependencies, ADR 0012, so no YAML parser): the outbound block rule on the
 * updater's image on every profile, enabled; the image's path in the defaults; and the proof task that reads the rule back from the firewall.
 * It does not stand in the role's way: the Edge installer is a checksummed MSI that `win_get_url` downloads and `win_package` installs, never the updater.
 *
 * EACH CONTROL RUNS THE SAME ASSERTION on the same file with ONE property mutated, so the check is shown to fail on the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const FIREWALL = read("../../ansible/roles/worker/tasks/firewall.yml");
const DEFAULTS = read("../../ansible/roles/worker/defaults/main.yml");
const EDGE_VERSION = read("../../ansible/roles/worker/tasks/edge-version.yml");

const BLOCK_TASK = "Block the Edge updater's network";
const PROOF_TASK = "Refuse to call this provisioned unless the Edge updater's network is blocked";
const UPDATER_EXE = "C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe";

/** The text of one top-level task: from its `- name:` line to the next top-level task, or to the end. */
function taskBlock(text: string, name: string): string {
  const start = text.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `firewall.yml has no task named "${name}": this test examines nothing`);
  const next = text.indexOf("\n- name: ", start + 1);
  return text.slice(start, next < 0 ? text.length : next + 1);
}

/** What is wrong with the block rule, as a list. Empty means the updater's network is blocked outbound on every profile. */
function blockViolations(firewall: string, defaults: string): string[] {
  if (!firewall.includes(`- name: ${BLOCK_TASK}\n`)) return ["there is no task that blocks the updater's network"];
  const rule = taskBlock(firewall, BLOCK_TASK);
  const has = (re: RegExp) => re.test(rule);
  const checks: Array<[string, boolean]> = [
    ["the rule does not use win_firewall_rule", !has(/community\.windows\.win_firewall_rule:/)],
    ["the rule is not outbound", !has(/^\s+direction: out$/m)],
    ["the rule does not block", !has(/^\s+action: block$/m)],
    ["the rule is not on every profile", !has(/^\s+profiles: \[domain, private, public\]$/m)],
    ["the rule is not enabled", !has(/^\s+enabled: true$/m)],
    ["the rule is not present", !has(/^\s+state: present$/m)],
    ["the rule does not cover every protocol", !has(/^\s+protocol: any$/m)],
    ["the rule is not on the updater's image", !has(/^\s+program: '\{\{ worker_edge_updater_exe \}\}'$/m)],
    ["the defaults do not name the updater's image", !defaults.includes(`worker_edge_updater_exe: '${UPDATER_EXE}'`)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([message]) => message);
}

/** What is wrong with the proof task, as a list. */
function proofViolations(firewall: string): string[] {
  if (!firewall.includes(`- name: ${PROOF_TASK}\n`)) return ["there is no task that proves the rule is in place"];
  const proof = taskBlock(firewall, PROOF_TASK);
  const has = (re: RegExp) => re.test(proof);
  const checks: Array<[string, boolean]> = [
    ["the proof does not read the rule from the firewall", !has(/Get-NetFirewallRule -DisplayName \$Rule/)],
    ["the proof does not refuse an absent rule", !has(/if \(-not \$found\) \{ throw /)],
    ["the proof does not require the rule enabled", !has(/\$r\.Enabled -ne 'True'/)],
    ["the proof does not require the rule outbound", !has(/\$r\.Direction -ne 'Outbound'/)],
    ["the proof does not require the rule to block", !has(/\$r\.Action -ne 'Block'/)],
    ["the proof does not require the rule on the updater's image", !has(/Get-NetFirewallApplicationFilter\)\.Program/) || !has(/\$app -ne \$Program/)],
    ["the proof throws nothing when something is wrong", !has(/if \(\$wrong\.Count\) \{ throw /)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([message]) => message);
}

test("the updater's image is blocked outbound on every profile, enabled", () => {
  assert.deepEqual(blockViolations(FIREWALL, DEFAULTS), [],
    "without it an Edge install that re-registers the updater leaves nothing between the updater and the network (A11-183)");
});

test("control: each property of the block rule removed FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["direction: out", "direction: in", "not outbound"],
    ["action: block", "action: allow", "does not block"],
    ["profiles: [domain, private, public]\n    enabled: true\n    state: present\n\n- name: Refuse", "profiles: [domain]\n    enabled: true\n    state: present\n\n- name: Refuse", "not on every profile"],
    ["    enabled: true\n    state: present\n\n- name: Refuse", "    enabled: false\n    state: present\n\n- name: Refuse", "not enabled"],
    ["    state: present\n\n- name: Refuse", "    state: absent\n\n- name: Refuse", "not present"],
    ["    program: '{{ worker_edge_updater_exe }}'\n    direction", "    program: 'C:\\Other.exe'\n    direction", "not on the updater's image"],
  ];
  for (const [from, to, expected] of cases) {
    assert.ok(FIREWALL.includes(from), `"${from}" is not in firewall.yml, so the control mutates nothing`);
    assert.match(blockViolations(FIREWALL.replace(from, to), DEFAULTS).join("|"), new RegExp(expected), `${from} mutated was not noticed`);
  }
  assert.match(blockViolations(FIREWALL, DEFAULTS.replace(UPDATER_EXE, "C:\\Elsewhere\\MicrosoftEdgeUpdate.exe")).join("|"), /defaults do not name/);
  assert.deepEqual(blockViolations(FIREWALL.replace(taskBlock(FIREWALL, BLOCK_TASK), ""), DEFAULTS), ["there is no task that blocks the updater's network"]);
});

test("the rule is read back from the firewall: present, enabled, outbound, blocking, on the updater's image", () => {
  assert.deepEqual(proofViolations(FIREWALL), []);
});

test("control: a proof that stops checking any of those FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["if (-not $found) { throw ", "if (-not $found) { Write-Output ", "refuse an absent rule"],
    ["$r.Enabled -ne 'True'", "$r.Enabled -ne 'Nothing'", "require the rule enabled"],
    ["$r.Direction -ne 'Outbound'", "$r.Direction -ne 'Nothing'", "require the rule outbound"],
    ["$r.Action -ne 'Block'", "$r.Action -ne 'Nothing'", "require the rule to block"],
    ["$app -ne $Program", "$app -ne 'x'", "require the rule on the updater's image"],
    ["if ($wrong.Count) { throw ", "if ($wrong.Count) { Write-Output ", "throws nothing when something is wrong"],
  ];
  for (const [from, to, expected] of cases) {
    assert.ok(FIREWALL.includes(from), `"${from}" is not in firewall.yml, so the control mutates nothing`);
    assert.match(proofViolations(FIREWALL.replace(from, to)).join("|"), new RegExp(expected), `${from} mutated was not noticed`);
  }
});

test("the block does not stand in the role's way: Edge is installed from a downloaded MSI, never through the updater", () => {
  assert.match(EDGE_VERSION, /ansible\.windows\.win_get_url:/);
  assert.match(EDGE_VERSION, /ansible\.windows\.win_package:/);
  assert.doesNotMatch(EDGE_VERSION.replace(/^\s*#.*$/gm, ""), /MicrosoftEdgeUpdate\.exe/, "no task runs the updater to install or update Edge");
});
