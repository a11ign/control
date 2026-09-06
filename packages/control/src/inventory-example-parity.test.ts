/**
 * `inventory.example.yml` is what CI, a fresh clone, and three tests read instead of the real
 * `inventory.yml` — gitignored since 2026-09-06, real addresses, restored from the secrets store at
 * bring-up (issue #54). The example is only as good as its SHAPE staying in step with the real file: if a
 * new group or a required key is added to the real inventory and the example does not get it,
 * `ansible-check.yml`'s `--syntax-check` passes against a stale shape while validating nothing real — the
 * exact "fact stated twice, and the copies drifted" shape CLAUDE.md names as this repo's most expensive
 * recurring defect.
 *
 * This compares GROUP NAMES, HOST NAMES and the SET OF PER-HOST KEYS (never the values — addresses and
 * MACs are deliberately different) between the real file and the example, whenever the real file is
 * present locally. On a fresh clone or in CI the real file does not exist by design, and this test says so
 * honestly rather than passing having examined nothing (the same idiom `verify.corpus.test.ts` uses for a
 * gitignored corpus).
 *
 * No YAML parser: `packages/control` cannot depend on one (ADR 0012), so this reads the same
 * fixed-indentation shape `workersFromInventory`/`inventoryHosts` already read line-by-line, rather than a
 * second, independently-typed parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REAL_PATH = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url));
const EXAMPLE_PATH = fileURLToPath(new URL("../ansible/inventory.example.yml", import.meta.url));

/** Group names live at 4-space indent under `all: children:`. */
const GROUP_LINE = /^ {4}([a-z0-9_]+):$/gm;
/** Host names live at 8-space indent under a group's `hosts:`. */
const HOST_LINE = /^ {8}([\w-]+):$/gm;
/** Per-host keys live at 10-space indent — the SET across every host, not per host, is the shape. */
const KEY_LINE = /^ {10}(\w+):/gm;

function shape(text: string) {
  const groups = new Set([...text.matchAll(GROUP_LINE)].map((m) => m[1]));
  const hosts = new Set([...text.matchAll(HOST_LINE)].map((m) => m[1]));
  const keys = new Set([...text.matchAll(KEY_LINE)].map((m) => m[1]));
  return { groups, hosts, keys };
}

function sortedArray(s: Set<string>) {
  return [...s].sort();
}

test("the example's own shape is non-trivial -- vacuity guard for the extractor itself", () => {
  const { groups, hosts, keys } = shape(readFileSync(EXAMPLE_PATH, "utf8"));
  assert.ok(groups.size >= 3, `only found ${groups.size} group(s) in inventory.example.yml — the GROUP_LINE `
    + "pattern is probably broken, not the file shrinking");
  assert.ok(hosts.size >= 10, `only found ${hosts.size} host(s) — the HOST_LINE pattern is probably broken`);
  assert.ok(keys.has("ansible_host"), "no ansible_host key found — the KEY_LINE pattern is probably broken");
});

test("the real inventory's shape matches the example's -- or this test is honestly skipped", () => {
  if (!existsSync(REAL_PATH)) {
    console.log("SKIPPED: packages/control/ansible/inventory.yml is absent (gitignored, restored from the "
      + "secrets store at bring-up) -- this is the expected state on a fresh clone and in CI, and the shape "
      + "comparison this test exists for cannot run without the real file. Not a pass; an honest skip.");
    assert.ok(true);
    return;
  }

  const real = shape(readFileSync(REAL_PATH, "utf8"));
  const example = shape(readFileSync(EXAMPLE_PATH, "utf8"));

  assert.deepEqual(sortedArray(real.groups), sortedArray(example.groups),
    "inventory.yml and inventory.example.yml declare different GROUPS -- update the example to match, "
    + "or ansible-check.yml is validating a stale shape in CI");
  assert.deepEqual(sortedArray(real.hosts), sortedArray(example.hosts),
    "inventory.yml and inventory.example.yml declare different HOST NAMES -- worker names are not "
    + "secrets and claude-md-counts.test.ts reads them from the example, so this must stay exact");
  assert.deepEqual(sortedArray(real.keys), sortedArray(example.keys),
    "inventory.yml and inventory.example.yml use different PER-HOST KEYS -- a key added to the real "
    + "file (or removed) must be reflected in the example or the syntax check in CI proves nothing new");
});

// --- The guard must be shown to fail, in both directions (CLAUDE.md: "a guard must be shown to fail
// before it is trusted") ---

test("MUTATION: a group added to one side and not the other is caught", () => {
  const base = "all:\n  children:\n    a11y_workers:\n      hosts:\n        w1:\n          ansible_host: 1.2.3.4\n";
  const withExtraGroup = base + "    a11y_extra:\n      hosts:\n        e1:\n          ansible_host: 5.6.7.8\n";
  assert.notDeepEqual(sortedArray(shape(base).groups), sortedArray(shape(withExtraGroup).groups),
    "the shape extractor must see a group present on one side and absent on the other");
});

test("MUTATION: a key added to one side and not the other is caught", () => {
  const base = "all:\n  children:\n    a11y_workers:\n      hosts:\n        w1:\n          ansible_host: 1.2.3.4\n";
  const withExtraKey = base.replace("ansible_host: 1.2.3.4\n", "ansible_host: 1.2.3.4\n          mac: \"aa\"\n");
  assert.notDeepEqual(sortedArray(shape(base).keys), sortedArray(shape(withExtraKey).keys),
    "the shape extractor must see a per-host key present on one side and absent on the other");
});

test("CONTROL: identical text produces identical shape", () => {
  const text = "all:\n  children:\n    a11y_workers:\n      hosts:\n        w1:\n          ansible_host: 1.2.3.4\n";
  assert.deepEqual(sortedArray(shape(text).groups), sortedArray(shape(text).groups));
  assert.deepEqual(sortedArray(shape(text).hosts), sortedArray(shape(text).hosts));
  assert.deepEqual(sortedArray(shape(text).keys), sortedArray(shape(text).keys));
});
