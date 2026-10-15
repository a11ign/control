/**
 * THE PLANE'S INSTALLED LAYERS ARE READ BEFORE THE PLANE IS WRITTEN TO (#5556).
 *
 * A merged pin bump reaches the plane's HEAD by `git merge --ff-only` and nothing installs afterwards, so HEAD can hold a lockfile that
 * `node_modules/` does not: control#109 left `@a11ign/screenreader-worker@0.13.1` resolved and `0.13.0` installed, and the first fleet write of
 * the a11ign#5155 canary stopped on it AFTER the merge. These pin that the same fact is said first, by a read, naming both numbers, with the
 * 0.13.0 / 0.13.1 pair as the positive control, and that it is a REFUSAL only where `pnpm install` is what repairs it.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { installedLayersJudged, installedLayersRead, manifestOf } from "./layer-checkouts.ts";
import { readDeployPins } from "./layer-pins.ts";
import { installedLayersRefusal } from "./fleet-playbook.ts";

const MANIFEST = manifestOf(readDeployPins());
const WORKER = MANIFEST.layers["nvda-worker"];
const FLEET = MANIFEST.layers["screenreader-fleet"];
assert.ok(WORKER.version && FLEET.version, "the positive control: the declaration holds two published releases");

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** The lockfile's shape for the two importer entries, with the transitive `screenreader-worker@0.9.0` entry pnpm writes beside them. */
const lockfile = ({ worker, fleet }: { worker: string; fleet: string }) => [
  "lockfileVersion: '9.0'", "", "importers:", "", "  .:", "    dependencies:",
  "      '@a11ign/screenreader-fleet':", `        specifier: ${fleet}`, `        version: ${fleet}(@a11ign/scorer@0.3.3)(typescript@7.0.2)`,
  "      '@a11ign/screenreader-worker':", `        specifier: ${worker}`, `        version: ${worker}`,
  "    devDependencies:", "      '@a11ign/toolchain':", "        specifier: ^0.1.7", "        version: 0.1.7", "",
  "packages:", "", `  '@a11ign/screenreader-worker@${worker}':`, "    resolution: {}", "  '@a11ign/screenreader-worker@0.9.0':", "    resolution: {}", "",
].join("\n");

type Plane = { installed?: { worker?: string; fleet?: string }; locked?: { worker: string; fleet: string }; clone?: boolean };

/** A plane as a directory: `node_modules/<package>/package.json` at the installed releases, a `pnpm-lock.yaml`, and optionally a clone at a layer's path. */
function planeOf({ installed = {}, locked, clone = false }: Plane) {
  const core = mkdtempSync(join(tmpdir(), "plane-5556-"));
  roots.push(core);
  for (const [layer, version] of [[WORKER, installed.worker], [FLEET, installed.fleet]] as const) {
    if (version === undefined) continue;
    const dir = join(core, "node_modules", layer.package as string);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), `{\n  "name": "${layer.package}",\n  "version": "${version}"\n}\n`);
  }
  if (locked) writeFileSync(join(core, "pnpm-lock.yaml"), lockfile(locked));
  if (clone) mkdirSync(join(core, WORKER.path, ".git"), { recursive: true });
  return core;
}

