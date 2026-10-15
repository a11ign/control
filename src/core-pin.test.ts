/**
 * THE CORE COMMIT THE GUESTS ARE PUT ON (#5515): `deploy-pins.json`'s `core` is a commit the core's remote actually holds.
 *
 * `deploy.yml` and `provision-role.yml` merge every guest's core checkout to this commit, and a guest can only merge to an object
 * it has. So a typo, or a commit that was force-pushed away, must be refused HERE, before anything is shipped, not found on a box.
 *
 * The offline half reads the real file and the reader's refusals, and runs always. The network half asks the core's remote for the
 * pinned object, and runs only with `A11Y_CHECK_CORE_PIN=1`: a test that fails when the network does is refused in this repository
 * (`layer-pins.test.ts`), so it is run by hand before the pin moves and its output is quoted on the pull request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEPLOY_PINS_PATH, parseDeployPins, readDeployPins } from "./layer-pins.ts";
import { sandboxGitEnv } from "./git-safe-env.ts";

const declared = readDeployPins().core;
const WORKER_DEFAULTS = fileURLToPath(new URL("../ansible/roles/worker/defaults/main.yml", import.meta.url));

/** `deploy-pins.json` as the real file, with its `core` replaced: the reader's refusals, tried on the real document. */
function withCore(core: unknown): string {
  const doc = JSON.parse(readFileSync(DEPLOY_PINS_PATH, "utf8"));
  doc.core = core;
  return JSON.stringify(doc);
}

test("deploy-pins.json declares the core as a full commit, on the clone URL the guests are built from", () => {
  assert.ok(declared, "deploy-pins.json has a core entry (#5515)");
  assert.match(declared.commit, /^[0-9a-f]{40}$/, "a full sha, which is what a pin is: a branch or a short sha moves or is ambiguous");
  // Not the file comparing itself: the workers clone the core from `worker_repo_url`, and the pin must name that same repository.
  const workerRepo = readFileSync(WORKER_DEFAULTS, "utf8").match(/^worker_repo_url: (\S+)$/m)?.[1];
  assert.equal(declared.remote, workerRepo, "the core's pinned remote is the one a guest clones from");
});

test("the reader refuses a core pin that cannot name one commit, and says which field", () => {
  const good = declared as { remote: string; commit: string; };
  const parsed = parseDeployPins(withCore(good));
  assert.ok("pins" in parsed, "positive control: the real core entry parses");
  assert.equal(parsed.pins.core?.commit, good.commit);
  const refused = (core: unknown, field: string) => {
    const result = parseDeployPins(withCore(core));
    assert.ok("refusal" in result, `${JSON.stringify(core)} is refused`);
    assert.match(result.refusal, new RegExp(`core\\.${field}`));
  };
  refused({ ...good, commit: good.commit.slice(0, 12) }, "commit");
  refused({ ...good, commit: "main" }, "commit");
  refused({ ...good, commit: good.commit.toUpperCase() }, "commit");
  refused({ ...good, remote: "git@github.com:a11ign/a11ign.git" }, "remote");
  refused({ ...good, remote: "https://github.com/a11ign/a11ign" }, "remote");
});

/** Whether the remote will hand over `sha`: a fetch of exactly that object into an empty repository. A sha it does not hold is refused. */
function objectOnRemote(remote: string, sha: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "core-pin-"));
  try {
    const env = sandboxGitEnv();
    if (spawnSync("git", ["init", "--quiet", "--bare", dir], { env }).status !== 0) throw new Error(`git init failed in ${dir}`);
    const fetched = spawnSync("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", "--no-tags", remote, sha], { env, encoding: "utf8" });
    if (fetched.status !== 0) return false;
    return spawnSync("git", ["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { env }).status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHECK_NETWORK = process.env.A11Y_CHECK_CORE_PIN === "1";
const NEVER_PUSHED = "1234567890abcdef1234567890abcdef12345678";

test("the pinned commit is an object on the core's remote (network: A11Y_CHECK_CORE_PIN=1)", { skip: CHECK_NETWORK ? false : "set A11Y_CHECK_CORE_PIN=1 to ask the core's remote", timeout: 180_000 }, () => {
  assert.ok(declared);
  assert.equal(objectOnRemote(declared.remote, declared.commit), true,
    `${declared.commit} is not an object on ${declared.remote}: a typo, or a commit force-pushed away, is refused before anything is shipped`);
  // The positive control: the answer above is only evidence if the same check says NO for a sha nobody has pushed.
  assert.equal(objectOnRemote(declared.remote, NEVER_PUSHED), false, "a sha the remote does not hold is refused");
});
