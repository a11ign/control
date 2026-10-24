/**
 * RENOVATE READS THE FLEET'S MANIFEST, AND HOLDS NO VERSION OF ITS OWN (A11-205).
 *
 * `renovate.json` is at this repository's root and the core's lay of the package does not carry it, so it is read here and not from `src/fleet-pins.test.ts`.
 * Renovate stays off (`enabled: false`: the dry run is the chairman's). A bump PR it opens is a pull request on `deploy-pins.json`, and merging one moves no
 * box: a box reaches a new pin only through the deliberate whole-fleet upgrade.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MANIFEST_TEXT = read("deploy-pins.json");
const MANIFEST = JSON.parse(MANIFEST_TEXT) as { edge: { version: string; msiUrl: string; msiSha256: string; }; node: { version: string; sha256: Record<string, string>; }; };
const RENOVATE_TEXT = read("renovate.json");
const RENOVATE = JSON.parse(RENOVATE_TEXT) as {
  enabled: boolean; customManagers: { managerFilePatterns: string[]; matchStrings: string[]; depNameTemplate: string; }[]; packageRules: { matchFileNames: string[]; }[];
};

/** What each manager's first pattern extracts from `text`: the current value Renovate would try to bump. */
const currentValues = (text: string) => Object.fromEntries(RENOVATE.customManagers.map((manager) =>
  [manager.depNameTemplate, new RegExp(manager.matchStrings[0]).exec(text)?.groups?.currentValue ?? null]));

test("Renovate's two managers read deploy-pins.json, and their patterns extract the manifest's current Edge and Node", () => {
  assert.deepEqual(RENOVATE.customManagers.map(({ depNameTemplate }) => depNameTemplate), ["microsoft-edge-stable", "node"]);
  for (const manager of RENOVATE.customManagers) assert.deepEqual(manager.managerFilePatterns, ["/^deploy-pins\\.json$/"]);
  assert.deepEqual(currentValues(MANIFEST_TEXT), { "microsoft-edge-stable": MANIFEST.edge.version, node: MANIFEST.node.version.replace(/^v/, "") });
});

test("the patterns are not loose: a layer's x.y.z version, the lab tag and NVDA's version are not read as Edge or Node", () => {
  const layersOnly = JSON.stringify({ layers: { "nvda-worker": { version: "0.13.13" } }, lab: { tag: "v0.1.40" }, nvda: { version: "2026.1.1" } }, null, 2);
  assert.deepEqual(currentValues(layersOnly), { "microsoft-edge-stable": null, node: null });
});

test("a bump never merges itself, and Renovate stays off", () => {
  assert.deepEqual(RENOVATE.packageRules.flatMap(({ matchFileNames }) => matchFileNames), ["deploy-pins.json"]);
  assert.equal(RENOVATE.enabled, false);
});

test("renovate.json restates none of the manifest's values, and no longer points at the role's defaults", () => {
  for (const value of [MANIFEST.edge.version, MANIFEST.edge.msiUrl, MANIFEST.edge.msiSha256, MANIFEST.node.version, ...Object.values(MANIFEST.node.sha256)]) {
    assert.equal(RENOVATE_TEXT.includes(value), false, `renovate.json carries ${value}`);
  }
  assert.equal(RENOVATE_TEXT.includes("defaults/main"), false, "the managers read the manifest, not the role");
});
