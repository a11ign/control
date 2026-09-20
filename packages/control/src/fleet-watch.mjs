// @ts-check
/**
 * A worker stuck non-`ready` is invisible to every cause in this org -- #1815. `fleet:status` reports it
 * perfectly (`stateOf`, `fleet-status.mjs`); nothing reads it except a human typing the command. Three
 * real workers sat WARMING for hours to days -- `a11y-worker-4` (4.9 days), `a11y-worker-10` (4.6 days),
 * `a11y-worker-3` (same day) -- with nine healthy workers idle behind each, cleared only when someone
 * happened to run `fleet:status` by hand and noticed.
 *
 * `lab-watch.mjs` already solved the identical shape one subsystem over: "nothing reads `lab-status.yml`
 * on a schedule" became a script the host schedules (`agent-practices.md`'s "no standing cron" rule,
 * already applied once to `work:tick`), never a session-held `CronCreate`. This follows the same shape --
 * `--post` is the only way this ever writes anywhere; run with no flag it only reports what it would say.
 *
 * ## The one thing `lab-watch.mjs` did not need: memory between runs
 *
 * `lab-status.yml` reports a unit's OWN `activeEnterTimestamp` -- systemd remembers since-when for free.
 * `fleet:status` has no such field: `stateOf` answers `warming`/`ready`/`busy`/`unreachable` for RIGHT
 * NOW, never since when. A scheduled script is a fresh process every run, with no memory of the last one
 * -- so "how long has this worker been stuck" cannot be read off one snapshot alone. `readState`/
 * `writeState` below are that memory, kept in the smallest form that answers the question: one
 * first-seen timestamp per non-ready worker, in `runs/` (gitignored, already the home of the board
 * snapshots `row-claim.mjs` writes for the identical local-scratch reason).
 *
 * A worker that recovers is DROPPED from the state, not marked resolved -- `.claude/rules/
 * agent-practices.md`'s "a waiting condition is DATA, not a sentence": clearing itself the moment the
 * condition clears is the whole point, and it is why `advance` below has no code path that writes
 * anything for a `ready` or `busy` row.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fleetStatus } from "./fleet-status.mjs";

export const ORG_READING_ISSUE = 928;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * Warm-up itself retries `MAX_WARM_ATTEMPTS` (3) times, `WARM_RETRY_COOLDOWN_MS` (30 s) apart --
 * `server.mjs` -- so a threshold an order of magnitude above that clears every normal boot. Still an
 * order of magnitude below the shortest real incident this row measured (hours), so it catches all
 * three. Tunable with `--threshold-ms=`.
 */
export const DEFAULT_THRESHOLD_MS = 10 * MS_PER_MINUTE;

export const DEFAULT_STATE_PATH = "runs/fleet-watch-state.json";

/** Exit codes are the contract: 0 nothing needs attention, 1 something does, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** @typedef {{name: string, state: string, readiness?: {reason?: string|null}|null}} FleetRow */
/** @typedef {Record<string, number>} SinceState */

/**
 * `watch` only ever reads `.rows` off whatever `fleetStatus` returns, so it is typed against exactly
 * that -- not `typeof fleetStatus` -- which is what lets a fixture return `{rows: [...]}` alone rather
 * than every other field the real function happens to also produce.
 * @typedef {() => Promise<{rows: FleetRow[]}>} StatusReader
 */

/**
 * The persisted "non-ready since" state. A missing or corrupt file reads as EMPTY, never as a crash --
 * the first tick after this ships, and any tick after the file is hand-deleted, must not take the
 * watcher itself down over its own bookkeeping. The same "absent is not a failure" contract
 * `desktop-prepare.mjs`'s caches already carry, one layer over.
 *
 * @param {string} path
 * @param {(path: string, encoding: "utf8") => string} read
 * @returns {SinceState}
 */
export function readState(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} path
 * @param {SinceState} state
 * @param {(path: string, data: string) => void} write
 */