/** The read, run for real against the fixture, and what it printed. */
function readOf(core: string): string {
  const command = installedLayersRead(MANIFEST);
  const local = command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, core);
  const run = spawnSync("bash", ["-c", local], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

const judged = (core: string) => installedLayersJudged(MANIFEST, readOf(core));
const BOTH = { worker: WORKER.version as string, fleet: FLEET.version as string };

test("#5556 positive control: HEAD resolves 0.13.1 and 0.13.0 is installed -> refused, naming both numbers and the remedy", () => {
  const { refusal, notes } = judged(planeOf({ installed: { worker: "0.13.0", fleet: BOTH.fleet }, locked: BOTH }));
  assert.ok(refusal, "the plane that stopped the canary must be reported");
  assert.match(refusal, /layer nvda-worker \(@a11ign\/screenreader-worker\): installed 0\.13\.0 under \/root\/control\/node_modules, the plane's lockfile resolves 0\.13\.1, deploy-pins\.json declares 0\.13\.1/);
  assert.match(refusal, /pnpm install --frozen-lockfile in \/root\/control/);
  assert.doesNotMatch(refusal, /screenreader-fleet/, "the layer that is in step is not named");
  assert.deepEqual(notes, []);
});

test("#5556 the read prints the importer's release, not the transitive 0.9.0 entry beside it", () => {
  const out = readOf(planeOf({ installed: BOTH, locked: BOTH }));
  assert.match(out, new RegExp(`^nvda-worker ${BOTH.worker} ${BOTH.worker}$`, "m"));
  assert.match(out, new RegExp(`^screenreader-fleet ${BOTH.fleet} ${BOTH.fleet}$`, "m"), "a version with peer suffixes is read as its release");
});

test("#5556 installed layers equal to the declaration are not reported", () => {
  assert.deepEqual(judged(planeOf({ installed: BOTH, locked: BOTH })), { refusal: null, notes: [] });
});

test("#5556 no installed release, with HEAD on the declared lockfile, is refused as 'no release is installed'", () => {
  const { refusal } = judged(planeOf({ installed: { fleet: BOTH.fleet }, locked: BOTH }));
  assert.match(refusal ?? "", /no release is installed under \/root\/control\/node_modules, the plane's lockfile resolves 0\.13\.1/);
});

test("#5556 a plane whose own lockfile is behind is a NOTE, never a refusal: the move is what brings it forward", () => {
  const behind = { worker: "0.13.0", fleet: "0.10.2" };
  const { refusal, notes } = judged(planeOf({ installed: behind, locked: behind }));
  assert.equal(refusal, null, "refusing here would make the move, and so the install after it, unreachable");
  assert.equal(notes.length, 2);
  assert.match(notes[0], /installed 0\.13\.0 .* resolves 0\.13\.0, deploy-pins\.json declares 0\.13\.1: the plane's checkout is behind/);
});

test("#5556 a layer held as a clone is judged by the move's own branch, not by node_modules", () => {
  const { refusal, notes } = judged(planeOf({ installed: { fleet: BOTH.fleet }, locked: BOTH, clone: true }));
  assert.deepEqual({ refusal, notes }, { refusal: null, notes: [] });
});

test("#5556 a layer the read printed no line for is refused, not read as in step", () => {
  const { refusal } = installedLayersJudged(MANIFEST, "");
  assert.match(refusal ?? "", /returned no line for it/);
});

test("#5556 installedLayersRefusal asks with a read-only command and prints notes", () => {
  const core = planeOf({ installed: { worker: "0.13.0", fleet: "0.10.2" }, locked: { worker: "0.13.0", fleet: "0.10.2" } });
  const asked: string[] = [];
  const said: string[] = [];
  const refusal = installedLayersRefusal({
    ssh: (command, options) => { asked.push(command); assert.equal(options?.capture, true); return readOf(core); },
    say: (line) => said.push(line),
  });
  assert.equal(refusal, null);
  assert.equal(asked.length, 1);
  assert.doesNotMatch(asked[0], /git (merge|checkout|fetch)|pnpm install|\brm\b|>\s*\/(?!dev\/null)/, "it reads and writes nothing");
  assert.equal(said.length, 2);
});

test("#5556 main asks BEFORE the first write to the plane, and the ask refuses with exit 2", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fleet-playbook.ts"), "utf8");
  const asked = source.indexOf("  exitOnLaggingInstall();");
  const moved = source.indexOf("  moveControlPlane({ ref, expected, layerCommits });");
  assert.ok(asked > 0 && moved > 0, "both calls are in main");
  assert.ok(asked < moved, "the read comes first");
  const body = source.slice(source.indexOf("function exitOnLaggingInstall"));
  assert.match(body.slice(0, body.indexOf("\n}\n")), /installedLayersRefusal\(\)[\s\S]*process\.exit\(2\)/);
});
