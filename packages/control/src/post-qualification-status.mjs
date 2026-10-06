// @ts-check
/**
 * Post the fleet part's verdict as a `qualification` commit status, FROM THE AGENTS HOST (#3289).
 *
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --started [--run=<label>]
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --exit-code=<n> [--run=<label>]
 *   node packages/control/src/post-qualification-status.mjs --sha=<40 hex> --verdict-file=<path> [--run=<label>]
 *
 * ## Why here, with this credential (`ceo`, ruling B' on #3289, superseding A)
 *
 * ADR 0012 draws the lab/control line along the credential boundary: the lab runs corpus code and a run
 * starts what it needs "without giving the lab a credential". Neither the lab nor the control plane holds a
 * write credential for this. The poster runs where `lab-job.mjs` already runs, on the agents host, and the
 * lab already RETURNS its verdict, so nothing has to rest on the lab. The decision of WHAT to say is
 * `qualificationStatus` in the lab package and is not restated here.
 *
 * ## The credential, and what its absence means
 *
 * The host's own ambient `gh`, as it stands: this never sets `GH_CONFIG_DIR` or `GH_TOKEN`
 * (`.claude/rules/gh-api-budget.md`: one export changes who every later write is attributed to, and that
 * disposition is `ceo`'s). There is NO token file. The author of the post is whatever account the host's
 * `gh` routes to, so a reader must find the status by context and sha and never by creator (#3136).
 *
 * When there is no usable credential (no `gh` on the PATH, `gh` logged in as nobody, or GitHub answering
 * 401/403) this posts NOTHING and says so, exit 3. That is "not yet": never a `success` (there is nothing to
 * say it with), never a silent skip (a release waiting for a status nobody is posting must be able to find
 * out why), and not exit 1 either, which would read as a gate failing.
 *
 * ## Exit codes
 *
 *   0  posted
 *   1  refused or failed: a bad flag, a malformed sha, or GitHub did not accept the post for another reason
 *   3  NOT posted, because this host has no usable credential -- "not yet"
 *
 * Not the gate contract of `verdict.mjs` (0/1/2): this is a poster, not a gate, and its 3 means a
 * precondition is missing, as it does in `code-drift.mjs`.
 *
 * Runs from a raw checkout with no install (control has no dependencies), so: `gh`, `node:` imports and
 * relative paths only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { flagValue, refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { qualificationStatus } from "../../lab/src/gates/qualification-status.mjs";

/** This repository's canonical slug -- what `origin` says; `a11ign/a11y-witness` is a former name. */
export const DEFAULT_REPO = "a11ign/a11ign";

const BODY_EXCERPT = 200;
/** `gh`'s own exit status for "you are not authenticated" (`gh help exit-codes`). */
const GH_EXIT_AUTH_REQUIRED = 4;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

export const EXIT = { POSTED: 0, REFUSED: 1, NOT_YET: 3 };

/**
 * @typedef {{ status: number | null, stdout: string, stderr: string, missing: boolean }} GhAnswer
 *   What one `gh` call said. `missing` is "there is no `gh` here at all", which is a credential problem and
 *   not a refusal.
 * @typedef {(args: string[]) => GhAnswer} RunGh
 * @typedef {import("../../lab/src/gates/qualification-status.mjs").StatusPayload} StatusPayload
 * @typedef {{ posted: true, payload: StatusPayload }
 *   | { posted: false, reason: "no-credential", payload: StatusPayload, detail: string }
 *   | { posted: false, reason: "rejected", payload: StatusPayload, detail: string }} PostResult
 */

/**
 * `gh` with the caller's environment untouched -- the whole point of "the host's ambient credential".
 * @type {RunGh}
 */
export function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  const missing = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ENOENT";
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", missing };
}

/**
 * Throws the poster's own refusal for a sha that is not 40 lowercase hex, so a caller can refuse BEFORE it
 * starts something that will later want to post. The rule is `qualificationStatus`'s, not restated here.
 * @param {unknown} sha
 */
export function requireFullSha(sha) {
  qualificationStatus({ sha, outcome: { started: true } });
}

/** @param {string} repo @param {string} sha @param {StatusPayload} payload @returns {string[]} the `gh api` argv; fields become the JSON body */
function ghApiArgs(repo, sha, payload) {
  return ["api", "--method", "POST", `repos/${repo}/statuses/${sha}`,
    "-f", `state=${payload.state}`, "-f", `context=${payload.context}`, "-f", `description=${payload.description}`];
}

/**
 * Sorts a failed `gh` call into "this host has no usable credential" and "GitHub did not accept the post".
 * @param {GhAnswer} answer @returns {{ credential: boolean, detail: string }}
 */
function classifyFailure(answer) {
  if (answer.missing) return { credential: true, detail: "`gh` is not installed on this host" };
  const said = (answer.stderr || answer.stdout).trim().slice(0, BODY_EXCERPT);
  const http = Number(/\(HTTP (\d{3})\)/.exec(answer.stderr)?.[1]);
  const credential = answer.status === GH_EXIT_AUTH_REQUIRED || http === HTTP_UNAUTHORIZED || http === HTTP_FORBIDDEN;
  return { credential, detail: said || `gh exited ${answer.status}` };
}

/**
 * Build the payload, then post it with whatever `gh` credential this host has.
 *
 * @param {{ sha: string, outcome?: import("../../lab/src/gates/qualification-status.mjs").Outcome, run?: string,
 *           repo?: string, gh?: RunGh }} input
 * @returns {PostResult}
 */
export function postQualificationStatus(input) {
  const { sha, outcome, run, repo = DEFAULT_REPO, gh = runGh } = input;
  // BEFORE `gh` is asked: a malformed sha is a refusal whether or not this host can post yet.
  const payload = qualificationStatus({ sha, outcome, run });
  const answer = gh(ghApiArgs(repo, sha, payload));
  if (answer.status === 0) return { posted: true, payload };
  const { credential, detail } = classifyFailure(answer);
  return credential
    ? { posted: false, reason: "no-credential", payload, detail }
    : { posted: false, reason: "rejected", payload, detail: `GitHub did not accept the post: ${detail}` };
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
  if (result.reason === "no-credential") {
    return `NOT POSTED -- this host has no usable GitHub credential (${result.detail}), so nothing was said on the `
      + `sha. That is "not yet", never a pass: the release keeps waiting. Would have posted: ${said}\n`;
  }
  return `NOT POSTED -- ${result.detail}. Wanted to post: ${said}\n`;
}

function main() {
  refuseUnknownFlags(["--sha=", "--started", "--exit-code=", "--verdict-file=", "--run=", "--repo="],
    { entry: import.meta.url, command: "node packages/control/src/post-qualification-status.mjs" });
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = postQualificationStatus(/** @type {any} */ ({ ...args, repo: args.repo ?? DEFAULT_REPO }));
    process.stdout.write(renderResult(result));
    process.exitCode = result.posted ? EXIT.POSTED : result.reason === "no-credential" ? EXIT.NOT_YET : EXIT.REFUSED;
  } catch (error) {
    process.stderr.write(`REFUSED -- ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.REFUSED;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
