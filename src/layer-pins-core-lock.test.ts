/**
 * THE LAYER VERSIONS `deploy-pins.json` NAMES ARE THE ONES THE CORE'S LOCKFILE RESOLVES AT `core.commit` (a11ign/a11ign#5546).
 *
 * A guest puts the core on `core.commit` and runs `pnpm install --frozen-lockfile` there, so the release that lands under
 * `node_modules/@a11ign/<package>` is whatever THAT commit's `pnpm-lock.yaml` resolves, and nothing else. `fleet:deploy` fetches the
 * releases `layers.<name>.version` names and compares them by `integrity` before any box is touched, and the play judges a laid tree
 * by that same version after the install. When the two numbers differ the deploy fetches and verifies one release and the guest runs
 * another, and the play's post-install assertion refuses every guest for it: the third pair of numbers the old `fail_msg` already
 * named ("bump one to match the other") and nothing machine-checked. 0.13.0/0.10.2 against the core's 0.13.1/0.11.0 was that, at `1d4c831`.
 *
 * The commit is read from the git repository this package sits in, which is the core's own checkout wherever this runs (CI lays the
 * package at `packages/control` of a checkout of the core). A checkout that does not hold the commit object is not a pass: CI's is shallow, so
 * it asks the core's remote for that one commit (`GITHUB_ACTIONS` only: a person's machine is never made to fetch), and a repository that still
 * cannot produce it SKIPS and says why. The positive controls below run everywhere and need no commit: they hold the parser and the
 * comparison to the text of the lockfile at `7e751f5`, and to the pins at `1d4c831`.
 */
import { describe, expect, test } from "@rstest/core";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "./git-safe-env.ts";
import { readDeployPins } from "./layer-pins.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FETCH_TIMEOUT_MS = 120_000;

/**
 * The versions the lockfile's ROOT importer resolves for each named package, peer suffix removed: the importer `.` is what
 * `pnpm install --frozen-lockfile` at the checkout's root installs, and it is the one whose `node_modules/@a11ign/<package>` the
 * worker runs. `null` for a package the importer does not list, never a guess from a `packages:` entry (a second version of the worker
 * sits there as the fleet's own dependency, and is not what the root resolves).
 */
function rootImporterVersions(lock: string, packages: string[]): Record<string, string | null> {
  const root = /^importers:\n(?:\n)? {2}\.:\n([\s\S]*?)(?=\n {2}\S)/m.exec(lock)?.[1] ?? "";
  return Object.fromEntries(packages.map((name) => {
    const entry = new RegExp(`^ {6}'${name.replace(/[/.]/g, "\\$&")}':\\n {8}specifier: .*\\n {8}version: ([^\\s(]+)`, "m").exec(root);
    return [name, entry?.[1] ?? null];
  }));
}

/** Each layer whose pinned version is not the lockfile's, naming both numbers; empty when they agree. */
function lockDisagreements({ layers, resolved }: {
  layers: Record<string, { package: string; version: string; }>; resolved: Record<string, string | null>;
}): string[] {
  return Object.entries(layers).flatMap(([name, layer]) => {
    const locked = resolved[layer.package];
    if (locked === layer.version) return [];
    return [`layer ${name} (${layer.package}): deploy-pins.json layers.${name}.version is ${layer.version}, the core's pnpm-lock.yaml resolves ${locked ?? "nothing"}`];
  });
}

