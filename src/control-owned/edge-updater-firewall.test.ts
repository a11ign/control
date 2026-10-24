/**
 * THE EDGE UPDATER'S NETWORK IS BLOCKED, ONE OUTBOUND RULE FOR EACH UPDATER BINARY, AS A LEVER BESIDE THE SERVICES, THE TASKS AND THE RENAME (A11-183, A11-205).
 *
 * Disabling the updater's tasks and services has been undone four times (a11ign#4732, #4948, #5015, and A11-183): an Edge install re-registers both. The EdgeUpdate
 * policies are documented as honoured only on a domain-joined machine and measured as not honoured on these standalone boxes. A firewall rule is honoured, and an
 * installer that re-registers the tasks and the service does not remove it. A11-183 blocked the ROOT `MicrosoftEdgeUpdate.exe`; that was not enough, because the
 * versioned folders (`1.3.299.15\`, `1.3.303.7\`) hold copies of the same image and which exist differs per box.
 *
 * So the rule is laid by `tasks/freeze.yml` (which runs on every provision AND daily), one for each binary it DISCOVERS, a renamed one found by its suffix and
 * blocked at its ORIGINAL path, because the install restores the original name and the rule must already be there. It is a PROGRAM rule, not an FQDN rule: a
 * program rule blocks every endpoint the updater would use, and FQDN dynamic keywords resolve through Defender's network protection, which these boxes cannot be
 * relied on to run. `firewall.yml` no longer carries the root-only rule.
 *
 * What this pins, read off the files' text (this package has no dependencies, ADR 0012, so no YAML parser): that the rule is outbound, block, any protocol, any
 * profile, enabled, per program path; that the paths are discovered recursively and from the renamed files; that a stale root-only rule is removed; and that the
 * freeze's read-back requires an enabled outbound block rule for every frozen binary. It does not stand in the role's way: Edge is installed from a checksummed MSI
 * that Ansible downloads (`win_get_url`), never through the updater. The proof that the block HOLDS is `freeze-proof.yml`, on a box.
 *
 * EACH CONTROL RUNS THE SAME ASSERTION on the same file with ONE property mutated, so the check is shown to fail on the defect.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const FREEZE_PATH = fileURLToPath(new URL("../../ansible/roles/worker/tasks/freeze.yml", import.meta.url));
const FIREWALL = read("../../ansible/roles/worker/tasks/firewall.yml");
const DEFAULTS = read("../../ansible/roles/worker/defaults/main.yml");
const EDGE_VERSION = read("../../ansible/roles/worker/tasks/edge-version.yml");
const FREEZE_TEXT = read("../../ansible/roles/worker/tasks/freeze.yml");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Task = Record<string, any>;
const FREEZE_TASKS: Task[] = JSON.parse(execFileSync("python3", ["-I", "-c",
  "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))[0]['block']))", FREEZE_PATH], { encoding: "utf8" }));

const RULE_TASK = "The Edge updater's network is blocked";
const READ_BACK = "Refuse to call this box frozen";
const UPDATER_EXE = "C:\\Program Files (x86)\\Microsoft\\EdgeUpdate\\MicrosoftEdgeUpdate.exe";

const scriptOf = (tasks: Task[], prefix: string): string => {
  const task = tasks.find((candidate) => String(candidate.name).startsWith(prefix));
  assert.ok(task, `freeze.yml has no task starting "${prefix}": this test examines nothing`);
  return String(task["ansible.windows.win_powershell"].script);
};
const parametersOf = (tasks: Task[], prefix: string): Record<string, string> =>
  (tasks.find((candidate) => String(candidate.name).startsWith(prefix)) as Task)["ansible.windows.win_powershell"].parameters;

/** What is wrong with the rule-laying script, as a list. Empty means one outbound block rule per discovered updater binary. */
function ruleViolations(script: string, parameters: Record<string, string>, defaults: string): string[] {
  const checks: Array<[string, boolean]> = [
    ["the rule is not outbound", !/-Direction Outbound/.test(script)],
    ["the rule does not block", !/-Action Block/.test(script)],
    ["the rule is not on every profile", !/-Profile Any/.test(script)],
    ["the rule does not cover every protocol", !/-Protocol Any/.test(script)],
    ["the rule is not enabled", !/-Enabled True/.test(script)],
    ["the rule is not on a program path", !/-Program \$path/.test(script)],
    ["the binaries are not discovered recursively, so the versioned folders' copies are missed", !/Get-ChildItem -LiteralPath \$Dir -Recurse -File/.test(script)],
    ["a renamed binary is not found by its suffix and blocked at its original path",
      !/\$f\.Name\.EndsWith\(\$Suffix\)/.test(script) || !/\$f\.FullName\.Substring\(0, \$f\.FullName\.Length - \$Suffix\.Length\)/.test(script)],
    ["only updater images get a rule", !/\(Split-Path -Leaf \$original\) -like 'MicrosoftEdgeUpdate\*\.exe'/.test(script)],
    ["the root image is not always included", !/\$paths = @\(\$Root\)/.test(script) || parameters.Root !== "{{ worker_edge_updater_exe }}"],
    ["one rule per path is not named by its path", !/\$rule = "\$Prefix \$path"/.test(script)],
    ["a rule that is already right is rewritten on every run", !/if \(\$right\) \{ continue \}/.test(script)],
    ["a rule that is wrong is not replaced", !/\$have \| Remove-NetFirewallRule/.test(script)],
    ["the first version's root-only rule is not removed", !/Get-NetFirewallRule -DisplayName \$Prefix/.test(script)],
    ["nothing is written under --check", !/if \(-not \$Ansible\.CheckMode\) \{\s+if \(\$have\.Count -gt 0\)/.test(script)],
    ["the defaults do not name the updater's image", !defaults.includes(`worker_edge_updater_exe: '${UPDATER_EXE}'`)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([message]) => message);
}

/** What is wrong with the read-back's firewall half, as a list. */
function readBackViolations(script: string): string[] {
  const checks: Array<[string, boolean]> = [
    ["the read-back does not look at the firewall", !/Get-NetFirewallRule -DisplayName "\$Prefix \$path"/.test(script)],
    ["a frozen binary with no rule is not refused", !/return "no enabled outbound block rule for \$path"/.test(script)],
    ["the read-back does not require the rule enabled", !/\$rule\[0\]\.Enabled -eq 'True'/.test(script)],
    ["the read-back does not require the rule outbound", !/\$rule\[0\]\.Direction -eq 'Outbound'/.test(script)],
    ["the read-back does not require the rule to block", !/\$rule\[0\]\.Action -eq 'Block'/.test(script)],
    ["the read-back does not require the rule on exactly that program", !/\(\$rule\[0\] \| Get-NetFirewallApplicationFilter\)\.Program -eq \$path/.test(script)],
    ["the read-back accepts two rules for one path", !/\$rule\.Count -eq 1/.test(script)],
    ["the read-back does not require a rule for the root image whether or not its file is there", !/Test-BlockRule \$Root/.test(script)],
    ["the read-back is not run for each frozen binary", !/\$f\.Name -like "MicrosoftEdgeUpdate\*\.exe\$Suffix"/.test(script)],
  ];
  return checks.filter(([, wrong]) => wrong).map(([message]) => message);
}

const RULE_SCRIPT = scriptOf(FREEZE_TASKS, RULE_TASK);
const RULE_PARAMETERS = parametersOf(FREEZE_TASKS, RULE_TASK);
const READ_SCRIPT = scriptOf(FREEZE_TASKS, READ_BACK);

test("every discovered updater binary is blocked outbound on every profile, enabled", () => {
  assert.deepEqual(ruleViolations(RULE_SCRIPT, RULE_PARAMETERS, DEFAULTS), [],
    "without it an Edge install that re-registers the updater leaves nothing between the updater and the network (A11-183)");
});

test("control: each property of the rule removed FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["-Direction Outbound", "-Direction Inbound", "not outbound"],
    ["-Action Block", "-Action Allow", "does not block"],
    ["-Profile Any", "-Profile Domain", "not on every profile"],
    ["-Protocol Any", "-Protocol TCP", "every protocol"],
    ["-Enabled True", "-Enabled False", "not enabled"],
    ["-Program $path", "-Program $Root", "not on a program path"],
    ["Get-ChildItem -LiteralPath $Dir -Recurse -File", "Get-ChildItem -LiteralPath $Dir -File", "discovered recursively"],
    ["$f.Name.EndsWith($Suffix)", "$false", "found by its suffix"],
    ["(Split-Path -Leaf $original) -like 'MicrosoftEdgeUpdate*.exe'", "$true", "only updater images"],
    ["$paths = @($Root)", "$paths = @()", "root image is not always included"],
    ["if ($right) { continue }", "", "rewritten on every run"],
    ["$have | Remove-NetFirewallRule", "$null", "not replaced"],
    ["Get-NetFirewallRule -DisplayName $Prefix ", "Get-NetFirewallRule -DisplayName $Other ", "root-only rule is not removed"],
  ];
  for (const [from, to, expected] of cases) {
    assert.ok(RULE_SCRIPT.includes(from), `"${from}" is not in the rule script, so the control mutates nothing`);
    assert.match(ruleViolations(RULE_SCRIPT.replace(from, to), RULE_PARAMETERS, DEFAULTS).join("|"), new RegExp(expected), `${from} mutated was not noticed`);
  }
  assert.match(ruleViolations(RULE_SCRIPT, RULE_PARAMETERS, DEFAULTS.replace(UPDATER_EXE, "C:\\Elsewhere\\MicrosoftEdgeUpdate.exe")).join("|"), /defaults do not name/);
  assert.match(ruleViolations(RULE_SCRIPT, { ...RULE_PARAMETERS, Root: "C:\\Other.exe" }, DEFAULTS).join("|"), /root image is not always included/);
});

