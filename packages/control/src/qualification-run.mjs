// @ts-check
/**
 * The CALLER of `post-qualification-status.mjs`: `lab:job -e job=gate-stability -e row=<n> --qualify-sha=<sha>`
 * says on `<sha>` what the fleet part of the release gate found (#3289, #3136 done-when 3, done-when 6).
 *
 * ## The sequence, and why each step is where it is
 *
 * 1. `pending` is posted IMMEDIATELY BEFORE `ansible-playbook` starts, not when the command line is read:
 *    every refusal in `lab-job.mjs` (stale fleet, a worker that will not wake) happens before the dispatch,
 *    and a `pending` posted ahead of them would be left standing by a run that never began, which the release
 *    reads as "wait" until its own bound runs out.
 * 2. The verdict is posted when the dispatch returns, from the record the playbook already writes for the
 *    host (`run-job.yml`, "Tell the gate this job ended"). `ansible-playbook`'s own exit status is NOT the
 *    job's: a failed assert is 2 whatever the job exited with, which would read as INCONCLUSIVE. The job's
 *    exit is in the record, and the record names the commit the lab ran.
 * 3. ONE re-run on a first `failure` (#3136 outcome 2; `release-reads-qualification.mjs` reads
 *    failure, pending, then success as a pass and two failures as a regression). `success` on the re-run
 *    replaces the first `failure`; a second `failure` stays. Nothing is softened: the same argv, the same gate.
 *
 * ## What it refuses to say
 *
 * `success` needs ALL of: the dispatch exited 0, the record is this run's for this row, the commit the lab
 * ran starts with the sha being qualified, the record's exit is 0 and its outcome is `success`. Any one
 * missing is "no readable verdict", which `qualificationStatus` posts as `failure`, never as a pass.
 *
 * The lab is pinned to the sha by construction (`-e ref=<sha>` is added; the playbook resolves a 40-character
 * ref), so the commit check is a second line and not the first.
 *
 * Imports the poster only. The poster holds the one named edge to the lab package; this file adds none.
 * Runs from a raw checkout with no install, so `node:` imports and relative paths only.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderResult, requireFullSha, EXIT } from "./post-qualification-status.mjs";

export const QUALIFY_FLAG = "--qualify-sha=";

/** The only job whose verdict is the `qualification` status: the payload names `gate:stability` in every description. */
export const QUALIFIED_JOB = "gate-stability";

/** A first `failure` is re-run once, and only once (#3136 outcome 2). */
const MAX_ATTEMPTS = 2;

const RECORD_SCHEMA = 1;

/** Where `run-job.yml` writes one JSON record per finished run, on the host that ran the playbook. */
export function defaultRecordDir(home = homedir()) {
  return join(home, ".cache", "a11ign", "lab-jobs");
}

/**
 * @typedef {{ schema?: unknown, job?: unknown, row?: unknown, invocation?: unknown, outcome?: unknown,
 *             exit?: unknown, commit?: unknown }} JobRecord
 * @typedef {(query: { job: string, row: number, since: number }) => JobRecord | undefined} ReadRecord
 * @typedef {(input: { sha: string, outcome?: import("../../lab/src/gates/qualification-status.mjs").Outcome,
 *                     run?: string }) => import("./post-qualification-status.mjs").PostResult} Post
 * @typedef {{ post: Post, readRecord: ReadRecord, now?: () => number, say?: (text: string) => void }} Poster
 */

/**
 * The newest record THIS run wrote: the right job, the right row, written after `since`. Two runs of one
 * job for one row are told apart by time alone, so a record older than the dispatch is never read as its
 * verdict. A file that does not parse is skipped with its name printed, never silently.
 * @param {string} dir @param {{ job: string, row: number, since: number }} query
 * @param {(text: string) => void} say
 * @returns {JobRecord | undefined}
 */
export function readRecordFrom(dir, { job, row, since }, say = () => {}) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
  const found = names
    .filter((name) => name.startsWith(`${job}-`) && name.endsWith(".json"))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .filter(({ at }) => at >= since)
    .sort((a, b) => b.at - a.at)
    .flatMap(({ path }) => {
      try {
        return [/** @type {JobRecord} */ (JSON.parse(readFileSync(path, "utf8")))];
      } catch (error) {
        say(`qualification: ${path} does not parse (${error instanceof Error ? error.message : String(error)}); not read\n`);
        return [];
      }
    });
  return found.find((record) => record.schema === RECORD_SCHEMA && record.job === job && record.row === row);
}

/**
 * What the dispatch and its record together stand for, as the poster's `Outcome`. `{}` is "no readable
 * verdict", which is posted as a `failure`.
 * @param {{ status: number, record: JobRecord | undefined, sha: string }} seen
 * @returns {import("../../lab/src/gates/qualification-status.mjs").Outcome}
 */
