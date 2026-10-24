/**
 * EVERY COLLECTION THE PLAYBOOKS NEED COMES FROM ITS GITHUB REPOSITORY AT AN EXACT TAG (A11-210).
 *
 * Ansible Galaxy's artifact downloads returned HTTP 500 for every version on 2026-10-24 while its index answered 200, and every pull request's `ansible` job failed with it. A `>=` range
 * also installs whatever Galaxy calls newest that day, which is how a pin moves without anyone deciding it (A11-205). So `ansible/requirements.yml` names, for each collection, `type: git`,
 * the repository and a release tag, and this test is what keeps a Galaxy entry or a range from coming back.
 *
 * It reads the file with `yaml`, as `node-pin-parity.test.ts` does, so it runs in the core's lay (`ci.yml`'s `checks`), which has a parser; this repository's own install has none.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const requirementsText = readFileSync(new URL("../ansible/requirements.yml", import.meta.url), "utf8");
const readmeText = readFileSync(new URL("../ansible/README.md", import.meta.url), "utf8");

type Entry = Record<string, unknown>;
const collections = ((parse(requirementsText) as { collections?: Entry[] }).collections ?? []) as Entry[];

/** The install command as the header of requirements.yml writes it: the one line that starts `ansible-galaxy collection install`. */
const installCommand = (text: string): string | undefined => /^\s*(?:#\s+)?(ansible-galaxy collection install [^#\n]*?)\s*(?:#.*)?$/m.exec(text)?.[1];

test("positive control: the file's top-level key is `collections`, and the four collections the playbooks import are in it", () => {
  assert.ok(Array.isArray((parse(requirementsText) as { collections?: unknown }).collections), "`collections` is a list");
  const names = collections.map((entry) => entry.name);
  for (const imported of ["ansible.windows", "community.windows", "community.general", "ansible.posix"]) assert.ok(names.includes(imported), `${imported} is listed`);
});

test("every collection is `type: git`", () => {
  for (const entry of collections) assert.equal(entry.type, "git", `${String(entry.name)}`);
});

test("every collection's source is a repository under github.com/ansible-collections, and no entry names a Galaxy server", () => {
  // Not derived from `name`: community.library_inventory_filtering_v1's repository has no `_v1`.
  for (const entry of collections) {
    assert.match(String(entry.source), /^https:\/\/github\.com\/ansible-collections\/[A-Za-z0-9_.-]+\.git$/, `${String(entry.name)}`);
    assert.doesNotMatch(String(entry.source), /galaxy/i, `${String(entry.name)}: no Galaxy host`);
    assert.equal("server" in entry, false, `${String(entry.name)}: no \`server\``);
  }
});

test("every collection's version is an exact tag: a string of three numbers, with no range operator and no branch name", () => {
  for (const entry of collections) {
    assert.equal(typeof entry.version, "string", `${String(entry.name)}: a quoted string`);
    assert.match(String(entry.version), /^\d+\.\d+\.\d+$/, `${String(entry.name)}`);
  }
});

test("the control plane installs with the command the header documents, and the README documents the same one, over this file", () => {
  const header = installCommand(requirementsText);
  const readme = installCommand(readmeText);
  assert.ok(header, "positive control: the header's command is found");
  assert.equal(readme, header, "README and header agree");
  assert.match(header, /-r requirements\.yml/, "it reads this file");
  assert.match(header, /-p ~\/\.ansible\/collections/, "the -p that keeps third-party collections out of git");
});

test("the header says why the source is git", () => {
  const header = requirementsText.split("\ncollections:")[0];
  assert.match(header, /2026-10-24/);
  assert.match(header, /Galaxy/);
});