test("the freeze's read-back refuses a frozen binary that has no enabled outbound block rule", () => {
  assert.deepEqual(readBackViolations(READ_SCRIPT), []);
});

test("control: a read-back that stops checking any of those FAILS", () => {
  const cases: Array<[string, string, string]> = [
    ["return \"no enabled outbound block rule for $path\"", "return $null", "with no rule is not refused"],
    ["$rule[0].Enabled -eq 'True'", "$true", "require the rule enabled"],
    ["$rule[0].Direction -eq 'Outbound'", "$true", "require the rule outbound"],
    ["$rule[0].Action -eq 'Block'", "$true", "require the rule to block"],
    ["($rule[0] | Get-NetFirewallApplicationFilter).Program -eq $path", "$true", "exactly that program"],
    ["$rule.Count -eq 1", "$rule.Count -ge 1", "two rules for one path"],
    ["$wrong += @(Test-BlockRule $Root)", "", "root image whether or not its file is there"],
    ["Get-NetFirewallRule -DisplayName \"$Prefix $path\"", "Get-NetFirewallRule -DisplayName x", "does not look at the firewall"],
  ];
  for (const [from, to, expected] of cases) {
    assert.ok(READ_SCRIPT.includes(from), `"${from}" is not in the read-back, so the control mutates nothing`);
    assert.match(readBackViolations(READ_SCRIPT.replace(from, to)).join("|"), new RegExp(expected), `${from} mutated was not noticed`);
  }
});

test("the rule is laid by the freeze, which runs on every provision and daily, and no longer by firewall.yml", () => {
  assert.doesNotMatch(FIREWALL.replace(/^\s*#.*$/gm, ""), /Edge updater|worker_edge_updater_exe|win_firewall_rule:\n\s+name: "a11ign block/, "firewall.yml keeps the worker's own inbound rules only");
  assert.ok(FREEZE_TEXT.includes(`- name: ${RULE_TASK}`));
  assert.ok(FREEZE_TASKS.some((task) => String(task.name).startsWith(RULE_TASK)));
});

test("the block does not stand in the role's way: Edge is installed from a downloaded MSI, never through the updater", () => {
  assert.match(EDGE_VERSION, /ansible\.windows\.win_get_url:/);
  assert.match(EDGE_VERSION, /ansible\.windows\.win_package:/);
  assert.doesNotMatch(EDGE_VERSION.replace(/^\s*#.*$/gm, ""), /MicrosoftEdgeUpdate\.exe['"]?\s+\/(ua|install|update)/, "no task runs the updater to install or update Edge");
});
