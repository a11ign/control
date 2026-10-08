// @ts-check
/**
 * Which a11y-job-* units are FAILED right now, and how long they have been -- named rather than left for a
 * reader to notice among `lab:status`'s undifferentiated list.
 *
 * #866, the 2026-09-18 amendment: "lab:status already knows; what is missing is anything that reports it."
 * Six units sat in `failed` for three days and nothing said so; a reader had to run `lab:status` and pick
 * `failed` out of a list that reads `active`, `inactive` and `failed` all the same way. This file is the
 * "which unit, what state, how long" that the row's acceptance names, kept pure and fixture-tested (never
 * touching the lab itself) exactly as the amendment describes it: `systemctl`'s output shape is stable and
 * already quoted, verbatim, in `lab-status.yml`'s own tasks.
 *
 * `lab-status.yml` calls this twice per run: once with `--list-failed` (which unit names are failed, from
 * `systemctl list-units`'s raw text) so the SUB-STATE regex lives in one tested place rather than in Jinja,
 * and once with `--report` (each failed unit's own `ActiveEnterTimestamp`, gathered by the playbook and
 * handed in as ansible's own loop-result JSON) to render the named, aged report. `--json` alongside
 * `--report` prints the same decision as one line of machine-readable JSON, for `lab-watch.mjs` to read
 * without re-parsing prose.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";

/** Exit codes are the contract: 0 nothing failed, 1 something did. */
export const EXIT = { QUIET: 0, ATTENTION: 1 };

// `systemctl list-units --all --plain --no-legend a11y-job-*`: UNIT LOAD ACTIVE SUB, then a free-text
// description. #866's own open-check (`lab:status | grep -c "loaded failed failed"`) reads this exact
// shape by eye; ACTIVE and SUB are both checked here, rather than assuming LOAD is always `loaded`.
const UNIT_LINE = /^(a11y-job-\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)/;

/**
 * @param {string} listUnitsOutput raw stdout of `systemctl list-units --all --plain --no-legend a11y-job-*`
 * @returns {{ unit: string, load: string, active: string, sub: string }[]}
 */
export function parseUnitList(listUnitsOutput) {
  const rows = [];
  for (const line of listUnitsOutput.split("\n")) {
    const match = UNIT_LINE.exec(line);
    if (match) rows.push({ unit: match[1], load: match[2], active: match[3], sub: match[4] });
  }
  return rows;
}

/** @param {{ unit: string, active: string, sub: string }[]} units @returns {string[]} */
export function failedUnitNames(units) {
  return units.filter((u) => u.active === "failed" && u.sub === "failed").map((u) => u.unit);
}

/** @param {number} ms @returns {string} */
function humanizeAge(ms) {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * How long a unit has carried `failed` -- systemd's own `ActiveEnterTimestamp`, the moment it entered its
 * CURRENT state, which for a unit sitting in `failed` is the failure itself. Passed through unconverted:
 * `Date.parse` reads systemd's UTC rendering directly, the same rule `lab-status.yml`'s progress task
 * already relies on for the identical reason.
 *
 * `null` for `n/a`/empty (never active) or an unparseable stamp -- an unknown age must not read as zero.
 * @param {string | undefined} activeEnterTimestamp
 * @param {Date} now
 * @returns {{ ms: number, humanized: string } | null}
 */
export function failureAge(activeEnterTimestamp, now) {
  const trimmed = (activeEnterTimestamp ?? "").trim();
  if (trimmed === "" || trimmed === "n/a") return null;
  const at = Date.parse(trimmed);
  const ms = now.getTime() - at;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return { ms, humanized: humanizeAge(ms) };
}

/**
 * Ansible's own loop-result shape (`{results: [...]}` from a registered, looped task) reduced to the two
 * fields this file needs. Ansible carries a dozen more per result (`cmd`, `rc`, `invocation`, ...); reading
 * only `item`/`stdout` is deliberate rather than incomplete.
 * @param {{ item: string, stdout?: string }[]} results
 * @returns {{ unit: string, activeEnterTimestamp: string }[]}
 */
export function unitsFromAnsibleResults(results) {
  return results.map((r) => ({ unit: r.item, activeEnterTimestamp: r.stdout ?? "" }));
}

/**
 * Every failed unit, named and aged -- or nothing, when none are failed. `attention` is the same
 * QUIET/ATTENTION contract `org-watch.mjs` already uses: silent when clean, and never silent because it
 * did not look.
 * @param {{ unit: string, activeEnterTimestamp: string }[]} units
 * @param {Date} now
 * @returns {{ attention: boolean, entries: { unit: string, ageDescription: string }[] }}
 */
export function describeFailures(units, now) {
  const entries = units
    .map(({ unit, activeEnterTimestamp }) => {
      const age = failureAge(activeEnterTimestamp, now);
      return { unit, ageDescription: age ? `${age.humanized} ago` : "an unreadable or unknown time" };
    })
    .sort((a, b) => a.unit.localeCompare(b.unit));
  return { attention: entries.length > 0, entries };
}

/**
 * One line per failed unit -- unit, state and age, exactly what #866's acceptance names -- or one line
 * saying there is nothing to report. `lab:status` already prints every unit; this is the difference: a
 * reader does not have to notice `failed` themselves.
 * @param {ReturnType<typeof describeFailures>} described
 * @returns {string[]}
 */
export function renderReport(described) {
  if (!described.attention) return ["no a11y-job-* unit is in a failed state"];
  return described.entries.map(({ unit, ageDescription }) => `${unit}: failed, since ${ageDescription}`);
}

/** @returns {string} */
function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch (cause) {
    throw new Error("could not read stdin", { cause });
  }
}

function runListFailed() {
  const names = failedUnitNames(parseUnitList(readStdin()));
  process.stdout.write(names.length > 0 ? `${names.join("\n")}\n` : "");
}

/** @param {{ json: boolean }} options */
function runReport({ json }) {
  const stdin = readStdin().trim();
  const results = stdin === "" ? [] : JSON.parse(stdin);
  const described = describeFailures(unitsFromAnsibleResults(results), new Date());
  process.stdout.write(json ? `${JSON.stringify(described)}\n` : `${renderReport(described).join("\n")}\n`);
  process.exitCode = described.attention ? EXIT.ATTENTION : EXIT.QUIET;
}

function main() {
  refuseUnknownFlags(["--list-failed", "--report", "--json"], {
    entry: import.meta.url,
    command: "node packages/control/src/lab-failed-units.mjs",
  });
  if (process.argv.includes("--list-failed")) {
    runListFailed();
    return;
  }
  if (process.argv.includes("--report")) {
    runReport({ json: process.argv.includes("--json") });
    return;
  }
  console.error("  node packages/control/src/lab-failed-units.mjs: pass --list-failed or --report");
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) main();
