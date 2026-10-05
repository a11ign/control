import { test } from "node:test";
import assert from "node:assert/strict";
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

test("codeOf drops a comment that mentions the trigger", () => {
  assert.doesNotMatch(codeOf("# workflow_dispatch\non:\n  push:\n"), /workflow_dispatch/);
});
