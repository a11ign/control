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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { installedLayersJudged, installedLayersRead, manifestOf } from "./layer-checkouts.ts";
import { readDeployPins } from "./layer-pins.ts";
import { installedLayersRefusal, moveControlPlane } from "./fleet-playbook.ts";

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

test("#5556 an unreadable plane (no lockfile entry, no installed release) is refused, never read as merely behind", () => {
  const { refusal, notes } = judged(planeOf({}));
  assert.deepEqual(readOf(planeOf({})).trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")), ["none none", "none none"], "the read really printed the unknown state");
  assert.match(refusal ?? "", /the lockfile names no release for it \(or could not be read\)/);
  assert.deepEqual(notes, []);
  const { refusal: halfRead } = judged(planeOf({ installed: { worker: "0.13.0", fleet: BOTH.fleet } }));
  assert.match(halfRead ?? "", /installed 0\.13\.0 under .* the plane's lockfile resolves no release/, "an unreadable lockfile alone is also unknown");
});

test("#5556 an unreadable lockfile is refused even where the installed release equals the declaration", () => {
  const core = planeOf({ installed: BOTH });
  assert.deepEqual(readOf(core).trim().split("\n").map((line) => line.split(" ").slice(1).join(" ")), [`${BOTH.worker} none`, `${BOTH.fleet} none`], "the read really printed installed-equals-declared beside an unknown lockfile");
  const { refusal, notes } = judged(core);
  assert.match(refusal ?? "", /layer nvda-worker .* installed 0\.13\.1 under .* the plane's lockfile resolves no release, deploy-pins\.json declares 0\.13\.1: the lockfile names no release for it \(or could not be read\)/);
  assert.match(refusal ?? "", /layer screenreader-fleet/, "each layer whose lockfile cannot be read is named");
  assert.deepEqual(notes, []);
  assert.deepEqual(judged(planeOf({ installed: BOTH, locked: BOTH })), { refusal: null, notes: [] }, "the same installed layers WITH a readable lockfile are in step");
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

/** `moveControlPlane` run for real with the plane's answers replaced, recording every command it asked and every refusal it ended on. */
function moveObserved({ plane }: { plane: string }) {
  const asked: string[] = [];
  const refused: string[] = [];
  const refuse = (text: string): never => { refused.push(text); throw new Error("refused"); };
  const ssh = (command: string) => { asked.push(command); return plane; };
  let threw = false;
  try {
    moveControlPlane({ ref: "main", expected: "a".repeat(40), layerCommits: {} }, { ssh, declaredCore: () => "7".repeat(40), say: () => undefined, refuse });
  } catch { threw = true; }
  return { asked, refused, threw };
}
const isMove = (command: string) => command.includes("git merge --ff-only");

test("#5556 the first write is never asked when the installed layers lag: the plane saw ONE command, and it was the read", () => {
  const { asked, refused, threw } = moveObserved({ plane: `nvda-worker 0.13.0 ${BOTH.worker}\nscreenreader-fleet ${BOTH.fleet} ${BOTH.fleet}\n` });
  assert.equal(threw, true);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /installed 0\.13\.0 .* resolves 0\.13\.1/);
  assert.equal(asked.length, 1, "only the read reached the plane");
  assert.equal(asked.some(isMove), false);
});

test("#5556 positive control: with the layers in step the same call reads, THEN writes", () => {
  const { asked, threw } = moveObserved({ plane: `nvda-worker ${BOTH.worker} ${BOTH.worker}\nscreenreader-fleet ${BOTH.fleet} ${BOTH.fleet}\n` });
  assert.equal(threw, false);
  assert.equal(asked.length, 2);
  assert.equal(isMove(asked[0]), false, "the first command is the read");
  assert.equal(isMove(asked[1]), true, "the second is the move");
});

test("#5556 an unreadable plane stops the first write too", () => {
  const { asked, threw } = moveObserved({ plane: "nvda-worker none none\nscreenreader-fleet none none\n" });
  assert.equal(threw, true);
  assert.equal(asked.some(isMove), false);
});
