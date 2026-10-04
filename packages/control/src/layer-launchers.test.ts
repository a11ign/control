/**
 * WHAT A WORKER RUNS REACHES OUTSIDE THE LAYER, AND THAT REACH IS DECLARED ONCE (ADR 0039 item 6d, #3397).
 *
 * The launchers reach the foreground-lock script and the capture-check harness, and the provision stamp
 * hashes the files a worker's environment is made of. Each used to carry its own copy of those paths, and a
 * move that changed one left the other naming a file that was not there: `run-server.cmd` warned and
 * started a worker that returned 0 phrases from every capture, and the stamp's `throw` was the only thing
 * that noticed. `layers.json` says where the layer is and the layer's `launcher-reach.cmd` says what its
 * launchers reach; `run-capture-check.cmd` `call`s the second and the stamp READS both.
 *
 * `run-server.cmd` is the exception, on purpose. The stamp HASHES it, so editing it moves
 * `provisionRevision` on every worker and costs a recapture. It keeps its two literals and this file pins
 * them equal to the declaration, so a path still cannot change in one place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredLayerPath, declaredReach, reachFile, stampEnvironmentFiles } from "../../../scripts/test-support/stamp-files.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const LAYER_SRC = `${declaredLayerPath("nvda-worker")}/src`;
const STAMP = read("packages/worker-fleet/src/provisioning/stamp-provision-revision.ps1");

/** What each launcher declaration NAMES: the foreground-lock script and the capture harness. */
const REACHED = ["FLT", "CAPTURE_CHECK"] as const;

/** The declared reach that is NOT there under `root`: the question a launcher asks before it runs. */
function absentReach(root: string): string[] {
  const declaration = readFileSync(reachFile(root), "utf8");
  return REACHED.flatMap((name) => {
    const path = declaredReach(declaration, name);
    if (path === undefined) return [`${name} is not declared`];
    return existsSync(join(root, path)) ? [] : [`${name} -> ${path} is absent`];
  });
}

/** A checkout holding only the declaration files, and whichever of the reached files `present` lists. */
function fixtureCheckout(present: readonly (typeof REACHED)[number][]): string {
  const root = mkdtempSync(join(tmpdir(), "layer-launchers-"));
  const put = (rel: string, from: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(resolve(REPO, from), join(root, rel));
  };
  put("packages/control/layers.json", "packages/control/layers.json");
  put(`${LAYER_SRC}/launcher-reach.cmd`, `${LAYER_SRC}/launcher-reach.cmd`);
  const declaration = read(`${LAYER_SRC}/launcher-reach.cmd`);
  for (const name of present) {
    const path = declaredReach(declaration, name) as string;
    put(path, path);
  }
  return root;
}

/** Code lines only: a path named in a `rem` comment is not a path that is read. */
const codeLines = (source: string) => source.split(/\r?\n/).filter((l) => !/^\s*rem\b/i.test(l));

test("the declaration names the reach, and every file it names exists", () => {
  const declaration = read(`${LAYER_SRC}/launcher-reach.cmd`);
  for (const name of REACHED) assert.ok(declaredReach(declaration, name), `${name} is not declared`);
  assert.equal(declaredReach(declaration, "CHECKOUT_ROOT"), "%~dp0../../..",
    "the checkout root is no longer three levels above the declaration, so the launchers' cd moved");
  assert.deepEqual(absentReach(REPO), [], "a declared reach is absent from the real checkout");
});

test("POSITIVE CONTROL: a checkout with the foreground-lock script absent is REFUSED, naming it", () => {
  const complete = fixtureCheckout(["FLT", "CAPTURE_CHECK"]);
  const noFlt = fixtureCheckout(["CAPTURE_CHECK"]);
  const noHarness = fixtureCheckout(["FLT"]);
  try {
    assert.deepEqual(absentReach(complete), [], "the control's green state is unreachable: a complete fixture was refused");
    assert.deepEqual(absentReach(noFlt), [
      "FLT -> packages/worker-fleet/src/provisioning/apply-foreground-lock-timeout.ps1 is absent",
    ]);
    assert.deepEqual(absentReach(noHarness), [
      "CAPTURE_CHECK -> packages/lab/src/harnesses/capture-check.mjs is absent",
    ]);
  } finally {
    for (const root of [complete, noFlt, noHarness]) rmSync(root, { recursive: true, force: true });
  }
});

