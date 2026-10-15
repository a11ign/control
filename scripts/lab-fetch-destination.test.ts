/**
 * `lab-fetch.yml` writes the fetched artifact INSIDE the control checkout that is running it (a11ign/a11ign#5521).
 *
 * Its destination is `{{ playbook_dir }}/../runs/fetched/`. `playbook_dir` is `ansible/`, so one `..` is the checkout root. The
 * previous `../../../` was the core's root when control lived at `packages/control/ansible`; here it climbs out of every checkout
 * and onto `/`, so a fetch that succeeded (`failed=0`) left a 13 MB archive at `/runs/fetched/` and the nightly release read it from
 * somewhere else. A destination that leaves the checkout is refused by `resolvedInside`, and the old expression is pinned as refused
 * so the check is shown to be able to say no.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ANSIBLE = fileURLToPath(new URL("../ansible/", import.meta.url));
const PLAYBOOK = readFileSync(new URL("../ansible/lab-fetch.yml", import.meta.url), "utf8");

/** The destination's directory part, relative to `playbook_dir`, as the playbook writes it. */
const DESTINATION = /\{\{ playbook_dir \}\}\/((?:\.\.\/)+runs\/fetched)\//;

/** Whether a `playbook_dir`-relative path lands inside the checkout root, with `playbook_dir` resolved to `ansible/`. */
function resolvedInside(relativeToPlaybook: string): boolean {
  const rel = relative(ROOT, resolve(ANSIBLE, relativeToPlaybook));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

test("the fetch destination is named in the playbook, so the check below has something to read", () => {
  assert.notEqual(PLAYBOOK.match(DESTINATION), null);
});

test("the fetch destination resolves to runs/fetched under this checkout's root, not above it", () => {
  const [, relativeToPlaybook] = PLAYBOOK.match(DESTINATION) ?? [];
  assert.equal(resolvedInside(relativeToPlaybook ?? ""), true);
  assert.equal(relative(ROOT, resolve(ANSIBLE, relativeToPlaybook ?? "")), "runs/fetched");
});

test("positive control: the expression that wrote to / is refused", () => {
  assert.equal(resolvedInside("../../../runs/fetched"), false);
});
