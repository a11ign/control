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

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

test("the tests run on rstest through @a11ign/toolchain's config, and no `tsx --test` is left (ADR 0043, a11ign/a11ign#3960)", () => {
  assert.match(manifest.scripts.test, /^rstest run --config scripts\/rstest\/rstest\.config\.mjs$/, "positive control: the test script is found");
  assert.ok(manifest.devDependencies["@a11ign/toolchain"] && manifest.devDependencies["@rstest/core"], "both are devDependencies");
  assert.match(readFileSync(new URL("./rstest/rstest.config.mjs", import.meta.url), "utf8"), /defineToolchainConfig\(/, "the config is a call into the toolchain");
  for (const [where, text] of [["package.json", JSON.stringify(manifest.scripts)], ["ci.yml", ci]] as const) assert.doesNotMatch(text, /tsx --test/, where);
});

test("`tsc --noEmit` is a step of the job the ruleset requires, and runs before this repository's tests", () => {
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit", "positive control: the script is found");
  const typecheck = ci.indexOf("run: pnpm run typecheck");
  assert.ok(typecheck > 0, "gate runs the typecheck");
  assert.ok(typecheck < ci.indexOf("run: pnpm test"), "typecheck first, so a type error reads red without waiting for the suite");
  assert.ok(ci.indexOf("  gate:") < typecheck, "in the `gate` job: it is the only job this file has");
  assert.equal(ci.match(/^ {2}[a-z-]+:$/gm)?.filter((line) => line.trim() !== "pull_request:" && line.trim() !== "merge_group:").length, 1, "gate is the only job");
});
