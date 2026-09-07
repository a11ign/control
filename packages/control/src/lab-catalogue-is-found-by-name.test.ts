/**
 * Does anything in `ansible/` still find the job catalogue by WHERE IT SITS rather than by WHAT IT IS?
 *
 * ## The incident this pins, 2026-09-06
 *
 * `lab-job.yml` defines `lab_jobs`, and four other places re-read that file to check a job name against
 * it. All five spelled the lookup `(lookup('file', ...) | from_yaml)[0].vars.lab_jobs` — indexing the
 * PLAYS BY POSITION.
 *
 * Adding the zero-host inventory refusal to the top of every `lab-*.yml` — a `hosts: localhost` play, so
 * that an empty inventory could never read as success — made that new play `[0]`. It has no `vars`, so
 * every one of the five became `object of type 'dict' has no attribute 'vars'`, and `lab:log`,
 * `lab:status` and `lab:stop` all refused before doing anything. Those are the three commands you reach
 * for WHEN SOMETHING HAS ALREADY GONE WRONG, and the refusal named a Jinja attribute error, which reads
 * as a corrupted catalogue rather than as a moved play.
 *
 * ## Why a test rather than care
 *
 * The same session had ALREADY fixed exactly this defect in three tests — `lab-job.test.ts`,
 * `trainer-callers.test.ts` and `gate-partial-corpus-contract.test.ts` — re-keying each from `[0]` onto
 * `vars.lab_jobs`. The remedy reached the tests and never reached the playbooks the tests were written
 * about: this repo's most expensive recurring shape, committed inside the fix for it.
 *
 * CLAUDE.md's own words: "A position is a convention nobody wrote down; a name is a fact." A rule that
 * asks a human to remember something is a rule that gets broken, so it is asserted here instead.
 *
 * The check is deliberately a GREP over the real playbooks rather than a YAML parse. `packages/control`
 * carries no dependencies by design (ADR 0012, pinned by `control-has-no-dependencies.test.ts`), so there
 * is no YAML parser here — and the thing being forbidden is a SPELLING, which text is the right instrument
 * for. Mutation-checked by restoring the old expression in one file and watching this fail.
 *
 * COMMENT LINES ARE STRIPPED FIRST, and that is not a convenience. On its first run this test failed on
 * `vars/lab-catalogue.yml` — the file written to END the defect, which necessarily QUOTES the forbidden
 * spelling in the comment explaining it. A check that cannot tell code from the prose describing it would
 * make documenting a defect impossible, so the right answer is to test what Ansible executes rather than
 * to exempt the file and lose the check on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));

/**
 * A playbook with its whole-line comments removed, so these checks read what Ansible RUNS.
 *
 * Only lines whose first non-space character is `#` — deliberately not a general YAML comment stripper,
 * which would have to know about quoting. A trailing `# ...` on a real line is left alone: it cannot
 * introduce the expression being forbidden without the line also containing it in earnest.
 */
function code(text: string): string {
  return text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}

/** Every `.yml` under `ansible/`, including `tasks/` and `vars/`, DISCOVERED rather than listed. */
function playbooks(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".yml")) {
        out.push({ path: `${prefix}${entry.name}`, text: code(readFileSync(join(dir, entry.name), "utf8")) });
      }
    }
  };
  walk(ANSIBLE, "");
  return out;
}

test("nothing indexes a playbook's plays by position to reach its vars", () => {
  // The literal shape that broke: any `[<digit>]` applied to a `from_yaml` result, and any `[<digit>].vars`
  // however it was spelled. Both, because the first is the mechanism and the second is the consequence,
  // and a future copy could arrive by either door.
  const byPosition = /from_yaml\s*\)\s*\[\s*\d+\s*\]|\[\s*\d+\s*\]\s*\.\s*vars\b/;
  const offenders = playbooks()
    .filter(({ text }) => byPosition.test(text))
    .map(({ path }) => path);
  assert.deepEqual(offenders, [],
    "These read a playbook's plays by POSITION. A play inserted above them silently moves the catalogue "
    + "and the failure reads as a corrupted file rather than as a moved play — measured 2026-09-06, when "
    + "one added play broke lab:log, lab:status and lab:stop at once. Select the play by an attribute it "
    + "must have (see ansible/vars/lab-catalogue.yml), never by its index.");
});

test("the shared catalogue lookup exists, and every reader of lab_jobs goes through it", () => {
  const files = playbooks();
  const shared = files.find(({ path }) => path === "vars/lab-catalogue.yml");
  assert.ok(shared, "ansible/vars/lab-catalogue.yml is the one place the catalogue is located from.");
  assert.match(shared.text, /selectattr\(\s*'vars\.lab_jobs'\s*,\s*'defined'\s*\)/,
    "It must select the play by the attribute that DEFINES the catalogue, which is what makes it "
    + "position-independent.");

  // Any OTHER file that re-reads lab-job.yml must do it through the shared var. `lab-job.yml` is the
  // file that defines the catalogue, so it is allowed to mention its own name for other reasons; what
  // nothing may do is spell the lookup a second time.
  const respelled = files
    .filter(({ path }) => path !== "vars/lab-catalogue.yml")
    .filter(({ text }) => /from_yaml[\s\S]{0,80}lab_jobs/.test(text))
    .map(({ path }) => path);
  assert.deepEqual(respelled, [],
    "A second spelling of the catalogue lookup is the 'fact stated twice' shape: five copies of it broke "
    + "together on 2026-09-06 because nothing could compare them. Use `lab_catalogue` via "
    + "`vars_files: [vars/lab-catalogue.yml]`.");
});

test("every playbook that uses lab_catalogue actually loads it", () => {
  for (const { path, text } of playbooks()) {
    if (path === "vars/lab-catalogue.yml") continue;
    if (!/\blab_catalogue\b/.test(text)) continue;
    assert.match(text, /vars_files:\s*\n\s*-\s*vars\/lab-catalogue\.yml/,
      `${path} uses lab_catalogue and never loads it. An undefined var here fails at RENDER time, deep `
      + "inside a play, which is exactly the late and unreadable failure this whole file exists to end.");
  }
});
