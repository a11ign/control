/**
 * THE ROOT MANIFEST IS THE PACKAGE (a11ign/a11ign#4217), AND IT DECLARES ONLY THE TWO PUBLISHED LAYERS, AT THEIR PINS (ADR 0045).
 *
 * ADR 0012 keeps the credential that can reconfigure twelve auto-logging-in Windows boxes away from npm's transitive surface. `src/control-has-no-dependencies.test.ts` pins `dependencies`
 * in the manifest CI lays at `packages/control`. That laid manifest has its `devDependencies` cut (the core's frozen lockfile cannot hold them), so the other half lives HERE, against
 * the real root manifest: the root carries the repository's own tooling, and the control plane (a raw checkout) installs only the two layers with `--prod`.
 *
 * `TOOLING` names those six and nothing else. A seventh is a reviewed change to this list, not a line in `package.json` that passes unseen, which is what an emptiness assertion could not give
 * once the root stopped being empty. `tsx` runs the test children (`tsx/esm`), so it is tooling, not a dependency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkLayout, checkLayoutTree } from "@a11ign/toolchain/layout-check";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; exports?: Record<string, string>;
};

const TOOLING = ["@a11ign/toolchain", "@changesets/cli", "@rstest/core", "@types/node", "tsx", "typescript"];

/** The two published layers at their pins: the only `dependencies` the root may declare. */
const PINNED_LAYERS = Object.fromEntries(
  Object.values((JSON.parse(readFileSync(new URL("../deploy-pins.json", import.meta.url), "utf8")) as { layers: Record<string, { package: string, version: string }> }).layers)
    .map((layer) => [layer.package, layer.version]),
);

/** The names `devDependencies` holds beyond the tooling this repository is allowed. */
const unlisted = (devDependencies: Record<string, string> | undefined) => Object.keys(devDependencies ?? {}).filter((name) => !TOOLING.includes(name));

test("the root manifest declares exactly the two published layers at their pins, and no devDependency beyond the tooling named here", () => {
  assert.deepEqual(manifest.dependencies ?? {}, PINNED_LAYERS, "ADR 0045 / ADR 0012: only the two published layers are installed beside the fleet key, at the versions deploy-pins.json pins");
  assert.deepEqual(unlisted(manifest.devDependencies), []);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), [...TOOLING].sort(), "positive control: the tooling the list names is what the root declares, so the list is read against something");
});

test("an unlisted devDependency is named, so the allowance cannot grow unseen", () => {
  assert.deepEqual(unlisted({ ...manifest.devDependencies, "left-pad": "^1.0.0" }), ["left-pad"]);
});

test("./lab-carried is exported, and the file it names carries the declarations the lab's consumer imports", () => {
  // The lab's consumer reaches the carried copy through this export, so removing the line would break it with no test failing; the file must also be the one the export names.
  assert.equal(manifest.exports?.["./lab-carried"], "./src/lab-carried.ts");
  const carried = readFileSync(new URL("../src/lab-carried.ts", import.meta.url), "utf8");
  assert.match(carried, /export function qualificationStatus\(/);
  assert.match(carried, /export type Outcome =/);
  assert.match(carried, /export type StatusPayload =/);
  assert.doesNotMatch(readFileSync(new URL("../src/post-qualification-status.ts", import.meta.url), "utf8"), /\.\.\/\.\.\/lab\//, "positive control: the poster reads the carried copy, not the lab");
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
