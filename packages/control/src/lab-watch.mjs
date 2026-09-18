// @ts-check
/**
 * Is any a11y-job-* unit failed right now, and if so, who has that reached?
 *
 * #866: "a failed unit becomes visible without anyone asking." `lab-status.yml`'s own "Failed units" task
 * already names one to a person who runs `npm run lab:status` -- this is the other half, the one that runs
 * unattended and posts to the org's own reading issue (#928, the same destination `org-watch.mjs` already
 * uses for the identical reason) so nobody has to go and ask.
 *
 * Reads `lab-status.yml`'s run through ansible's own `json` stdout callback -- a stable, documented
 * ansible-core feature -- rather than screen-scraping the human-facing debug block, so a wording change to
 * the display task can never break this reader. `ansible.cfg`'s checked-in `stdout_callback = default` is
 * untouched: the override is this one call's environment only, so a human running `lab:status` still sees
 * the ordinary formatted output.
 *
 * `--post` is the only way this ever writes anywhere; run with no flag it only reports what it would say.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { renderReport } from "./lab-failed-units.mjs";

/** @typedef {{ attention: boolean, entries: { unit: string, ageDescription: string }[] }} DescribedFailures */

/** Exit codes are the contract: 0 nothing needs attention, 1 something does, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

// MUST MATCH the task name in `lab-status.yml` exactly -- `extractReportJson` finds its result by this
// string, not by position, so the two can drift only if one of them is edited and not the other.
export const REPORT_TASK_NAME = "Failed units, as JSON (for lab-watch.mjs)";

export const ORG_READING_ISSUE = 928;

/** @typedef {(argv: string[], opts?: { env?: NodeJS.ProcessEnv }) => string} Runner */

/** @type {Runner} */
const defaultRun = (argv, opts) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", ...opts });

/**
 * `ansible-playbook lab-status.yml`, forced through the `json` stdout callback for this one call.
 * @param {Runner} run
 * @returns {unknown} the parsed callback document
 */
export function runLabStatus(run = defaultRun) {
  const out = run(["ansible-playbook", "packages/control/ansible/lab-status.yml"], {
    env: {
      ...process.env,
      ANSIBLE_CONFIG: "packages/control/ansible/ansible.cfg",
      ANSIBLE_STDOUT_CALLBACK: "json",
    },
  });
  return JSON.parse(out);
}

/**
 * The one task's result out of the whole run. The `json` callback's shape is `plays[].tasks[].task.name`
 * beside `hosts[<hostname>].stdout` -- one host, `a11y-lab`, in this fleet.
 * @param {unknown} playbookRun
 * @returns {string | null}
 */
export function extractReportJson(playbookRun) {
  const plays = /** @type {{ tasks?: { task?: { name?: string }, hosts?: Record<string, { stdout?: string }> }[] }[]} */ (
    /** @type {{ plays?: unknown[] }} */ (playbookRun)?.plays ?? []
  );
  for (const play of plays) {
    for (const task of play.tasks ?? []) {
      if (task.task?.name !== REPORT_TASK_NAME) continue;
      const stdout = Object.values(task.hosts ?? {})[0]?.stdout;
      if (typeof stdout === "string" && stdout.trim() !== "") return stdout.trim();
    }
  }
  return null;
}

/**
 * The comment this posts when something needs attention.
 * @param {DescribedFailures} described
 * @returns {string}
 */
export function watchBody(described) {
  return [
    `**${described.entries.length} a11y-job-* unit(s) in a \`failed\` state** (#866).`,
    ...renderReport(described).map((line) => `- ${line}`),
  ].join("\n");
}

/** @param {Runner} run */
function readDescribedFailures(run) {
  const reportJson = extractReportJson(runLabStatus(run));
  if (reportJson === null) {
    throw new Error("lab-status.yml's JSON report task did not run or produced nothing");
  }
  return /** @type {DescribedFailures} */ (JSON.parse(reportJson));
}

function main() {
  const post = process.argv.includes("--post");
  let described;
  try {
    described = readDescribedFailures(defaultRun);
  } catch (cause) {
    console.error(`CANNOT ASK: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = EXIT.CANNOT_ASK;
    return;
  }
  if (!described.attention) {
    process.exitCode = EXIT.QUIET;
    return;
  }
  const body = watchBody(described);
  console.log(body);
  if (post) {
    execFileSync("gh", ["issue", "comment", String(ORG_READING_ISSUE), "--body", body], { stdio: "inherit" });
  }
  process.exitCode = EXIT.ATTENTION;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