export function writeState(path, state, write = writeFileSync) {
  write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * One tick's worth of the ledger. A worker not `ready` (and not merely `busy` -- occupied is not stuck)
 * keeps its EXISTING first-seen timestamp if it has one, or gets `now` if this is the first tick it was
 * ever seen non-ready. A worker that recovered is absent from the result entirely: it clears itself the
 * moment `fleet:status` next reports it `ready`, never lingering as a resolved entry to prune.
 *
 * @param {FleetRow[]} rows
 * @param {SinceState} previous
 * @param {number} now
 * @returns {SinceState}
 */
export function advance(rows, previous, now) {
  /** @type {SinceState} */
  const next = {};
  for (const row of rows) {
    if (row.state === "ready" || row.state === "busy") continue;
    next[row.name] = previous[row.name] ?? now;
  }
  return next;
}

/** @typedef {{name: string, state: string, ageMs: number, reason: string|null}} OverdueEntry */

/**
 * Workers non-ready for at least `thresholdMs`, oldest first -- the only ones a cause should ever fire
 * for. A worker warming for mere seconds has a `since` of `now` (or close to it) and never reaches this
 * list: the positive control this row exists to keep, proven in the fixtures below rather than argued.
 *
 * @param {FleetRow[]} rows
 * @param {SinceState} state
 * @param {number} now
 * @param {number} thresholdMs
 * @returns {OverdueEntry[]}
 */
export function overdue(rows, state, now, thresholdMs) {
  return rows
    .filter((row) => state[row.name] !== undefined && now - state[row.name] >= thresholdMs)
    .map((row) => ({ name: row.name, state: row.state, ageMs: now - state[row.name],
      reason: row.readiness?.reason ?? null }))
    .sort((a, b) => b.ageMs - a.ageMs);
}

/** @param {number} ms */
function describeAge(ms) {
  const minutesPerDay = MINUTES_PER_HOUR * HOURS_PER_DAY;
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  const days = Math.floor(totalMinutes / minutesPerDay);
  const hours = Math.floor((totalMinutes % minutesPerDay) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (days > 0) return `${days}d${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

/**
 * The comment this posts when something needs attention.
 * @param {OverdueEntry[]} entries
 * @returns {string}
 */
export function watchBody(entries) {
  return [
    `**${entries.length} worker(s) non-\`ready\` past the threshold** (#1815).`,
    ...entries.map((e) => `- \`${e.name}\` ${e.state} for ${describeAge(e.ageMs)}`
      + (e.reason ? ` -- ${e.reason}` : "")),
    "`npm run fleet:recover -- --limit=<name>` clears a held foreground worker without a console reboot; "
    + "`npm run fleet:status` for the live reading.",
  ].join("\n");
}

/**
 * Read the live fleet, advance and persist the non-ready-since state, and report who is overdue.
 * Everything above this function is pure; this is the one place I/O and the clock meet, and every piece
 * of it is a parameter with a real default -- the shape `runLabStatus`'s `run` parameter already
 * established for the identical reason: a test drives this without a fleet, a fleet, or a clock.
 *
 * @param {{ getStatus?: StatusReader, now?: () => number, statePath?: string, thresholdMs?: number,
 *           read?: typeof readFileSync, write?: typeof writeFileSync }} [deps]
 * @returns {Promise<OverdueEntry[]>}
 */
export async function watch(deps = {}) {
  const getStatus = deps.getStatus ?? fleetStatus;
  const now = deps.now ?? Date.now;
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH;
  const thresholdMs = deps.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const status = await getStatus();
  const at = now();
  const previous = readState(statePath, deps.read);
  const next = advance(status.rows, previous, at);
  writeState(statePath, next, deps.write);
  return overdue(status.rows, next, at, thresholdMs);
}

async function main() {
  const post = process.argv.includes("--post");
  const thresholdArg = process.argv.find((a) => a.startsWith("--threshold-ms="));
  const thresholdMs = thresholdArg ? Number(thresholdArg.slice("--threshold-ms=".length)) : undefined;
  let entries;
  try {
    entries = await watch(thresholdMs === undefined ? {} : { thresholdMs });
  } catch (cause) {
    console.error(`CANNOT ASK: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = EXIT.CANNOT_ASK;
    return;
  }
  if (!entries.length) {
    process.exitCode = EXIT.QUIET;
    return;
  }
  const body = watchBody(entries);
  console.log(body);
  if (post) {
    execFileSync("gh", ["issue", "comment", String(ORG_READING_ISSUE), "--body", body], { stdio: "inherit" });
  }
  process.exitCode = EXIT.ATTENTION;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
