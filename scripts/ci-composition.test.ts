import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workflowCode } from "./workflow-code.ts";

const ci = workflowCode("ci.yml");

test("the job the protection requires exists, named `gate`, and runs on the queue's branches too", () => {
  assert.match(ci, /^ {2}gate:$/m);
  assert.match(ci, /^ {2}pull_request:$/m);
  assert.match(ci, /^ {2}merge_group:$/m);
});

test("the core is laid at a full commit sha, never a branch", () => {
  const pin = /^ {2}CORE_REF: ([^\s]+)$/m.exec(ci);
  assert.ok(pin, "positive control: the pin is found");
  assert.match(pin[1], /^[0-9a-f]{40}$/);
  assert.match(ci, /ref: "\$\{\{ env\.CORE_REF \}\}"/, "the checkout uses the pin");
});

test("this repository's package replaces the core's own before anything runs", () => {
  const lay = ci.indexOf("rm -rf core/packages/control");
  assert.ok(lay > 0, "positive control: the laying step is found");
  assert.ok(lay < ci.indexOf("pnpm install --frozen-lockfile"), "laid before the install");
  assert.ok(lay < ci.indexOf("pnpm exec rstest run"), "laid before the tests");
  assert.match(ci, /pnpm exec eslint packages\/control/);
  assert.match(ci, /tsc --noEmit -p tsconfig\.control\.json/);
});

test("the first release has a CHANGELOG entry for the version the package declares", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const { version } = JSON.parse(read("packages/control/package.json")) as { version: string };
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.match(read("packages/control/CHANGELOG.md"), new RegExp(`^## ${version.replaceAll(".", "\\.")}$`, "m"));
});
