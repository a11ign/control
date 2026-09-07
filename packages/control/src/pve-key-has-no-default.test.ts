/**
 * Does anything supply a default for `A11Y_PVE_KEY` — in ANY spelling, JS or Jinja?
 *
 * ## The gap this closes, #255
 *
 * #85 removed the hardcoded control-plane key filename from the two `.mjs` call sites and left the
 * identical fallback live in Ansible. `control-plane-host.test.ts` pins `/A11Y_PVE_KEY\s*\|\|/` against
 * those `.mjs` files — the JS spelling — and a Jinja `| default('~/.ssh/a11y-pve_ed25519', true)` is not
 * that shape, so the guard structurally could not see it. Two files in the same package went on supplying
 * a default while `packages/control/README.md` said the variable was REQUIRED.
 *
 * **The policy and the configuration disagreed, and the configuration wins for anyone running a
 * playbook.** It is also a real key filename in a repository meant to be generic — the exposure #83 closed
 * for source comments, surviving in a file type that sweep did not read.
 *
 * A guard that reaches one of several spellings of the same fact is this repo's most-named shape, and
 * that guard's own comment named these two files as the follow-up. This is the follow-up.
 *
 * ## Why the assert, and not `| mandatory`
 *
 * `lookup('env', 'X') | mandatory` passes an unset variable through as an EMPTY STRING rather than
 * raising, because the lookup returns `''` and never Ansible's `Undefined`, which is what `mandatory`
 * tests. Verified by running it (#248's commit message records the method). The one-word fix produces a
 * guard that silently permits exactly what it was added to refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));

/** Every `.yml` under `ansible/`, discovered — a hand-listed pair is how the first half was missed. */
function ansibleFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".yml")) out.push({ path: `${prefix}${e.name}`, text: readFileSync(join(dir, e.name), "utf8") });
    }
  };
  walk(ANSIBLE, "");
  return out;
}

/** Comment lines stripped, so a comment EXPLAINING the forbidden spelling does not read as one. */
const code = (text: string) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("no Ansible file supplies a default for A11Y_PVE_KEY", () => {
  const files = ansibleFiles();
  // A discovery that finds nothing passes having examined nothing — this repo's own rule, and the reason
  // the first half of #85 could look complete.
  assert.ok(files.length >= 10, `only ${files.length} ansible file(s) discovered; the walk has broken`);
  // A NON-EMPTY default is the exposure, not `| default(` itself. `require-control-plane-key.yml`
  // legitimately writes `lookup('env','A11Y_PVE_KEY') | default('', true)` to make the length check safe
  // in the very case it is guarding — an empty string is the absence, spelled so Jinja can measure it.
  // The first version of this test forbade the operator outright and failed on its own refusal file,
  // which is the right kind of failure to have had: a guard whose rule was wider than its reason.
  const offenders = files
    .filter(({ text }) => /A11Y_PVE_KEY[^\n]*\|\s*default\s*\(\s*(['"])(?!\1)/.test(code(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [],
    "these supply a default for a variable `packages/control/README.md` says is REQUIRED, in the Jinja "
    + "spelling `control-plane-host.test.ts` cannot see. A real key filename in a generic repository is "
    + "somebody's infrastructure written down.");
});

test("and no Ansible file names the key filename at all, in any construction", () => {
  // Broader than the `| default(` shape on purpose: the FILENAME is the exposure, and a future author
  // could reintroduce it through `set_fact`, a `vars:` block or a literal `-i` argument without ever
  // writing `| default(`. #83's guard covers source comments; this covers the Ansible layer.
  const offenders = ansibleFiles()
    .filter(({ text }) => /a11y-pve[_-]ed25519/.test(code(text)))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [], "the control-plane key filename must not appear in any playbook");
});

test("every playbook that connects to a11y_lab or a11y_hypervisor asserts the key FIRST", () => {
  // The assert must run on `localhost` before the connecting play: `ansible_ssh_private_key_file` is read
  // at connection time, so an assert inside that play arrives after the failure it exists to explain —
  // surfacing as an SSH auth error naming a key path nobody set.
  assert.ok(existsSync(join(ANSIBLE, "tasks/require-control-plane-key.yml")),
    "the refusal lives in one file so six playbooks cannot drift about what it says");
  for (const { path, text } of ansibleFiles()) {
    const src = code(text);
    if (!/hosts:\s*(a11y_lab|a11y_hypervisor)\b/.test(src)) continue;
    assert.match(src, /include_tasks:\s*tasks\/require-control-plane-key\.yml/,
      `${path} connects to the control plane or the lab and never asserts the key is set, so a missing `
      + "A11Y_PVE_KEY reaches the SSH layer instead of a sentence naming what to set");
    // BEFORE, not merely present. Position is the property here, exactly as it was for the reset in
    // `navigateExisting`: a correct assert placed after the connecting play cannot act.
    assert.ok(src.indexOf("require-control-plane-key.yml") < src.search(/hosts:\s*(a11y_lab|a11y_hypervisor)\b/),
      `${path} asserts the key AFTER the play that connects, which is too late to produce the message`);
  }
});
