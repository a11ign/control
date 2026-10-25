/**
 * THE DEPENDABOT CONFIG IS GENERATED, AND THE FREEZE IT CARRIES IS TIED TO THE FLEET'S MANIFEST (A11-253, under A11-251).
 *
 * `.github/dependabot.yml` is the output of `dependabot-config --write` from `@a11ign/toolchain`, so the first test generates the file in memory
 * from the toolchain this repository installs and compares it with the committed one. To fix a failure run `pnpm exec dependabot-config --write`.
 *
 * The packages Dependabot must never propose are listed ONCE, in the toolchain's `FROZEN`. This repository owns the manifest they mirror, so the
 * second test fails when a `layers.*.package` of `deploy-pins.json` is not in that list: a new fleet layer is also added to `FROZEN` in
 * `a11ign/toolchain`, released, and picked up here by a toolchain bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkDependabotConfig } from "@a11ign/toolchain/dependabot-config";
import { FROZEN } from "@a11ign/toolchain/dependabot-frozen";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = JSON.parse(readFileSync(new URL("../deploy-pins.json", import.meta.url), "utf8")) as { layers: Record<string, { package: string }> };

test(".github/dependabot.yml is exactly what `dependabot-config --write` produces", () => {
  const result = checkDependabotConfig({ root: ROOT });
  assert.ok(result.ok, result.message);
});

/** The layers of the manifest whose package the toolchain does not list as frozen, named `layer: package`. */
function unfrozenLayers(): string[] {
  const frozen = new Set(FROZEN.map(({ name }) => name));
  return Object.entries(MANIFEST.layers).filter(([, { package: name }]) => !frozen.has(name)).map(([layer, { package: name }]) => `${layer}: ${name}`);
}

test("every package the fleet's pins manifest pins is frozen, so Dependabot never proposes it", () => {
  assert.deepEqual(unfrozenLayers(), [], "a layer of deploy-pins.json is not in FROZEN (@a11ign/toolchain/dependabot-frozen): add it there, release the toolchain, and bump it here");
});

/** The `/.github/actions/<name>` directory of every local composite action this repository holds. */
function localActionDirectories(): string[] {
  const actions = new URL("../.github/actions/", import.meta.url);
  return readdirSync(actions).filter((name) => existsSync(new URL(`${name}/action.yml`, actions))).map((name) => `/.github/actions/${name}`);
}

test("Dependabot reads every local composite action, whose pins (actions/cache) it updates only when the directory is named", () => {
  const written = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8").split("\n").map((line) => line.trim());
  const actions = localActionDirectories();
  assert.ok(actions.includes("/.github/actions/ansible-collections"), "positive control: the composite action this test exists for is found");
  assert.deepEqual(actions.filter((directory) => !written.includes(`- ${directory}`)), [], "a local action's directory is missing from .github/dependabot.yml");
});
