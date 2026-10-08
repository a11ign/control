/**
 * THE ROOT MANIFEST IS THE PACKAGE (a11ign/a11ign#4217), AND IT STILL HOLDS NO DEPENDENCY.
 *
 * ADR 0012 keeps the credential that can reconfigure twelve auto-logging-in Windows boxes away from npm's transitive surface, and `src/control-has-no-dependencies.test.ts` pins that for
 * `dependencies` in the manifest CI lays at `packages/control`. That laid manifest has its `devDependencies` cut (the core's frozen lockfile cannot hold them), so the other half lives HERE, against
 * the real root manifest: the root now carries the repository's own tooling, and the control plane (a raw checkout, no `npm install`) never installs it.
 *
 * `TOOLING` names those five and nothing else. A sixth is a reviewed change to this list, not a line in `package.json` that passes unseen, which is what an emptiness assertion could not give
 * once the root stopped being empty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLayout, checkLayoutTree } from "@a11ign/toolchain/layout-check";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
};

const TOOLING = ["@a11ign/toolchain", "@changesets/cli", "@rstest/core", "@types/node", "typescript"];

/** The names `devDependencies` holds beyond the tooling this repository is allowed. */
const unlisted = (devDependencies: Record<string, string> | undefined) => Object.keys(devDependencies ?? {}).filter((name) => !TOOLING.includes(name));

test("the root manifest declares no `dependencies`, and no devDependency beyond the tooling named here", () => {
  assert.deepEqual(manifest.dependencies ?? {}, {}, "ADR 0012: nothing is installed beside the fleet key");
  assert.deepEqual(unlisted(manifest.devDependencies), []);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), [...TOOLING].sort(), "positive control: the tooling the list names is what the root declares, so the list is read against something");
});

test("a sixth devDependency is named, so the allowance cannot grow unseen", () => {
  assert.deepEqual(unlisted({ ...manifest.devDependencies, "left-pad": "^1.0.0" }), ["left-pad"]);
});

test("the root manifest is the package: its name, and the layout check clean on this tree", () => {
  assert.equal(manifest.name, "@a11ign/control");
  const verdict = checkLayout({ root: ROOT });
  assert.deepEqual(verdict.problems, [], verdict.message);
  assert.ok(verdict.fileCount > 0, "positive control: the check read files");
});

test("the layout check fails the shape this repository had (control-workspace over packages/control), so the clean verdict above is read against a defect", () => {
  const shell = checkLayoutTree({
    "package.json": JSON.stringify({ name: "control-workspace", private: true }),
    "pnpm-workspace.yaml": 'packages:\n  - "."\n  - "packages/*"\n',
    "README.md": "# control\n",
    "packages/control/package.json": JSON.stringify({ name: "@a11ign/control", private: true }),
    "packages/control/README.md": "# control\n",
  });
  assert.deepEqual(shell.problems.map((p) => p.check).sort(), ["leftover", "second-readme", "workspace-of-one"]);
});
