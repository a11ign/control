import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ANSIBLE = join(import.meta.dirname, "../ansible");
const DEPLOY = readFileSync(join(ANSIBLE, "deploy.yml"), "utf8");

/**
 * #5532: `a11y_repo_root` was `playbook_dir/../../..`, right while the playbook lived at
 * `packages/control/ansible/` and `/` once control became its own repository root (#4217), so the first
 * task of `fleet:deploy` ran `chdir: /` and failed with ERR_MODULE_NOT_FOUND.
 */
function rootExpression(): string {
  const m = DEPLOY.match(/a11y_repo_root: "\{\{ playbook_dir \}\}((?:\/\.\.)+)"/);
  assert.ok(m, "deploy.yml must define a11y_repo_root as playbook_dir plus ../ steps");
  return m[1];
}

test("a11y_repo_root resolves to the directory holding package.json", () => {
  const root = resolve(ANSIBLE + rootExpression());
  assert.equal(root, resolve(import.meta.dirname, ".."));
  assert.ok(existsSync(join(root, "package.json")));
});

test("the import the first task runs exists beneath that root", () => {
  const m = DEPLOY.match(/import\("\.\/([^"]+layer-checkouts\.ts)"\)/);
  assert.ok(m, "deploy.yml must import layer-checkouts.ts relative to the root");
  assert.ok(existsSync(join(resolve(ANSIBLE + rootExpression()), m[1])));
});
