// @ts-check
/**
 * Post the fleet part's verdict as a `qualification` commit status, FROM THE CONTROL PLANE (#3289).
 *
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --started [--run=<label>]
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --exit-code=<n> [--run=<label>]
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --verdict-file=<path> [--run=<label>]
 *
 * ## Why here and not on the lab (`ceo`, ruling A on #3289)
 *
 * ADR 0012 draws the lab/control line along the credential boundary: the lab runs corpus code and a run
 * starts what it needs "without giving the lab a credential". A write token resting on the lab would be the
 * first hole in that line, and nothing is bought by it -- the lab already RETURNS its verdict
 * (`fleetVerdict`/`exitCodeFor`), so the poster only has to be somewhere that can hold a token. The
 * decision of WHAT to say is `qualificationStatus` in the lab package and is not restated here.
 *
 * ## The token, and what absence means
 *
 * `~/.config/a11y-witness/qualification-status-token` -- a SECOND file: `statuses: write` on this repository
 * only. It is not `A11IGN_BOT_TOKEN`, and it is not the READ token at `gh-token` widened in place: the
 * reader and the writer are different powers.
 *
 * When that file is absent this posts NOTHING and says so, exit 3. Absence is "not yet": never a `success`
 * (there is nothing to say it with), never a silent skip (a release that waits for a status nobody is
 * posting must be able to find out why), and not exit 1 either, which would read as a gate failing.
 *
 * ## Exit codes
 *
 *   0  posted
 *   1  refused or failed: a bad flag, a malformed sha, or GitHub did not accept the post
 *   3  NOT posted, because the token file is absent (or empty) -- "not yet"
 *
 * Not the gate contract of `verdict.mjs` (0/1/2): this is a poster, not a gate, and its 3 means a
 * precondition is missing, as it does in `code-drift.mjs`.
 *
 * Runs from a raw checkout with no install (control has no dependencies), so: `fetch`, `node:` imports and
 * relative paths only.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { qualificationStatus } from "../../lab/src/gates/qualification-status.mjs";

/** This repository's canonical slug -- what `origin` says; `a11ign/a11y-witness` is a former name. */
export const DEFAULT_REPO = "a11ign/a11ign";

export const TOKEN_FILE_NAME = "qualification-status-token";

/** Where the second token rests on the control plane. */
export function defaultTokenPath(home = homedir()) {
  return join(home, ".config", "a11y-witness", TOKEN_FILE_NAME);
}

export const EXIT = { POSTED: 0, REFUSED: 1, NOT_YET: 3 };

/**
 * The token, trimmed, or `undefined` when the file is absent or holds nothing. Only ENOENT is "absent";
 * a permission error is thrown, because a token that exists and cannot be read is a defect to see, not a
 * "not yet" to wait out.
 * @param {string} path @returns {string | undefined}
 */
export function readToken(path) {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * @typedef {{ posted: true, payload: import("../../lab/src/gates/qualification-status.mjs").StatusPayload }
 *   | { posted: false, reason: "no-token", payload: import("../../lab/src/gates/qualification-status.mjs").StatusPayload, tokenPath: string }
 *   | { posted: false, reason: "rejected", payload: import("../../lab/src/gates/qualification-status.mjs").StatusPayload, detail: string }} PostResult
 */

/**
 * Build the payload, then post it if there is a token to post with.
 *
 * @param {{ sha: string, outcome?: import("../../lab/src/gates/qualification-status.mjs").Outcome, run?: string,
 *           repo?: string, tokenPath?: string, fetchImpl?: typeof fetch }} input
 * @returns {Promise<PostResult>}
 */
export async function postQualificationStatus(input) {
  const { sha, outcome, run, repo = DEFAULT_REPO, tokenPath = defaultTokenPath(), fetchImpl = fetch } = input;
  // BEFORE the token is read: a malformed sha is a refusal whether or not the token exists yet.
  const payload = qualificationStatus({ sha, outcome, run });
  const token = readToken(tokenPath);
  if (!token) return { posted: false, reason: "no-token", payload, tokenPath };
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (response.status !== 201) {
    return { posted: false, reason: "rejected", payload,
      detail: `GitHub answered ${response.status} ${(await response.text()).slice(0, 200)}` };
  }
  return { posted: true, payload };
}

/**
 * What the lab job printed, as an outcome. A file that cannot be read or parsed is `{}` -- "no readable
 * verdict" -- which `qualificationStatus` turns into a `failure`, never a `success`.
 * @param {string} path
 * @returns {import("../../lab/src/gates/qualification-status.mjs").Outcome}
 */
export function outcomeFromVerdictFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? { verdict: parsed } : /** @type {any} */ ({});
  } catch {
    return /** @type {any} */ ({});
  }
}

/**
 * @param {string[]} argv
 * @returns {{ sha: string | undefined, run: string | undefined, repo: string | undefined,
 *             outcome: import("../../lab/src/gates/qualification-status.mjs").Outcome | undefined }}
 */
export function parseArgs(argv) {
  const exitCode = flagValue(argv, "exit-code");
  const verdictFile = flagValue(argv, "verdict-file");
  /** @type {import("../../lab/src/gates/qualification-status.mjs").Outcome | undefined} */
  let outcome;
  if (argv.includes("--started")) outcome = { started: true };
  else if (verdictFile !== undefined) outcome = outcomeFromVerdictFile(verdictFile);
  else if (exitCode !== undefined) outcome = { exitCode: /^\d+$/.test(exitCode) ? Number(exitCode) : exitCode };
  return { sha: flagValue(argv, "sha"), run: flagValue(argv, "run"), repo: flagValue(argv, "repo"), outcome };
}

/** @param {PostResult} result @returns {string} */
export function renderResult(result) {
  const said = `${result.payload.state} -- ${result.payload.description}`;
  if (result.posted) return `POSTED qualification: ${said}\n`;
  if (result.reason === "no-token") {
    return `NOT POSTED -- ${result.tokenPath} does not exist, so nothing was said on the sha. That is "not yet", `
      + `never a pass: the release keeps waiting. Would have posted: ${said}\n`;
  }
  return `NOT POSTED -- ${result.detail}. Wanted to post: ${said}\n`;
}

async function main() {
  refuseUnknownFlags(["--sha=", "--started", "--exit-code=", "--verdict-file=", "--run=", "--repo="],
    { entry: import.meta.url, command: "node packages/control/src/post-qualification-status.mjs" });
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = await postQualificationStatus(/** @type {any} */ ({ ...args, repo: args.repo ?? DEFAULT_REPO }));
    process.stdout.write(renderResult(result));
    process.exitCode = result.posted ? EXIT.POSTED : result.reason === "no-token" ? EXIT.NOT_YET : EXIT.REFUSED;
  } catch (error) {
    process.stderr.write(`REFUSED -- ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.REFUSED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
