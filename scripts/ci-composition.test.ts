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

test("this repository's package replaces the core's own before anything runs, as the files the core knows it by", () => {
  const lay = ci.indexOf("rm -rf core/packages/control");
  assert.ok(lay > 0, "positive control: the laying step is found");
  assert.ok(lay < ci.indexOf("pnpm install --frozen-lockfile"), "laid before the install");
  assert.ok(lay < ci.indexOf("pnpm exec rstest run"), "laid before the tests");
  assert.match(ci, /pnpm exec eslint packages\/control/);
  assert.match(ci, /tsc --noEmit -p tsconfig\.control\.json/);
  assert.match(ci, /cp -R control\/src control\/ansible control\/layers\.json control\/CLAUDE\.md control\/README\.md core\/packages\/control\//, "the package is the root's files, not a directory of it");
  assert.match(ci, /control\/package\.json > core\/packages\/control\/package\.json/, "the laid manifest is cut from the root's");
  assert.match(ci, /> core\/tsconfig\.control\.json/, "the laid typecheck config is written, not tracked: this repository holds one tsconfig");
  assert.doesNotMatch(ci, /control\/packages\/control/, "nothing reads a `packages/control` of THIS repository");
});

test("the layout check is a step of the job `gate` waits for (ADR 0043, Decision 7; a11ign/a11ign#4217)", () => {
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["layout-check"], "layout-check", "positive control: the script is found");
  const step = ci.indexOf("run: pnpm run layout-check");
  assert.ok(step > ci.indexOf("  checks:"), "in the `checks` job");
  assert.ok(step < ci.indexOf("run: pnpm test"), "before the tests, so a layout failure reads red without waiting for them");
});

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

test("the tests run on rstest through @a11ign/toolchain's config, and no `tsx --test` is left (ADR 0043, a11ign/a11ign#3960)", () => {
  assert.match(manifest.scripts.test, /^rstest run --config scripts\/rstest\/rstest\.config\.ts$/, "positive control: the test script is found");
  assert.ok(manifest.devDependencies["@a11ign/toolchain"] && manifest.devDependencies["@rstest/core"], "both are devDependencies");
  assert.match(readFileSync(new URL("./rstest/rstest.config.ts", import.meta.url), "utf8"), /defineToolchainConfig\(/, "the config is a call into the toolchain");
  for (const [where, text] of [["package.json", JSON.stringify(manifest.scripts)], ["ci.yml", ci]] as const) assert.doesNotMatch(text, /tsx --test/, where);
});

test("`tsc --noEmit` is a step of the job the ruleset requires, and runs before this repository's tests", () => {
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit", "positive control: the script is found");
  const typecheck = ci.indexOf("run: pnpm run typecheck");
  assert.ok(typecheck > 0, "gate runs the typecheck");
  assert.ok(typecheck < ci.indexOf("run: pnpm test"), "typecheck first, so a type error reads red without waiting for the suite");
  assert.ok(ci.indexOf("  checks:") < typecheck, "in the `checks` job, which `gate` waits for");
});

test("`gate` waits for `changeset` and `checks` and accepts success only, so a red or skipped need cannot read as a pass (a11ign/a11ign#4127, #4135)", () => {
  const gate = ci.slice(ci.indexOf("  gate:"));
  assert.ok(gate.startsWith("  gate:"), "positive control: the gate job is found");
  assert.match(gate, /needs: \[changeset, checks\]/);
  assert.match(gate, /if: always\(\) && !cancelled\(\)/, "a skipped required check counts as passed, so gate must run when a need fails");
  for (const need of ["changeset", "checks"]) assert.ok(gate.includes(`needs.${need}.result`), `${need}'s result is read`);
  assert.doesNotMatch(gate, /skipped/, "no skipped allowance");
});

test("the changeset check is the shared workflow at a full sha, with this repository's releasable paths and the permission it needs (a11ign/a11ign#4127, #4135)", () => {
  const call = /^ {2}changeset:\n([\s\S]*?)\n\n/m.exec(ci)?.[1];
  assert.ok(call, "positive control: the changeset job is found");
  assert.match(call, /uses: a11ign\/toolchain\/\.github\/workflows\/changeset-required\.yml@[0-9a-f]{40}$/m);
  assert.match(call, /releasable-paths: src\/ ansible\/ layers\.json$/m, "this repository's releasable paths; the core's dora entry follows in the row after a11ign/a11ign#4217");
  assert.match(call, /pull-requests: read/, "without it the whole run is a startup_failure");
  assert.match(ci, /^ {4}types: \[opened, synchronize, reopened, edited\]$/m, "`edited`: the no-release line is added by editing the body");
});
