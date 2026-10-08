import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { codeOf, workflowCode } from "./workflow-code.ts";

const release = workflowCode("release.yml");
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a release is a call to the shared per-merge workflow, pinned by full sha, and nothing here runs a step of its own", () => {
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]$/m, "positive control: the trigger block is found and is a push to main");
  assert.match(release, /^ {4}uses: a11ign\/toolchain\/\.github\/workflows\/release-per-merge\.yml@[0-9a-f]{40}$/m, "positive control: the pinned call is found");
  assert.doesNotMatch(release, /workflow_dispatch/);
  assert.doesNotMatch(release, /^ {4}steps:$/m, "the caller holds no steps: what a release does is the shared workflow's");
});

test("it releases a tag and a GitHub Release and publishes to no registry: `kind: tag`, no token, no `npm`", () => {
  assert.match(release, /^ {6}kind: tag$/m, "positive control: the kind is found");
  for (const forbidden of [/kind: npm/, /NODE_AUTH_TOKEN/, /NPM_TOKEN/, /npm publish/, /pull-requests: write/]) assert.doesNotMatch(release, forbidden);
});

test("the check it waits for is the job ci.yml names `gate`, which the ruleset requires", () => {
  assert.match(release, /^ {6}gate-check: gate$/m, "positive control: the check name is found");
  assert.match(workflowCode("ci.yml"), /^ {2}gate:$/m);
});

test("the version and the changelog are the ROOT's, which is the package itself: `kind: tag` tags the private package at the root", () => {
  const root = JSON.parse(read("package.json")) as { name?: string; version?: string; private?: boolean; description?: string };
  assert.match(root.version ?? "", /^\d+\.\d+\.\d+$/, "positive control: the root declares a version");
  assert.equal(root.private, true);
  assert.equal(root.name, "@a11ign/control", "the root manifest is the package, not a `-workspace` shell over one (a11ign/a11ign#4217)");
  assert.match(read("CHANGELOG.md"), new RegExp(`^## ${(root.version ?? "").replaceAll(".", "\\.")}$`, "m"), "the root changelog holds an entry for the version it declares");
  // The release commit's `JSON.stringify` rewrite would turn an escape in the root manifest into the character, so the tag's tree would differ from its source (v0.1.1).
  assert.doesNotMatch(read("package.json"), /\\u[0-9a-f]{4}|[^\x00-\x7f]/i, "the root manifest is ASCII");
});

test("a changeset names the root package, and none still names the shell it replaced (changesets refuses a name that is `not in the workspace`, measured on #3960)", () => {
  const named = readdirSync(new URL("../.changeset/", import.meta.url)).filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => ({ f, name: /^"([^"]+)": (?:patch|minor|major)$/m.exec(read(`.changeset/${f}`))?.[1] }));
  assert.ok(named.length > 0, "positive control: there are changesets to read");
  assert.deepEqual(named.filter(({ name }) => name !== "@a11ign/control"), [], "every changeset names @a11ign/control");
});

test("codeOf drops a comment that mentions the trigger", () => {
  assert.doesNotMatch(codeOf("# workflow_dispatch\non:\n  push:\n"), /workflow_dispatch/);
});