function git(args: string[], timeout?: number) {
  const result = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", env: sandboxGitEnv(), timeout });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The core's lockfile at `commit`, or the stated reason it could not be read. A reason is never an empty string and never a pass. */
function coreLockAt({ commit, remote }: { commit: string; remote: string; }): { lock: string } | { skip: string } {
  const holds = () => git(["cat-file", "-e", `${commit}^{commit}`]).ok;
  if (!holds() && process.env.GITHUB_ACTIONS === "true") git(["fetch", "--quiet", "--depth=1", remote, commit], FETCH_TIMEOUT_MS);
  if (!holds()) return { skip: `the repository ${ROOT} is in does not hold core commit ${commit}, and asking ${remote} for it ${process.env.GITHUB_ACTIONS === "true" ? "failed" : "is done on CI only"}` };
  const shown = git(["show", `${commit}:pnpm-lock.yaml`]);
  if (!shown.ok) return { skip: `core commit ${commit} holds no pnpm-lock.yaml at its root: ${shown.stderr.trim()}` };
  return { lock: shown.stdout };
}

const WORKER = "@a11ign/screenreader-worker";
const FLEET = "@a11ign/screenreader-fleet";

/** The root importer of the core's lockfile at `7e751f5`, cut to what the parser reads. A `packages:` entry for ANOTHER worker version follows it, on purpose. */
const LOCK_AT_7E751F5 = [
  "lockfileVersion: '9.0'", "", "overrides:", `  '${WORKER}': 0.13.1`, "", "importers:", "", "  .:", "    dependencies:",
  "      '@a11ign/scorer':", "        specifier: 0.2.1", "        version: link:packages/scorer",
  `      '${FLEET}':`, "        specifier: ^0.11.0", "        version: 0.11.0(@a11ign/scorer@packages+scorer)(typescript@6.0.3)",
  `      '${WORKER}':`, "        specifier: 0.13.1", "        version: 0.13.1",
  "    devDependencies:", "      yaml:", "        specifier: ^2.9.1", "        version: 2.9.1", "",
  "  packages/guards:", "    dependencies:", `      '${WORKER}':`, "        specifier: 0.9.0", "        version: 0.9.0", "",
  "packages:", "", `  '${WORKER}@0.9.0':`, "    resolution: {integrity: sha512-x}", "",
].join("\n");

const PINS_AT_1D4C831 = {
  "nvda-worker": { package: WORKER, version: "0.13.0" },
  "screenreader-fleet": { package: FLEET, version: "0.10.2" },
};

describe("the parser and the comparison, against the lockfile's own text (no commit needed)", () => {
  test("POSITIVE CONTROL: the root importer's versions are read, peer suffix removed, and another importer's entry is not taken for them", () => {
    expect(rootImporterVersions(LOCK_AT_7E751F5, [WORKER, FLEET])).toEqual({ [WORKER]: "0.13.1", [FLEET]: "0.11.0" });
  });

  test("a package the root importer does not list reads null, so a rename cannot pass as agreement", () => {
    expect(rootImporterVersions(LOCK_AT_7E751F5, ["@a11ign/not-a-layer"])).toEqual({ "@a11ign/not-a-layer": null });
    expect(rootImporterVersions("not a lockfile", [WORKER])).toEqual({ [WORKER]: null });
  });

  test("POSITIVE CONTROL: the pins at 1d4c831 (0.13.0/0.10.2) disagree with that lockfile, and each line names both numbers", () => {
    const resolved = rootImporterVersions(LOCK_AT_7E751F5, [WORKER, FLEET]);
    const found = lockDisagreements({ layers: PINS_AT_1D4C831, resolved });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("0.13.0");
    expect(found[0]).toContain("0.13.1");
    expect(found[1]).toContain("0.10.2");
    expect(found[1]).toContain("0.11.0");
  });

  test("the pins that agree with that lockfile report nothing", () => {
    const agreed = { "nvda-worker": { package: WORKER, version: "0.13.1" }, "screenreader-fleet": { package: FLEET, version: "0.11.0" } };
    expect(lockDisagreements({ layers: agreed, resolved: rootImporterVersions(LOCK_AT_7E751F5, [WORKER, FLEET]) })).toEqual([]);
  });
});

describe("deploy-pins.json against the core's lockfile at core.commit", () => {
  const pins = readDeployPins();
  const core = pins.core;
  const read = core ? coreLockAt({ commit: core.commit, remote: core.remote }) : { skip: "deploy-pins.json declares no `core`" };

  test("deploy-pins.json declares the core commit this test reads (positive control: the declaration this file is read against exists)", () => {
    expect(core?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(pins.layers)).toEqual(["nvda-worker", "screenreader-fleet"]);
  });

  test.skipIf("skip" in read)(`every layer's version is the one the core's pnpm-lock.yaml resolves at core.commit${"skip" in read ? ` (SKIPPED, NOT PASSED: ${read.skip})` : ""}`, () => {
    if ("skip" in read) return;
    const packages = Object.values(pins.layers).map((layer) => layer.package);
    const resolved = rootImporterVersions(read.lock, packages);
    expect(lockDisagreements({ layers: pins.layers, resolved })).toEqual([]);
  });
});
