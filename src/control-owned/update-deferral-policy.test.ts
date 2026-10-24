// Relocated from packages/worker-fleet/src/update-deferral-policy.test.ts by #3504, and rewritten by A11-205: the deferral it pinned is gone.
/**
 * A DEFERRAL IS A DELAY, NOT A FREEZE, and A11-205 ended it.
 *
 * #921 deferred feature updates 365 days and #4438 deferred quality updates 30, so a box installed on its own once a deferral ran out: a11y-worker-4
 * (2026-09-11) and a11y-worker-3 (2026-09-19) took a feature update although `NoAutoRebootWithLoggedOnUsers` was set. The 28-day patch window existed to
 * lift the deferral before it expired. Now nothing on a box upgrades by itself (`docs/adr/0001`), the levers that stop Windows Update are in
 * `tasks/freeze.yml`, and the deferral values are DELETED from every box, not left beside the freeze.
 *
 * This file used to pin the deferral's values with literals. It now pins their absence from the role's declared values, and their deletion from the box.
 * The names are LITERALS here, not read from the role, so a change to what the role declares is what this test exists to catch (the shape
 * `worker-port.test.ts` and `edge-pin-parity.test.ts` use). Deliberately not a YAML parse: control takes no dependency (ADR 0012).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const DEFAULTS = read("../../ansible/roles/worker/defaults/main.yml");
const POLICY = read("../../ansible/roles/worker/tasks/policy.yml");
const FREEZE = read("../../ansible/roles/worker/tasks/freeze.yml");

const DEFERRAL_NAMES = ["DeferFeatureUpdates", "DeferFeatureUpdatesPeriodInDays", "DeferQualityUpdates", "DeferQualityUpdatesPeriodInDays"];
const WINDOWS_UPDATE_PATH = "{{ freeze_wu_policy }}";

/** The text with its comment lines removed: a comment may explain the deferral, and an executable line may not set it. */
const code = (text: string) => text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

/** What is wrong with where the deferral lives, as a list. Empty means no role value sets a deferral and the freeze deletes each one. */
function deferralViolations(defaults: string, policy: string, freeze: string): string[] {
  const problems: string[] = [];
  if (/^worker_update_deferral_policy:/m.test(defaults)) problems.push("the role still declares worker_update_deferral_policy");
  if (/worker_update_deferral_policy/.test(code(policy))) problems.push("policy.yml still applies or reads back worker_update_deferral_policy");
  for (const name of DEFERRAL_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(code(defaults))) problems.push(`${name} is still in defaults/main.yml`);
    const entry = code(freeze).split("\n").find((line) => new RegExp(`name: ${name},`).test(line));
    if (!entry) problems.push(`freeze.yml does not delete ${name}`);
    else if (!/state: absent/.test(entry)) problems.push(`freeze.yml sets ${name} instead of deleting it: ${entry.trim()}`);
    else if (!entry.includes(`path: '${WINDOWS_UPDATE_PATH}'`)) problems.push(`freeze.yml deletes ${name} from the wrong key: ${entry.trim()}`);
  }
  return problems;
}

test("no deferral is declared by the role, and the freeze deletes every deferral value from the box", () => {
  assert.deepEqual(deferralViolations(DEFAULTS, POLICY, FREEZE), [],
    "a deferral left on a box is a delay that expires: the box then installs on its own (#921, #4438)");
});

test("control: a deferral put back in the defaults, or applied by policy.yml, FAILS", () => {
  const declared = DEFAULTS + "\nworker_update_deferral_policy:\n  - path: 'x'\n    name: DeferQualityUpdatesPeriodInDays\n    value: 30\n";
  assert.match(deferralViolations(declared, POLICY, FREEZE).join("|"), /still declares worker_update_deferral_policy/);
  assert.match(deferralViolations(declared, POLICY, FREEZE).join("|"), /DeferQualityUpdatesPeriodInDays is still in defaults/);
  const applied = POLICY + "\n      Deferral: \"{{ worker_update_deferral_policy }}\"\n";
  assert.match(deferralViolations(DEFAULTS, applied, FREEZE).join("|"), /policy.yml still applies/);
});

test("control: a freeze that sets a deferral value, leaves one out, or deletes it from another key FAILS", () => {
  const set = FREEZE.replace("name: DeferQualityUpdates, state: absent }", "name: DeferQualityUpdates, value: 1, type: dword }");
  assert.notEqual(set, FREEZE, "the mutation changed nothing, so it controls nothing");
  assert.match(deferralViolations(DEFAULTS, POLICY, set).join("|"), /sets DeferQualityUpdates instead of deleting it/);
  const missing = FREEZE.replace(/^.*name: DeferFeatureUpdates, state: absent.*\n/m, "");
  assert.notEqual(missing, FREEZE);
  assert.match(deferralViolations(DEFAULTS, POLICY, missing).join("|"), /does not delete DeferFeatureUpdates/);
  const elsewhere = FREEZE.replace("{ path: '{{ freeze_wu_policy }}', name: DeferQualityUpdatesPeriodInDays, state: absent }", "{ path: 'HKLM:\\Other', name: DeferQualityUpdatesPeriodInDays, state: absent }");
  assert.notEqual(elsewhere, FREEZE);
  assert.match(deferralViolations(DEFAULTS, POLICY, elsewhere).join("|"), /wrong key/);
});

test("the comment in the defaults says the deferral was a delay and the freeze replaced it, and no longer says quality updates are deferred 30 days", () => {
  const start = DEFAULTS.indexOf("WINDOWS UPDATE IS NOT DEFERRED HERE ANY MORE");
  assert.ok(start !== -1, "the explanation of where the deferral went is gone from the defaults");
  const comment = DEFAULTS.slice(start, DEFAULTS.indexOf("\n\n", start));
  assert.match(comment, /a delay, not a freeze/);
  assert.match(comment, /tasks\/freeze\.yml/);
  assert.doesNotMatch(comment, /unrestricted/i);
});
