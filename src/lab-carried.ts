/**
 * What `post-qualification-status.ts` needs from the lab's qualification verdict, carried HERE so the poster loads from control's raw
 * checkout (a11ign#5372, ceo's ruling on a11ign#5335). The lab publishes no package and control takes no dependency on it (ADR 0012), and
 * control's CI does not lay the core's `lab/`, so the originals cannot be reached by a relative path from here.
 *
 * EVERY DECLARATION BELOW IS A COPY, taken verbatim from the lab file named above it:
 *   a11ign/lab `src/gates/verdict.ts`: GateVerdict, exitCodeFor
 *   a11ign/lab `src/gates/qualification-status.ts`: QUALIFICATION_CONTEXT, QUALIFICATION_GATE, StatusPayload, Outcome, qualificationStatus
 * This module owns none of them and adds none. The drift guard lives in the LAB, which tests this copy against the original on the same
 * inputs, because control's CI cannot load the original.
 *
 * Imports nothing: the control plane runs from a raw checkout with no `node_modules`.
 */

// ======================================================================================================================
// verdict
// carried from a11ign/lab src/gates/verdict.ts
// ======================================================================================================================

export type GateVerdict = {
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  examined: number;
  of: number;
  source: string;
  failures: number;
  why: string;
};

/** The process exit code this repo's gates use: 0 clean, 1 a real failure, 2 could not tell. */
export function exitCodeFor(v: GateVerdict) {
  return v.verdict === "PASS" ? 0 : v.verdict === "FAIL" ? 1 : 2;
}

// ======================================================================================================================
// qualification-status
// carried from a11ign/lab src/gates/qualification-status.ts
// ======================================================================================================================

/** The status context the release reads. One fact: #3136's reader and the poster must agree on it. */
export const QUALIFICATION_CONTEXT = "qualification";

/** The gate this status is a verdict on, named in every description. */
export const QUALIFICATION_GATE = "gate:stability";

/** GitHub rejects a status description longer than this. */
const DESCRIPTION_LIMIT = 140;

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** The exit codes `verdict.mjs` defines. Anything else is not a verdict. */
const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 2;

export type StatusPayload = { state: "pending" | "success" | "failure"; context: string; description: string };

/**
 * What the poster knows. `started` is the run beginning; `verdict` is a `GateVerdict` the lab printed;
 * `exitCode` is the job's exit status. A caller that has none of them passes `{}`, and gets `failure`.
 */
export type Outcome =
  | { started: true }
  | { verdict: { verdict?: unknown; why?: unknown } }
  | { exitCode: unknown };

/**
 * @param {unknown} sha @returns {string}
 */
function requireSha(sha: unknown): string {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    // THROWN, not a failure payload: a status posted to a malformed sha lands on nothing, so there is no
    // honest payload to return. The poster turns the throw into a refusal that names the value.
    throw new Error(`a qualification status needs a full 40-character lowercase sha, got ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * One line that names the gate, the scope and the run, within GitHub's limit. The part that varies
 * (`detail`) is what gets trimmed, never the gate name or the scope.
 * @param {{ lead: string, detail: string, run?: string }} parts @returns {string}
 */
function describe({ lead, detail, run }: { lead: string; detail: string; run?: string; }): string {
  const fixed = `${lead} ${QUALIFICATION_GATE} (fleet part only)`;
  const suffix = run ? ` [${run}]` : "";
  const room = DESCRIPTION_LIMIT - fixed.length - suffix.length - " -- ".length;
  const trimmed = detail.length > room ? `${detail.slice(0, Math.max(0, room - 1))}…` : detail;
  return `${fixed}${trimmed ? ` -- ${trimmed}` : ""}${suffix}`.slice(0, DESCRIPTION_LIMIT);
}

/**
 * The exit code a verdict object stands for, or `undefined` if it is not a readable `GateVerdict`.
 * Goes through `exitCodeFor` so the 0/1/2 meaning is stated once, in `verdict.mjs`.
 * @param {{ verdict?: unknown }} candidate @returns {number | undefined}
 */
function codeOfVerdict(candidate: { verdict?: unknown; }): number | undefined {
  const name = candidate.verdict;
  if (name !== "PASS" && name !== "FAIL" && name !== "INCONCLUSIVE") return undefined;
  return exitCodeFor(candidate as GateVerdict);
}

/**
 * @param {Outcome | undefined} outcome @returns {{ code: number | undefined, detail: string }}
 */
function readOutcome(outcome: Outcome | undefined): { code: number | undefined; detail: string; } {
  if (outcome && "verdict" in outcome && outcome.verdict && typeof outcome.verdict === "object") {
    const why = typeof outcome.verdict.why === "string" ? outcome.verdict.why : "";
    return { code: codeOfVerdict(outcome.verdict), detail: why };
  }
  if (outcome && "exitCode" in outcome && Number.isInteger(outcome.exitCode)) {
    return { code: outcome.exitCode as number, detail: "" };
  }
  return { code: undefined, detail: "" };
}

/**
 * The status to post for one moment in a run.
 *
 * @param {{ sha: unknown, outcome?: Outcome, run?: string }} input
 *   `run` names the lab run (the unit and when it ended) so a reader can find it; optional only because a
 *   `pending` post is made before the run has a name worth quoting.
 * @returns {StatusPayload}
 */
export function qualificationStatus({ sha, outcome, run }: { sha: unknown; outcome?: Outcome; run?: string; }): StatusPayload {
  requireSha(sha);
  const base = { context: QUALIFICATION_CONTEXT };
  if (outcome && "started" in outcome && outcome.started === true) {
    return { ...base, state: "pending", description: describe({ lead: "running", detail: "", run }) };
  }
  const { code, detail } = readOutcome(outcome);
  if (code === EXIT_PASS) {
    return { ...base, state: "success", description: describe({ lead: "PASS", detail, run }) };
  }
  if (code === EXIT_FAIL) {
    return { ...base, state: "failure", description: describe({ lead: "FAIL", detail, run }) };
  }
  if (code === EXIT_INCONCLUSIVE) {
    return { ...base, state: "failure",
      description: describe({ lead: "INCONCLUSIVE", detail: detail || "could not tell, not a pass", run }) };
  }
  // Missing, unparseable, or an exit code that is none of 0/1/2 (127 is "the job is not wired", a signal
  // is "the job was killed"): none of these is a reading, so none of them may be a `success`.
  const said = code === undefined ? "no readable verdict" : `exit ${code} is not a verdict`;
  return { ...base, state: "failure",
    description: describe({ lead: "NO VERDICT", detail: `${said}, not a pass`, run }) };
}
