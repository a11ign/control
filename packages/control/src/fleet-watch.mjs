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
 *
 * ## `unreachable` is the resting state, not a fault signal (#3023)
 *
 * Off is the fleet's normal state (`wake.yml`; `fleet:auto-off` powers it down on purpose), and `/health`
 * cannot tell a powered-off box from a dead one (`fleet:status`, #918) -- the auto-off stamp lives on the
 * control host, which this watch does not read. So an unreachable worker is never counted: 73 hourly posts
 * on #928 read a deliberately-off fleet as broken. A box that is genuinely dead is found when a capture
 * window wakes it and it does not return (`fleet:wake`, which tells `needs:chairman`).
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
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

/** Beside the two state files it sits with (#2979): `fleet-watch-state.json` and `fleet-auto-off-state.json`. */
export const DEFAULT_CAPTURES_STATE_PATH = "runs/fleet-captures-state.json";

const CAPTURE_WINDOW_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;

/** Exit codes are the contract: 0 nothing needs attention, 1 something does, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

/** @typedef {{name: string, state: string, captures?: number|null, uptimeMinutes?: number|null, readiness?: {reason?: string|null}|null}} FleetRow */
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

/** Not a fault signal: `ready` is fine, `busy` is occupied, and `unreachable` is the fleet's resting state. */
const RESTING_OR_OCCUPIED = new Set(["ready", "busy", "unreachable"]);

/**
 * One tick's worth of the ledger. A worker that ANSWERS and is not `ready` (and not merely `busy` --
 * occupied is not stuck) keeps its EXISTING first-seen timestamp if it has one, or gets `now` if this is the
 * first tick it was seen so. A worker that recovered is absent from the result entirely: it clears itself the
 * moment `fleet:status` next reports it `ready`, never lingering as a resolved entry to prune.
 *
 * `unreachable` is absent too, and here rather than only in `overdue`: the ledger keeps `since` across state
 * changes, so a box that wakes `warming` after two days off would otherwise arrive already "warming for 2d"
 * and fire the fault #1815 exists for on a healthy cold start (#3023).
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
    if (RESTING_OR_OCCUPIED.has(row.state)) continue;
    next[row.name] = previous[row.name] ?? now;
  }
  return next;
}

/**
 * ## When did the fleet last capture? (#2979, found by #2937)
 *
 * A worker's `/health` `captures` is a count since the worker BOOTED, with no time on it, so "is the fleet
 * idle while work waits" cannot be read off one snapshot -- the same missing-memory problem the non-ready
 * ledger above solves, for a different question. This is that memory: per worker, the last count seen, when
 * it was seen, when it last ROSE, and each rise inside the window.
 *
 * @typedef {{at: number, by: number}} Rise
 * @typedef {{captures: number, seenAt: number, lastRoseAt: number|null, rises: Rise[]}} WorkerCaptures
 * @typedef {{since: number, workers: Record<string, WorkerCaptures>}} CapturesState
 * @typedef {{captures24h: number, lastCaptureAt: number|null, observedSince: number}} CaptureTimes
 */

/** @param {unknown} value */
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** @param {any} worker */
function isWorkerCaptures(worker) {
  return Boolean(worker) && isNumber(worker.captures) && isNumber(worker.seenAt)
    && (worker.lastRoseAt === null || isNumber(worker.lastRoseAt))
    && Array.isArray(worker.rises)
    && worker.rises.every((/** @type {any} */ rise) => Boolean(rise) && isNumber(rise.at) && isNumber(rise.by));
}

/**
 * The persisted capture times. UNLIKE `readState`, a missing or corrupt file reads as `null`, not as empty:
 * an empty ledger answers "zero captures in 24 h", which is a claim about the fleet, and a file nobody could
 * read makes no such claim. One bad worker entry makes the whole file `null` for the same reason.
 *
 * @param {string} path
 * @param {(path: string, encoding: "utf8") => string} read
 * @returns {CapturesState|null}
 */
export function readCapturesState(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    const workers = parsed?.workers;
    const wellFormed = isNumber(parsed?.since) && Boolean(workers) && typeof workers === "object"
      && !Array.isArray(workers) && Object.values(workers).every(isWorkerCaptures);
    return wellFormed ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Replace a file whole or not at all. Two processes write the capture ledger (this watch hourly,
 * `fleet-auto-off.mjs` every tick, #3208), and a reader landing inside `writeFileSync`'s truncate-then-write
 * sees a half file, which `readCapturesState` reads as `null` and the next write turns into a fresh ledger
 * whose `since` starts over. A rename within one directory is atomic, so no reader sees anything between.
 * It does not serialize the two writers: a read-modify-write that interleaves with the other's can drop that
 * one's rise, but counts are cumulative, so the next probe of a worker still up re-derives it.
 *
 * @param {string} path
 * @param {string} data
 */
function replaceFile(path, data) {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, data);
  renameSync(staging, path);
}

/**
 * @param {string} path
 * @param {CapturesState} state
 * @param {(path: string, data: string) => void} write
 */
export function writeCapturesState(path, state, write = replaceFile) {
  write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The worker's name without its address. `fleetStatus` names a row `<inventory name>  <address>`, and a
 * worker woken by `wake.yml` can come back at a new address -- keyed whole it was a NEW worker and started at
 * a baseline again, losing what it did first (#3205). A worker the inventory does not name is its address.
 *
 * @param {string} name
 */
function workerKey(name) {
  return name.split("  ")[0];
}

/** @param {number|null} a @param {number|null} b */
function latest(a, b) {
  return a === null || b === null ? (a ?? b) : Math.max(a, b);
}

/**
 * Two entries for one worker (a ledger written when the key still carried the address, or after it moved):
 * the later reading's count, every rise of both, so a rename loses nothing the ledger already knew.
 *
 * @param {WorkerCaptures} one
 * @param {WorkerCaptures} other
 * @returns {WorkerCaptures}
 */
function mergeEntries(one, other) {
  const [older, newer] = one.seenAt <= other.seenAt ? [one, other] : [other, one];
  const rises = [...older.rises, ...newer.rises].sort((a, b) => a.at - b.at);
  return { ...newer, lastRoseAt: latest(older.lastRoseAt, newer.lastRoseAt), rises };
}

/** @param {Record<string, WorkerCaptures>} workers @returns {Record<string, WorkerCaptures>} */
function byWorkerKey(workers) {
  /** @type {Record<string, WorkerCaptures>} */
  const merged = {};
  for (const [name, entry] of Object.entries(workers)) {
    const key = workerKey(name);
    merged[key] = merged[key] ? mergeEntries(merged[key], entry) : entry;
  }
  return merged;
}

/**
 * How many captures a reading adds that the ledger has not counted. What the poll sees is a COUNT since
 * boot, so three things move it without a plain rise (#3205):
 *
 * - A count that FELL is a restart: the worker booted and counts from zero, and every capture it holds was
 *   taken since the last reading. Discarding them discarded exactly the work done between boot and the poll.
 * - A worker whose UPTIME is shorter than the time since the last reading booted in between, so its whole
 *   count is new even when it did not fall (it may have restarted and passed the old number).
 * - FIRST SIGHT counts only when the uptime says it booted after the ledger began: then every capture was
 *   taken inside the ledger. A longer uptime (or none: a row without `uptimeMinutes`) predates the ledger
 *   and is a baseline, so the first poll of a new ledger over a fleet that has run for weeks cannot read as
 *   a day of captures -- `since` equals `now` there, and no uptime is shorter than zero.
 *
 * @param {WorkerCaptures|undefined} previous
 * @param {{captures: number, uptimeMs: number|null}} reading
 * @param {{now: number, since: number}} when
 */
function newCaptures(previous, { captures, uptimeMs }, { now, since }) {
  const bootedSince = (/** @type {number} */ at) => uptimeMs !== null && uptimeMs < now - at;
  if (!previous) return bootedSince(since) ? captures : 0;
  const restarted = captures < previous.captures || bootedSince(previous.seenAt);
  return restarted ? captures : captures - previous.captures;
}

/**
 * One worker's entry after one reading. New captures record the time they were seen (the poll's own clock:
 * they happened somewhere since the last reading).
 *
 * @param {WorkerCaptures|undefined} previous
 * @param {{captures: number, uptimeMs: number|null}} reading
 * @param {{now: number, since: number}} when
 * @returns {WorkerCaptures}
 */
function advanceWorker(previous, reading, when) {
  const { now } = when;
  const rises = (previous?.rises ?? []).filter((rise) => now - rise.at < CAPTURE_WINDOW_MS);
  const by = newCaptures(previous, reading, when);
  if (by > 0) {
    return { captures: reading.captures, seenAt: now, lastRoseAt: now, rises: [...rises, { at: now, by }] };
  }
  return { captures: reading.captures, seenAt: now, lastRoseAt: previous?.lastRoseAt ?? null, rises };
}

/**
 * One tick's worth of the capture ledger. `previous: null` (nothing readable) starts a fresh ledger, whose
 * `since` is what lets a reader tell "no captures in 24 h" from "watched for a minute". A worker with no
 * count this tick (unreachable) is not a reading: its last entry stays exactly as it was, so a box that was
 * off and comes back with a higher count is a rise, and with a lower one a restart.
 *
 * @param {FleetRow[]} rows
 * @param {CapturesState|null} previous
 * @param {number} now
 * @returns {CapturesState}
 */
export function advanceCaptures(rows, previous, now) {
  const base = previous ?? { since: now, workers: {} };
  const known = byWorkerKey(base.workers);
  const workers = { ...known };
  for (const row of rows) {
    if (!isNumber(row.captures)) continue;
    const captures = /** @type {number} */ (row.captures);
    const uptimeMs = isNumber(row.uptimeMinutes) ? /** @type {number} */ (row.uptimeMinutes) * MS_PER_MINUTE : null;
    const reading = { captures, uptimeMs };
    const key = workerKey(row.name);
    workers[key] = advanceWorker(known[key], reading, { now, since: base.since });
  }
  return { since: base.since, workers };
}

/**
 * The two fields the gate asks for: captures across the fleet in the 24 h before `now`, and the latest
 * time any worker's count rose (however long ago -- it is what answers "idle since when"). `null` for an
 * unreadable ledger, never zero. `observedSince` rides along so a zero from a ledger started a minute ago
 * is not mistaken for a day of idleness.
 *
 * @param {CapturesState|null} state
 * @param {number} now
 * @returns {CaptureTimes|null}
 */
export function captureTimes(state, now) {
  if (!state) return null;
  const workers = Object.values(state.workers);
  const captures24h = workers.flatMap((worker) => worker.rises)
    .filter((rise) => now - rise.at < CAPTURE_WINDOW_MS)
    .reduce((sum, rise) => sum + rise.by, 0);
  const rose = workers.flatMap((worker) => (worker.lastRoseAt === null ? [] : [worker.lastRoseAt]));
  return { captures24h, lastCaptureAt: rose.length ? Math.max(...rose) : null, observedSince: state.since };
}

/**
 * @param {string} path
 * @param {number} now
 * @param {(path: string, encoding: "utf8") => string} read
 * @returns {CaptureTimes|null}
 */
export function readCaptureTimes(path, now, read = readFileSync) {
  return captureTimes(readCapturesState(path, read), now);
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
 * Fold one reading of the fleet into the persisted ledger. Exported so `fleet-auto-off.mjs` can feed the
 * same ledger from its own 10 s probe: the hourly poll alone never sees a worker that boots, works and is
 * powered off between two polls (#3208).
 *
 * @param {FleetRow[]} rows
 * @param {{ path: string, at: number, read?: typeof readFileSync, write?: typeof writeFileSync }} where
 */
export function recordCaptures(rows, { path, at, read, write }) {
  writeCapturesState(path, advanceCaptures(rows, readCapturesState(path, read), at), write);
}

/**
 * Read the live fleet, advance and persist the non-ready-since state and the capture times, and report who
 * is overdue.
 * Everything above this function is pure; this is the one place I/O and the clock meet, and every piece
 * of it is a parameter with a real default -- the shape `runLabStatus`'s `run` parameter already
 * established for the identical reason: a test drives this without a fleet, a fleet, or a clock.
 *
 * @param {{ getStatus?: StatusReader, now?: () => number, statePath?: string, capturesPath?: string,
 *           thresholdMs?: number, read?: typeof readFileSync, write?: typeof writeFileSync }} [deps]
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
  recordCaptures(status.rows, { path: deps.capturesPath ?? DEFAULT_CAPTURES_STATE_PATH, at, read: deps.read, write: deps.write });
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
