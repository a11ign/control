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
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
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

test("run-capture-check.cmd reads the declaration and STOPS on an absent file, never warns and continues", () => {
  const launcher = read(`${LAYER_SRC}/run-capture-check.cmd`);
  const code = codeLines(launcher);
  assert.ok(code.some((l) => /^call "%~dp0launcher-reach\.cmd" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not `call` the declaration and stop when it is missing");
  assert.ok(code.some((l) => /^cd \/d "%CHECKOUT_ROOT%" \|\| exit \/b 1$/.test(l.trim())),
    "the launcher does not change into the declared root");
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
 * WHAT THIS ROW DID TO THE FIVE HASHED FILES IS READ FROM ITS OWN DIFF, NOT FROM main'S CONTENT (#3397, ceo 2026-10-04).
 *
 * This test used to pin the first 16 hex of each file's hash as read off `origin/main` at ab8753d91. That is a
 * snapshot of ANOTHER row's territory: #3406 changed `main.yml` ahead of this pull request, the pin went red on
 * the merge ref, and the merge queue ejected the same head four times (14:20, 14:27, 14:36, 14:48Z). The claim
 * this row makes is "no file the stamp hashes was edited HERE", so the thing to compare is this pull request's
 * own change set against its merge base, which main moving cannot change.
 *
 * Applies only to the pull request that carries this row's changeset: on any other change, or on main itself,
 * the diff does not contain it and the files may move for their own reasons (the day `run-server.cmd` joins
 * the declaration is one). The refusal's positive control is `hashedFilesTouched` handed a diff that DOES
 * include one, below.
 */
const ROW_CHANGESET = ".changeset/launcher-reach-3397.md";
const STAMPED_FILES = 5;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

const hashedFilesTouched = (changed: string[], hashed: string[]) => changed.filter((f) => hashed.includes(f));

test("provisionRevision is UNCHANGED by this row: none of the five hashed files is in its own diff", (t) => {
  const git = (...args: string[]) => execFileSync("git", args,
    { cwd: REPO, env: sandboxGitEnv(), encoding: "utf8", maxBuffer: GIT_OUTPUT_LIMIT });
  let base: string;
  try {
    base = git("merge-base", "origin/main", "HEAD").trim();
  } catch {
    // A merge base needs history, and the `acceptance` job's clone is shallow; the `ts` job runs this with
    // fetch-depth: 0. Said, not counted as a pass.
    t.skip("no merge-base with origin/main in this checkout (a shallow clone). Not run, and not counted as a pass.");
    return;
  }
  const hashed = stampEnvironmentFiles(STAMP);
  assert.equal(hashed.length, STAMPED_FILES, "the stamp hashes five files; a sixth or a missing one changes what this test guards");
  const changed = git("diff", "--name-only", base).split("\n").filter(Boolean);
  if (!changed.includes(ROW_CHANGESET)) return;
  assert.deepEqual(hashedFilesTouched(changed, hashed), [],
    "a hashed file is in this row's diff: provisionRevision moves on every worker, and the fleet recaptures");
});

test("positive control: a diff that edits a hashed file is the one the check above refuses", () => {
  const hashed = stampEnvironmentFiles(STAMP);
  const runServer = hashed.find((f) => f.endsWith("run-server.cmd"));
  assert.ok(runServer, "the stamp lists run-server.cmd; without it this control proves nothing");
  assert.deepEqual(hashedFilesTouched([ROW_CHANGESET, "README.md", runServer], hashed), [runServer]);
  assert.deepEqual(hashedFilesTouched([ROW_CHANGESET, "packages/nvda-worker/src/launcher-reach.cmd"], hashed), []);
});