test("run-capture-check.cmd reads the declaration and STOPS on an absent file, never warns and continues", () => {
  const launcher = read(`${LAYER_SRC}/run-capture-check.cmd`);
  const code = codeLines(launcher);
  assert.ok(code.some((l) => /^call "%~dp0launcher-reach\.cmd" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not `call` the declaration and stop when it is missing");
  assert.ok(code.some((l) => /^cd \/d "%CHECKOUT_ROOT%" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not cd to the declared root");
  assert.deepEqual(code.filter((l) => /packages[\\/]/.test(l)), [],
    "the launcher names a repo path in code again, a second copy of what the declaration says");
  for (const name of REACHED) {
    const start = code.findIndex((l) => l.includes(`if not exist "%${name}%"`) && l.trim().endsWith("("));
    assert.notEqual(start, -1, `no existence check for %${name}%`);
    const block = code.slice(start, code.indexOf(")", start)).join("\n");
    assert.match(block, /exit \/b 1/, `an absent %${name}% does not stop the check`);
    assert.doesNotMatch(block, /WARNING/, `an absent %${name}% only warns`);
  }
  assert.match(launcher, /"%CAPTURE_CHECK%" > capture-check\.log/, "the harness is no longer run from the declared path");
});

test("run-server.cmd keeps its two literals, and they EQUAL the declaration", () => {
  // Not a reader: the stamp hashes this file (see the header). The pin is what stops the copy drifting.
  const server = codeLines(read(`${LAYER_SRC}/run-server.cmd`)).join("\n");
  const declaration = read(`${LAYER_SRC}/launcher-reach.cmd`);
  const flt = /set "FLT=([^"]+)"/.exec(server)?.[1].replaceAll("\\\\", "\\");
  assert.equal(flt?.replaceAll("\\", "/"), declaredReach(declaration, "FLT"),
    "run-server.cmd names a different foreground-lock script than the declaration");
  const depth = /cd \/d "(%~dp0[^"]+)"/.exec(server)?.[1];
  assert.equal(depth?.replaceAll("\\", "/"), declaredReach(declaration, "CHECKOUT_ROOT"),
    "run-server.cmd changes directory to a different root than the declaration");
});

test("the stamp READS both paths, so none is quoted in its list", () => {
  const list = STAMP.slice(STAMP.indexOf("$ENVIRONMENT_FILES = @("), STAMP.indexOf("\n)", STAMP.indexOf("$ENVIRONMENT_FILES = @(")));
  const quoted = [...list.matchAll(/^\s*'([^']+)'\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(quoted.filter((p) => /run-server\.cmd|apply-foreground-lock-timeout/.test(p)), [],
    "the stamp quotes a launcher path again, a second copy that can change alone");
  assert.match(STAMP, /throw "provision stamp: the launcher declaration/, "an absent declaration no longer stops the stamp");
  assert.match(STAMP, /throw "provision stamp: \$declaration does not declare/, "a declaration that does not say no longer stops the stamp");
});

test("moving a path in the declaration moves it in the stamp's list, and nowhere else is edited", () => {
  const moved = fixtureCheckout(["FLT", "CAPTURE_CHECK"]);
  try {
    const file = reachFile(moved);
    writeFileSync(file, readFileSync(file, "utf8").replace("worker-fleet\\src\\provisioning", "elsewhere"));
    const was = stampEnvironmentFiles(STAMP);
    const now = stampEnvironmentFiles(STAMP, moved);
    assert.deepEqual(now.filter((p, i) => p !== was[i]), ["packages/elsewhere/apply-foreground-lock-timeout.ps1"]);
  } finally {
    rmSync(moved, { recursive: true, force: true });
  }
});

/**
 * Read off `origin/main` at ab8753d91, before #3397, and equal to what `stamp-provision-revision.ps1` printed
 * for that tree under PowerShell 7 (a Linux-adapted copy, both before and after the change). First 16 hex of
 * each file's normalised SHA-256, keyed by file name; the stamp itself is the 16 hex of the joined hashes.
 */
const PRE_CHANGE_HASHES = {
  "provision-nvda-worker.ps1": "30430BBD4903824A",
  "run-server.cmd": "D7643CD1DFD1DA63",
  "apply-foreground-lock-timeout.ps1": "1907969A83B52402",
  "main.yml": "A17283D96FC2BDA8",
  "a11y_speech_viewer.ps1": "870648FD2B1CC1EC",
};
const PRE_CHANGE_PROVISION_REVISION = "9ed0c82508499854";

/** The stamp's own algorithm, restated: CRLF to LF, UTF-8 without a BOM, SHA-256 each, then over the joined hex. */
const fileHash = (rel: string) => createHash("sha256")
  .update(read(rel).replace(/^\uFEFF/, "").replaceAll("\r\n", "\n")).digest("hex").toUpperCase();
const provisionRevision = (files: string[]) =>
  createHash("sha256").update(files.map(fileHash).join("")).digest("hex").slice(0, 16);

test("provisionRevision is UNCHANGED by this row: the five hashed files and the stamp they make", () => {
  // Pinned from the tree BEFORE #3397, where none of the five was edited. A move of any one is a recapture
  // of the whole corpus, so it must be a deliberate act and never a side effect of tidying a launcher.
  const files = stampEnvironmentFiles(STAMP);
  assert.deepEqual(Object.fromEntries(files.map((f) => [f.split("/").pop(), fileHash(f).slice(0, 16)])), PRE_CHANGE_HASHES,
    "a hashed file changed: provisionRevision moves on every worker, and the fleet recaptures");
  assert.equal(provisionRevision(files), PRE_CHANGE_PROVISION_REVISION);
});
