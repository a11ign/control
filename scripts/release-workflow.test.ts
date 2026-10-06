import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeOf, workflowCode } from "./workflow-code.ts";

const release = workflowCode("release.yml");

test("a release is a tag and nothing else: no registry, no OIDC, no stored token, no manual trigger", () => {
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]$/m, "positive control: the trigger block is found and is a push to main");
  for (const forbidden of [/workflow_dispatch/, /id-token/, /npm publish/, /NODE_AUTH_TOKEN/, /NPM_TOKEN/, /pull-requests: write/]) {
    assert.doesNotMatch(release, forbidden);
  }
});

test("the tag is cut only after ci.yml's gate succeeded on the exact sha, and is never forced", () => {
  assert.match(release, /^ {4}needs: \[gate\]$/m);
  assert.match(release, /check_name=gate/);
  assert.match(release, /success\) exit 0 ;;/);
  assert.match(release, /git push origin "HEAD:refs\/tags\/\$TAG"/, "positive control: the push of the tag is found");
  assert.doesNotMatch(release, /git push[^\n]*(--force|-f\b|\+HEAD)/);
});

test("the version and the notes are read from the package, not from a root manifest that has no version", () => {
  assert.match(release, /packages\/control\/package\.json/);
  assert.match(release, /packages\/control\/CHANGELOG\.md/);
  assert.doesNotMatch(release, /readFileSync\('package\.json'/);
});

test("before the first tag a push is a notice and releases nothing, so the merge that adds the workflow is not red", () => {
  const noTag = release.slice(release.indexOf('if [ -z "$last" ]'), release.indexOf("git diff --name-only"));
  assert.match(noTag, /echo "count=0" >> "\$GITHUB_OUTPUT"/);
  assert.match(noTag, /exit 0/);
  assert.doesNotMatch(noTag, /exit 1/);
});

/** The commands of the release commit's step that set the version, dedented, which end where the changelog is taken from the tag. */
function versionCommands(): string {
  const step = release.slice(release.indexOf("The release commit"));
  const body = step.slice(step.indexOf("run: |\n") + "run: |\n".length, step.indexOf('git show "$LAST:'));
  return body.replace(/^ {10}/gm, "");
}

function runVersionStep(manifest: string): { status: number | null; after: string } {
  const dir = mkdtempSync(join(tmpdir(), "release-step-"));
  mkdirSync(join(dir, "packages/control"), { recursive: true });
  const file = join(dir, "packages/control/package.json");
  writeFileSync(file, manifest);
  const { status } = spawnSync("bash", ["-e", "-c", versionCommands()], { cwd: dir, env: { ...process.env, LAST: "v9.9.9" } });
  return { status, after: readFileSync(file, "utf8") };
}

const MANIFEST = [
  "{",
  '  "name": "@a11ign/control",',
  '  "version": "0.1.0",',
  '  "private": true,',
  '  "description": "Dependency-free \\u2014 see ADR 0012.",',
  '  "files": ["src", "a",   "b"]',
  "}",
  "",
].join("\n");

test("the step that sets the version changes the version line and no other byte of the manifest (v0.1.1 differed on its description too)", () => {
  assert.match(MANIFEST, /\\u2014/, "positive control: the manifest holds a unicode escape, which a parse and rewrite turns into the character");
  assert.match(versionCommands(), /packages\/control\/package\.json/, "positive control: the step's commands are found");
  const { status, after } = runVersionStep(MANIFEST);
  assert.equal(status, 0);
  const before = MANIFEST.split("\n");
  const changed = after.split("\n").flatMap((line, i) => (line === before[i] ? [] : [line]));
  assert.deepEqual(changed, ['  "version": "9.9.9",']);
  assert.equal(after.split("\n").length, before.length);
});

test("a manifest whose version line is not in the form the step rewrites fails the step instead of leaving the old version", () => {
  const { status } = runVersionStep(MANIFEST.replace('  "version": "0.1.0",', '    "version": "0.1.0",'));
  assert.notEqual(status, 0);
});

test("codeOf drops a comment that mentions the trigger", () => {
  assert.doesNotMatch(codeOf("# workflow_dispatch\non:\n  push:\n"), /workflow_dispatch/);
});
