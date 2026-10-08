/**
 * WHAT A WORKER RUNS REACHES OUTSIDE THE LAYER, AND THE STAMP READS THAT REACH (ADR 0039 item 6d, #3397; narrowed by #3447).
 *
 * The launchers reach the foreground-lock script and the capture-check harness, and the provision stamp hashes the files a
 * worker's environment is made of. The reach is declared once, in the layer's `launcher-reach.cmd`, and the stamp READS it.
 *
 * THE LAYER LEFT THIS REPOSITORY (#3447), and the half of this file that asserted the layer's OWN launchers went with it:
 * `run-capture-check.cmd` calls the declaration and stops on an absent file, `run-server.cmd`'s two literals equal it, and
 * every `EXITCODE` line redirects first. They are the layer's to pin (the launcher port row), recoverable as
 * `git show d8952882f:packages/control/src/layer-launchers.test.ts`. What stays is what CORE owns: the stamp (a core
 * script) reads, never quotes, the paths; and the core files the declaration NAMES exist. The declaration is a stand-in
 * (`scripts/test-support/launcher-reach.stand-in.cmd`) until the layer carries the file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { declaredReach, reachFile, stampEnvironmentFiles } from "../../../scripts/test-support/stamp-files.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
const STAMP = read("packages/worker-fleet/src/provisioning/stamp-provision-revision.ps1");

/** What the declaration NAMES in core: the foreground-lock script and the capture harness. */
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

/** A checkout holding the stand-in declaration, and a placeholder for whichever of the reached files `present` lists. */
function fixtureCheckout(present: readonly (typeof REACHED)[number][]): string {
  const root = mkdtempSync(join(tmpdir(), "layer-launchers-"));
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const declaration = readFileSync(reachFile(), "utf8");
  put("packages/control/layers.json", read("packages/control/layers.json"));
  put("scripts/test-support/launcher-reach.stand-in.cmd", declaration);
  for (const name of present) put(declaredReach(declaration, name) as string, "// present\n");
  return root;
}

test("the declaration names the reach, and every core file it names exists", () => {
  const declaration = readFileSync(reachFile(), "utf8");
  for (const name of REACHED) assert.ok(declaredReach(declaration, name), `${name} is not declared`);
  assert.equal(declaredReach(declaration, "CHECKOUT_ROOT"), "%~dp0../../..",
    "the checkout root is no longer three levels above the declaration, so the launchers' directory change is wrong");
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