export function outcomeOf({ status, record, sha }) {
  if (!record || !Number.isInteger(record.exit)) return /** @type {any} */ ({});
  const ranCommit = typeof record.commit === "string" ? record.commit : "";
  const ranThisSha = ranCommit.length > 0 && sha.startsWith(ranCommit);
  if (!ranThisSha) return /** @type {any} */ ({});
  const passed = record.exit === 0;
  // A PASS is the one reading that releases, so it is the one that must agree with itself three ways.
  if (passed && (status !== 0 || record.outcome !== "success")) return /** @type {any} */ ({});
  return { exitCode: /** @type {number} */ (record.exit) };
}

/**
 * The label a reader finds the lab run by: the job and the systemd invocation the record names.
 * @param {JobRecord | undefined} record @returns {string | undefined}
 */
function runLabel(record) {
  return record && typeof record.invocation === "string" && record.invocation
    ? `${QUALIFIED_JOB}-${record.invocation}` : undefined;
}

/**
 * The qualification request on a command line: the sha, and the argv to dispatch (the flag stripped, the
 * ref pinned), or the reason this cannot be a qualified run. `undefined` when the flag is absent.
 *
 * @param {string[]} argv
 * @param {{ job: string | undefined, row: string | undefined, ref: string | undefined, describeOnly: boolean }} named
 * @returns {{ sha: string, row: number, argv: string[] } | { refusal: string } | undefined}
 */
export function qualificationRequest(argv, { job, row, ref, describeOnly }) {
  const flag = argv.find((arg) => arg.startsWith(QUALIFY_FLAG));
  if (flag === undefined) return undefined;
  const sha = flag.slice(QUALIFY_FLAG.length);
  try {
    requireFullSha(sha);
  } catch (error) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (job !== QUALIFIED_JOB || describeOnly) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: a \`qualification\` status is the verdict of ${QUALIFIED_JOB} alone, and `
      + `this command names ${describeOnly ? "a describe-only run, which runs nothing" : `job=${job ?? "(none)"}`}.` };
  }
  if (!/^\d+$/.test(row ?? "")) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: it needs -e row=<n>. The playbook records the job's exit code only for `
      + "a run bound to a row, and without that record there is no verdict to post." };
  }
  if (ref !== undefined && ref !== sha) {
    return { refusal: `REFUSING ${QUALIFY_FLAG}: -e ref=${ref} would run the lab at a different commit from the sha `
      + "being qualified. Drop the ref: it is set from the sha." };
  }
  const forwarded = argv.filter((arg) => !arg.startsWith(QUALIFY_FLAG));
  const pinned = ref === undefined ? [...forwarded, "-e", `ref=${sha}`] : forwarded;
  return { sha, row: Number(row), argv: pinned };
}

/**
 * `dispatch`, wrapped so the run announces itself and says how it ended. The returned function is the
 * dispatch `run` already takes, and `seen.state` is what the verdict post said (`undefined` if nothing was).
 *
 * @param {{ sha: string, row: number, dispatch: (forwarded: string[]) => number | void }} run
 * @param {Poster} poster
 * @param {{ state: string | undefined }} seen written to, so the caller can decide on the re-run
 * @returns {(forwarded: string[]) => number}
 */
export function announcingDispatch({ sha, row, dispatch }, { post, readRecord, now = Date.now, say = (text) => process.stdout.write(text) }, seen) {
  return (forwarded) => {
    const started = post({ sha, outcome: { started: true } });
    say(renderResult(started));
    if (!started.posted) {
      say(`qualification: ${QUALIFIED_JOB} was NOT dispatched, because its start could not be said on the sha.\n`);
      return started.reason === "no-credential" ? EXIT.NOT_YET : EXIT.REFUSED;
    }
    const since = now();
    const status = dispatch(forwarded) ?? 1;
    const record = readRecord({ job: QUALIFIED_JOB, row, since });
    const verdict = post({ sha, outcome: outcomeOf({ status, record, sha }), run: runLabel(record) });
    say(renderResult(verdict));
    seen.state = verdict.posted ? verdict.payload.state : undefined;
    return status;
  };
}

/**
 * Run the attempts: one, then ONE more if the first said `failure`. `attempt` is a whole `lab-job` run, so
 * the re-run goes through the same wake and staleness checks as the first.
 *
 * @param {{ attempt: (wrap: (dispatch: (forwarded: string[]) => number | void) => (forwarded: string[]) => number) => Promise<number | void>,
 *           announce: (dispatch: (forwarded: string[]) => number | void, seen: { state: string | undefined }) => (forwarded: string[]) => number,
 *           say?: (text: string) => void }} parts
 * @returns {Promise<number | void>} the last dispatch's status
 */
export async function runQualified({ attempt, announce, say = (text) => process.stdout.write(text) }) {
  /** @type {number | void} */
  let status = undefined;
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const seen = { state: undefined };
    status = await attempt((dispatch) => announce(dispatch, seen));
    if (seen.state !== "failure") break;
    if (n < MAX_ATTEMPTS) say(`qualification: first ${QUALIFIED_JOB} run said failure; re-running once on a fresh run (#3136).\n`);
  }
  return status;
}
