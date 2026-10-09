// @ts-check
/**
 * A worker stuck non-`ready` is invisible to every cause in this org -- #1815. `fleet:status` reports it
 * perfectly (`stateOf`, `fleet-status.ts`); nothing reads it except a human typing the command. Three
 * real workers sat WARMING for hours to days -- `a11y-worker-4` (4.9 days), `a11y-worker-10` (4.6 days),
 * `a11y-worker-3` (same day) -- with nine healthy workers idle behind each, cleared only when someone
 * happened to run `fleet:status` by hand and noticed.
 *
 * `lab-watch.ts` already solved the identical shape one subsystem over: "nothing reads `lab-status.yml`
 * on a schedule" became a script the host schedules (`agent-practices.md`'s "no standing cron" rule,
 * already applied once to `work:tick`), never a session-held `CronCreate`. This follows the same shape --
 * `--post` is the only way this ever writes anywhere; run with no flag it only reports what it would say.
 *
 * ## The one thing `lab-watch.ts` did not need: memory between runs
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
 *
 * ## A box off the fleet's build or display mode, before capture day (#4447, under #4405)
 *
 * The first anyone heard that a box was on another Windows build or display mode was the capture that refused it.
 * This reads the two fields off the drift `fleetStatus` already computes (`mismatches` for `displayMode`,
 * `reportedOnly` for `windowsBuild`, each with the reporting guests' values keyed by URL) and names the odd box.
 * "The fleet's value" is the MODAL one among reachable boxes: a tie (which is what fewer than three disagreeing boxes always
 * are) has no fleet value to be off from, so it raises `fleet-split: <values>` rather than naming one nobody holds.
 *
 * Its first-seen ledger is a SIBLING file (`DEFAULT_OFF_FLEET_STATE_PATH`), not `fleet-watch-state.json`: agent-org's
 * `readFleetRoster` reads every key of that file as a non-ready WORKER NAME, so a key like `a11y-worker-3: build ...`
 * would read as a down worker. The shape and the clearing are the same: an entry for a box that returned to the fleet's
 * value is DROPPED. An unreachable box is the resting state (#3023): never counted, and its entries are carried
 * unchanged rather than dropped, so a box that sleeps odd and wakes odd is not announced a second time.
 */
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fleetStatus } from "./fleet-status.ts";
import { sshToControlPlane } from "./control-plane-fleet.ts";
import { CONTROL_PLANE_CHECKOUT } from "./control-plane-checkout.ts";

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
/** Written by `fleet-auto-off.ts`; here so the path is one fact and the import points only one way. */
export const AUTO_OFF_STATE_PATH = "runs/fleet-auto-off-state.json";

/**
 * Where this watch mirrors what it read of `AUTO_OFF_STATE_PATH` on the control plane, for `org-health` on the agents
 * host (a11ign/agent-org#311 reads this same string). The agents host's own copy of the state path is a leftover that
 * reads CLEAR through a standing refusal, and the tick may not ssh (#3566), so the one reader that reaches the record
 * leaves it where the tick can read it (#3860, incident #3846).
 */
export const AUTO_OFF_MIRROR_PATH = "runs/fleet-auto-off-mirror.json";

export const DEFAULT_CAPTURES_STATE_PATH = "runs/fleet-captures-state.json";

/** First-seen ledger of the off-fleet lines already posted. Not `DEFAULT_STATE_PATH`: see the header. */
export const DEFAULT_OFF_FLEET_STATE_PATH = "runs/fleet-off-fleet-state.json";

/**
 * The file `fleet:patch`'s timer (#4446) writes on the CONTROL HOST when a patch run completes, `{"lastRunAt": <epoch ms>}`.
 * That row owns the writer; this is the contract it must meet, and this watch reads it the way it reads the auto-off record.
 */
export const PATCH_RUN_PATH = "runs/fleet-patch-last-run.json";

const CAPTURE_WINDOW_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;

/** Exit codes are the contract: 0 nothing needs attention, 1 something does, 2 could not ask. */
export const EXIT = { QUIET: 0, ATTENTION: 1, CANNOT_ASK: 2 };

export type FleetRow = {name: string, url?: string, state: string, captures?: number|null, uptimeMinutes?: number|null, readiness?: {reason?: string|null}|null};
export type SinceState = Record<string, number>;

/** One field the guests disagree about, as `fleetConsistency` reports it: `values` is keyed by the guest's URL. */
export type Drift = {field: string, values: Record<string, unknown>};
export type StatusReader = () => Promise<{rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[]}>;
/**
 * `watch` only ever reads `.rows` off whatever `fleetStatus` returns, so it is typed against exactly
 * that -- not `typeof fleetStatus` -- which is what lets a fixture return `{rows: [...]}` alone rather
 * than every other field the real function happens to also produce.
 */

/**
 * The persisted "non-ready since" state. A missing or corrupt file reads as EMPTY, never as a crash --
 * the first tick after this ships, and any tick after the file is hand-deleted, must not take the
 * watcher itself down over its own bookkeeping. The same "absent is not a failure" contract
 * `desktop-prepare.mjs`'s caches already carry, one layer over.
 */
export function readState(path: string, read: (path: string, encoding: "utf8") => string = readFileSync): SinceState {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeState(path: string, state: SinceState, write: (path: string, data: string) => void = writeFileSync) {
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
 */
export function advance(rows: FleetRow[], previous: SinceState, now: number): SinceState {
  const next: SinceState = {};
  for (const row of rows) {
    if (RESTING_OR_OCCUPIED.has(row.state)) continue;
    next[row.name] = previous[row.name] ?? now;
  }
  return next;
}

export type Rise = {at: number, by: number};
export type WorkerCaptures = {captures: number, seenAt: number, lastRoseAt: number|null, rises: Rise[]};
export type CapturesState = {since: number, workers: Record<string, WorkerCaptures>};
export type CaptureTimes = {captures24h: number, lastCaptureAt: number|null, observedSince: number};
/**
 * ## When did the fleet last capture? (#2979, found by #2937)
 *
 * A worker's `/health` `captures` is a count since the worker BOOTED, with no time on it, so "is the fleet
 * idle while work waits" cannot be read off one snapshot -- the same missing-memory problem the non-ready
 * ledger above solves, for a different question. This is that memory: per worker, the last count seen, when
 * it was seen, when it last ROSE, and each rise inside the window.
 */

const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

function isWorkerCaptures(worker: Partial<WorkerCaptures> | null | undefined): worker is WorkerCaptures {
  if (!worker) return false;
  return isNumber(worker.captures) && isNumber(worker.seenAt)
    && (worker.lastRoseAt === null || isNumber(worker.lastRoseAt))
    && Array.isArray(worker.rises)
    && worker.rises.every((rise) => Boolean(rise) && isNumber(rise.at) && isNumber(rise.by));
}

/**
 * The persisted capture times. UNLIKE `readState`, a missing or corrupt file reads as `null`, not as empty:
 * an empty ledger answers "zero captures in 24 h", which is a claim about the fleet, and a file nobody could
 * read makes no such claim. One bad worker entry makes the whole file `null` for the same reason.
 */
export function readCapturesState(path: string, read: (path: string, encoding: "utf8") => string = readFileSync): CapturesState | null {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    const workers = parsed?.workers;
    const wellFormed = isNumber(parsed?.since) && Boolean(workers) && typeof workers === "object"
      && !Array.isArray(workers) && Object.values(workers as Record<string, WorkerCaptures>).every(isWorkerCaptures);
    return wellFormed ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Replace a file whole or not at all. Two processes write the capture ledger (this watch hourly,
 * `fleet-auto-off.ts` every tick, #3208), and a reader landing inside `writeFileSync`'s truncate-then-write
 * sees a half file, which `readCapturesState` reads as `null` and the next write turns into a fresh ledger
 * whose `since` starts over. A rename within one directory is atomic, so no reader sees anything between.
 * The rename does not stop two read-modify-writes interleaving; `withFileLock` does.
 */
function replaceFile(path: string, data: string) {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, data);
  renameSync(staging, path);
}

/** A lock held longer than this belongs to a writer that died: the critical section is a read and a rename. */
const LOCK_STALE_MS = 2000;
const LOCK_RETRY_MS = 5;

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock that vanished between the failed create and this look is not stale; the next create decides. */
function lockIsStale(lock: string) {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function acquire(lock: string) {
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (lockIsStale(lock)) rmSync(lock, { force: true });
    else sleep(LOCK_RETRY_MS);
  }
}

/**
 * Run `fn` holding an exclusive lock file beside `path`, so the hourly watch and the 10 s auto-off tick cannot
 * both read state S and rename S+A and S+B over each other, which drops A (#3208: A may be the last reading a
 * worker ever gives). Creation with `wx` is atomic. A lock older than `LOCK_STALE_MS` is taken to be a dead
 * writer's and broken; two processes breaking the same stale lock at once can both proceed, which needs a
 * crash inside the critical section first.
 *
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @returns {T}
 */
export function withFileLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  acquire(lock);
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * A test double has no file to lock, so an injected writer runs `fn` bare.
 */
const unlocked: typeof withFileLock = (_path, fn) => fn();

export function writeCapturesState(path: string, state: CapturesState, write: (path: string, data: string) => void = replaceFile) {
  write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The worker's name without its address. `fleetStatus` names a row `<inventory name>  <address>`, and a
 * worker woken by `wake.yml` can come back at a new address -- keyed whole it was a NEW worker and started at
 * a baseline again, losing what it did first (#3205). A worker the inventory does not name is its address.
 */
function workerKey(name: string) {
  return name.split("  ")[0];
}

function latest(a: number | null, b: number | null) {
  return a === null || b === null ? (a ?? b) : Math.max(a, b);
}

/**
 * Two entries for one worker (a ledger written when the key still carried the address, or after it moved):
 * the later reading's count, every rise of both, so a rename loses nothing the ledger already knew.
 */
function mergeEntries(one: WorkerCaptures, other: WorkerCaptures): WorkerCaptures {
  const [older, newer] = one.seenAt <= other.seenAt ? [one, other] : [other, one];
  const rises = [...older.rises, ...newer.rises].sort((a, b) => a.at - b.at);
  return { ...newer, lastRoseAt: latest(older.lastRoseAt, newer.lastRoseAt), rises };
}

function byWorkerKey(workers: Record<string, WorkerCaptures>): Record<string, WorkerCaptures> {
  const merged: Record<string, WorkerCaptures> = {};
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
 */
function newCaptures(previous: WorkerCaptures | undefined, { captures, uptimeMs }: { captures: number; uptimeMs: number | null; }, { now, since }: { now: number; since: number; }) {
  const bootedSince = (at: number) => uptimeMs !== null && uptimeMs < now - at;
  if (!previous) return bootedSince(since) ? captures : 0;
  const restarted = captures < previous.captures || bootedSince(previous.seenAt);
  return restarted ? captures : captures - previous.captures;
}

/**
 * One worker's entry after one reading. New captures record the time they were seen (the poll's own clock:
 * they happened somewhere since the last reading).
 */
function advanceWorker(previous: WorkerCaptures | undefined, reading: { captures: number; uptimeMs: number | null; }, when: { now: number; since: number; }): WorkerCaptures {
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
 */
export function advanceCaptures(rows: FleetRow[], previous: CapturesState | null, now: number): CapturesState {
  const base = previous ?? { since: now, workers: {} };
  const known = byWorkerKey(base.workers);
  const workers = { ...known };
  for (const row of rows) {
    if (!isNumber(row.captures)) continue;
    const captures = (row.captures as number);
    const uptimeMs = isNumber(row.uptimeMinutes) ? (row.uptimeMinutes as number) * MS_PER_MINUTE : null;
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
 */
export function captureTimes(state: CapturesState | null, now: number): CaptureTimes | null {
  if (!state) return null;
  const workers = Object.values(state.workers);
  const captures24h = workers.flatMap((worker) => worker.rises)
    .filter((rise) => now - rise.at < CAPTURE_WINDOW_MS)
    .reduce((sum, rise) => sum + rise.by, 0);
  const rose = workers.flatMap((worker) => (worker.lastRoseAt === null ? [] : [worker.lastRoseAt]));
  return { captures24h, lastCaptureAt: rose.length ? Math.max(...rose) : null, observedSince: state.since };
}

export function readCaptureTimes(path: string, now: number, read: (path: string, encoding: "utf8") => string = readFileSync): CaptureTimes | null {
  return captureTimes(readCapturesState(path, read), now);
}

export type OverdueEntry = {name: string, state: string, ageMs: number, reason: string|null};

/**
 * Workers non-ready for at least `thresholdMs`, oldest first -- the only ones a cause should ever fire
 * for. A worker warming for mere seconds has a `since` of `now` (or close to it) and never reaches this
 * list: the positive control this row exists to keep, proven in the fixtures below rather than argued.
 */
export function overdue(rows: FleetRow[], state: SinceState, now: number, thresholdMs: number): OverdueEntry[] {
  return rows
    .filter((row) => state[row.name] !== undefined && now - state[row.name] >= thresholdMs)
    .map((row) => ({ name: row.name, state: row.state, ageMs: now - state[row.name],
      reason: row.readiness?.reason ?? null }))
    .sort((a, b) => b.ageMs - a.ageMs);
}

function describeAge(ms: number) {
  const minutesPerDay = MINUTES_PER_HOUR * HOURS_PER_DAY;
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  const days = Math.floor(totalMinutes / minutesPerDay);
  const hours = Math.floor((totalMinutes % minutesPerDay) / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (days > 0) return `${days}d${String(hours).padStart(2, "0")}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m`;
}

/** The comment this posts when something needs attention. */
export function watchBody(entries: OverdueEntry[]): string {
  return [
    `**${entries.length} worker(s) non-\`ready\` past the threshold** (#1815).`,
    ...entries.map((e) => `- \`${e.name}\` ${e.state} for ${describeAge(e.ageMs)}`
      + (e.reason ? ` -- ${e.reason}` : "")),
    "`npm run fleet:recover -- --limit=<name>` clears a held foreground worker without a console reboot; "
    + "`npm run fleet:status` for the live reading.",
  ].join("\n");
}

/** What this watch has to say about the fleet itself: a line to post, and the box it names (`null` for a fleet-wide line). */
export type Oddity = {line: string, box: string | null};
type BoxValue = {box: string, value: string};

const DAYS_PER_PATCH_WINDOW = 28;
const PATCH_WINDOW_MS = DAYS_PER_PATCH_WINDOW * HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;
/** What a worker's `/health` says before its first sample lands: a placeholder, not a reading of the box. */
const NOT_YET_SAMPLED = "unknown";
const ISO_DATE_LENGTH = "2026-10-09".length;

const OFF_FLEET_FIELDS = [
  { field: "windowsBuild", label: "build" },
  { field: "displayMode", label: "display" },
];

/** Reachable boxes only, by name: `values` is keyed by URL, and a placeholder or an unreachable box is no reading. */
function boxValues(drift: Drift, rows: FleetRow[]): BoxValue[] {
  const reachable = new Map(rows.flatMap((row) => (row.url && row.state !== "unreachable" ? [[row.url, workerKey(row.name)] as const] : [])));
  return Object.entries(drift.values).flatMap(([url, value]) => {
    const box = reachable.get(url);
    const known = typeof value === "string" && value !== "" && value !== NOT_YET_SAMPLED;
    return box !== undefined && known ? [{ box, value }] : [];
  });
}

/**
 * The value most boxes hold, or `null` when two values are level at the top. Fewer than three boxes holding a value
 * (the row's "too few to have a fleet value") need no rule of their own: two that disagree are always level, so they
 * land here, and `fleet-split` is what they raise.
 */
function fleetValue(readings: BoxValue[]): string | null {
  const counts = new Map<string, number>();
  for (const { value } of readings) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [first, second] = [...counts].sort((a, b) => b[1] - a[1]);
  return second && first[1] === second[1] ? null : first[0];
}

function oddBoxes({ field, label }: { field: string, label: string }, status: { rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[] }): Oddity[] {
  const drift = [...(status.mismatches ?? []), ...(status.reportedOnly ?? [])].find((candidate) => candidate.field === field);
  const readings = drift ? boxValues(drift, status.rows) : [];
  const distinct = [...new Set(readings.map(({ value }) => value))].sort();
  if (distinct.length < 2) return [];
  const fleet = fleetValue(readings);
  if (fleet === null) return [{ box: null, line: `fleet-split: ${label} ${distinct.join(", ")}` }];
  return readings.filter(({ value }) => value !== fleet).sort((a, b) => a.box.localeCompare(b.box))
    .map(({ box, value }) => ({ box, line: `${box}: ${label} ${value} (fleet ${fleet})` }));
}

/**
 * Every box off the fleet's Windows build or display mode in this reading, one line per box. Pure: the drift it reads is
 * what `fleetStatus` returns, so a fleet that agrees (or a field nobody reports) draws nothing.
 */
export function offFleetLines(status: { rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[] }): Oddity[] {
  return OFF_FLEET_FIELDS.flatMap((spec) => oddBoxes(spec, status));
}

/**
 * `patch-window-missed` when the newest completed patch run is OLDER than the 28-day window. `null` for no run on record is
 * not a miss: a control host that has never patched has not missed a window it was never given, and the row that
 * installs the timer raises its own line when the window closes. The line names the run's DATE and not its age, because
 * the line is the dedup key and an age would make a new line every tick.
 */
export function patchWindowMissed(lastRunAt: number | null, now: number): Oddity | null {
  if (lastRunAt === null || now - lastRunAt <= PATCH_WINDOW_MS) return null;
  return { box: null, line: `patch-window-missed: last patch run ${new Date(lastRunAt).toISOString().slice(0, ISO_DATE_LENGTH)}, window ${DAYS_PER_PATCH_WINDOW} days` };
}

/** @returns the epoch ms of the last patch run, or `null` when none is recorded; a file that is not a record THROWS */
export function parsePatchRun(text: string): number | null {
  const lastRunAt = JSON.parse(text)?.lastRunAt;
  if (lastRunAt === undefined) return null;
  if (!Number.isFinite(lastRunAt)) throw new TypeError(`${PATCH_RUN_PATH}: lastRunAt must be an epoch-ms number, got ${JSON.stringify(lastRunAt)}`);
  return lastRunAt;
}

/**
 * One tick's worth of the off-fleet ledger, and which lines are NEW this tick. A line seen before keeps its first-seen
 * time and is not new; a line no longer found is dropped, so a box that returned to the fleet's value clears itself.
 * `keep` says which unfound entries are carried instead: those about a box that did not answer this tick, because no
 * answer is not a return to the fleet's value.
 */
export function advanceOffFleet(found: Oddity[], previous: SinceState, { now, keep }: { now: number, keep: (line: string) => boolean }): { state: SinceState, fresh: string[] } {
  const state: SinceState = {};
  for (const [line, since] of Object.entries(previous)) if (keep(line)) state[line] = since;
  for (const { line } of found) state[line] = previous[line] ?? now;
  return { state, fresh: found.filter(({ line }) => previous[line] === undefined).map(({ line }) => line) };
}

/** The comment body for lines not posted before. */
export function offFleetBody(lines: string[]): string {
  return [
    `**${lines.length} off the fleet's build or display mode, ahead of capture** (#4447).`,
    ...lines.map((line) => `- ${line}`),
    "`npm run fleet:status` for the live reading.",
  ].join("\n");
}

/** The refusal `fleet-auto-off.ts` recorded on its last tick that held a shutdown back (#3275). */
export type AutoOffRefusal = { reason: string, detail: string, at: number };

/**
 * @param {string} text the control host's auto-off state file, or `{}` when it has none
 * @returns {AutoOffRefusal | null} `null` when the last tick refused nothing
 */
export function parseAutoOffRefusal(text: string): AutoOffRefusal | null {
  const refusal = JSON.parse(text)?.refusal;
  const valid = refusal && typeof refusal.reason === "string" && typeof refusal.detail === "string"
    && Number.isFinite(refusal.at);
  return valid ? { reason: refusal.reason, detail: refusal.detail, at: refusal.at } : null;
}

/** Where and when a read of the record is mirrored; `path` and `write` are for a test. */
export type AutoOffMirror = { readAt: number, path?: string, write?: (path: string, data: string) => void };

/**
 * Write the record this watch just read, whole, beside the epoch ms it was read at. `readAt` is the reader's only
 * clock: a run that could not read writes nothing, so the mirror ages, and an old `readAt` says "nobody looked"
 * where `record.refusal === null` says "looked, and nothing is refused". The record is kept verbatim (not just the
 * refusal `parseAutoOffRefusal` keeps) so a field the producer adds later reaches the reader without a change here.
 *
 * @param {string} text the control host's auto-off state file, or `{}` when it has none
 */
export function mirrorAutoOffRecord(text: string, { readAt, path = AUTO_OFF_MIRROR_PATH, write = replaceFile }: AutoOffMirror) {
  write(path, `${JSON.stringify({ readAt, record: JSON.parse(text) }, null, 2)}\n`);
}

/** A mirror that cannot be written must not hide the refusal that WAS read: say so on stderr and carry on. */
function mirrorOrSay(text: string, mirror: AutoOffMirror) {
  try {
    mirrorAutoOffRecord(text, mirror);
  } catch (cause) {
    console.error(`CANNOT WRITE the auto-off mirror: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * The auto-off timer's refusal, read FROM the control host (this watch runs on the agents host, where the state file
 * is not): ssh, or local when this is the control plane. A host that cannot be read THROWS rather than answering
 * `null`: "no refusal" and "I did not look" are different states. A missing file is `{}`, a timer that never ticked.
 *
 * Given a `mirror`, a read that succeeded is also written to the mirror file (#3860); a read that threw wrote nothing.
 */
export function readAutoOffRefusal(
  readState: () => string = () => sshToControlPlane(`cat ${CONTROL_PLANE_CHECKOUT}/${AUTO_OFF_STATE_PATH} 2>/dev/null || echo '{}'`,
    { capture: true }),
  mirror?: AutoOffMirror,
): AutoOffRefusal | null {
  const text = readState();
  const refusal = parseAutoOffRefusal(text);
  if (mirror) mirrorOrSay(text, mirror);
  return refusal;
}

export function refusalBody(refusal: AutoOffRefusal, now: number): string {
  return [
    `**The auto-off timer is refusing to power workers off** (\`${refusal.reason}\`, ${describeAge(now - refusal.at)} ago, #3275).`,
    `- ${refusal.detail}`,
    "The checkout it runs from is not `main`'s, so an idle fleet stays powered on until a `fleet:*` play moves it.",
  ].join("\n");
}

/**
 * Fold one reading of the fleet into the persisted ledger. Exported so `fleet-auto-off.ts` can feed the
 * same ledger from its own 10 s probe: the hourly poll alone never sees a worker that boots, works and is
 * powered off between two polls (#3208).
 *
 * The read, the advance and the write happen under `withFileLock`, so concurrent writers each see the other's rise.
 */
export function recordCaptures(rows: FleetRow[], { path, at, read, write, lock = write ? unlocked : withFileLock }: {
        path: string; at: number; read?: typeof readFileSync; write?: typeof writeFileSync;
        lock?: typeof withFileLock;
    }) {
  lock(path, () => writeCapturesState(path, advanceCaptures(rows, readCapturesState(path, read), at), write));
}

export type WatchDeps = {
    getStatus?: StatusReader; now?: () => number; statePath?: string; capturesPath?: string; offFleetPath?: string;
    thresholdMs?: number; read?: typeof readFileSync; write?: typeof writeFileSync;
    /** The newest completed patch run, epoch ms (see `readPatchRun`). Absent: the patch window is not read this tick. */
    lastPatchRunAt?: () => number | null;
    /** Where the off-fleet ledger is written when it is not `write`: a dry run must not use up the lines a posting run will say. */
    writeOffFleet?: (path: string, data: string) => void;
};

/**
 * Read the live fleet, advance and persist the non-ready-since state and the capture times, and report who
 * is overdue and which boxes are newly off the fleet's build or display mode (#4447).
 * Everything above this function is pure; this is the one place I/O and the clock meet, and every piece
 * of it is a parameter with a real default -- the shape `runLabStatus`'s `run` parameter already
 * established for the identical reason: a test drives this without a fleet, a fleet, or a clock.
 */
export async function watchFleet(deps: WatchDeps = {}): Promise<{ overdue: OverdueEntry[], offFleet: string[] }> {
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
  return { overdue: overdue(status.rows, next, at, thresholdMs), offFleet: recordOffFleet(status, at, deps) };
}

/** The off-fleet lines this tick that were not posted before; the ledger is read and rewritten here. */
function recordOffFleet(status: { rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[] }, at: number, deps: WatchDeps): string[] {
  const path = deps.offFleetPath ?? DEFAULT_OFF_FLEET_STATE_PATH;
  const patch = patchReading(deps.lastPatchRunAt, at);
  const { state, fresh } = advanceOffFleet([...offFleetLines(status), ...patch.found], readState(path, deps.read),
    { now: at, keep: carriesEntry(status.rows, patch.carry) });
  writeState(path, state, deps.writeOffFleet ?? deps.write);
  return fresh;
}

/** `watchFleet`'s stuck workers alone. */
export async function watch(deps: WatchDeps = {}): Promise<OverdueEntry[]> {
  return (await watchFleet(deps)).overdue;
}

/**
 * The last patch run, read FROM the control host (the timer runs there, this watch on the agents host): ssh, or local when
 * this is the control plane. A host that cannot be read THROWS rather than answering `null`: "no run on record" and "I
 * did not look" are different states. A missing file is `{}`, which is no run on record.
 */
export function readPatchRun(
  read: () => string = () => sshToControlPlane(`cat ${CONTROL_PLANE_CHECKOUT}/${PATCH_RUN_PATH} 2>/dev/null || echo '{}'`, { capture: true }),
): number | null {
  return parsePatchRun(read());
}

const PATCH_LINE_PREFIX = "patch-window-missed: ";

/**
 * The patch line to raise, and whether an unread host means the last one stands. A run that could not be read SAYS so on
 * stderr and carries the previous line: an unreadable host is not a patch that happened, and not a miss that cleared.
 * With no reader at all (a caller that did not ask) the line is carried the same way.
 */
function patchReading(readLastRun: (() => number | null) | undefined, now: number): { found: Oddity[], carry: boolean } {
  if (!readLastRun) return { found: [], carry: true };
  try {
    const missed = patchWindowMissed(readLastRun(), now);
    return { found: missed ? [missed] : [], carry: false };
  } catch (cause) {
    console.error(`CANNOT READ the last patch run from the control host: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { found: [], carry: true };
  }
}

/** Entries about a box that did not answer, or about a patch run that could not be read, are not cleared by silence. */
function carriesEntry(rows: FleetRow[], carryPatch: boolean): (line: string) => boolean {
  const asleep = new Set(rows.filter((row) => row.state === "unreachable").map((row) => workerKey(row.name)));
  return (line) => asleep.has(line.split(": ")[0]) || (carryPatch && line.startsWith(PATCH_LINE_PREFIX));
}

/**
 * The auto-off refusal, or `null` — and when the host could not be read, SAYS so on stderr rather than reading as
 * clean. A read that succeeded is mirrored for `org-health` (#3860); one that threw leaves the mirror to age.
 *
 * @param {{ readState?: () => string, path?: string, now?: () => number }} [deps] for a test
 */
export function readRefusalOrSay({ readState, path, now = Date.now }: { readState?: () => string; path?: string; now?: () => number; } = {}): AutoOffRefusal | null {
  try {
    return readAutoOffRefusal(readState, { readAt: now(), path });
  } catch (cause) {
    console.error(`CANNOT READ the auto-off refusal from the control host: ${cause instanceof Error ? cause.message : String(cause)}`);
    return null;
  }
}

async function main() {
  const post = process.argv.includes("--post");
  const thresholdArg = process.argv.find((a) => a.startsWith("--threshold-ms="));
  const thresholdMs = thresholdArg ? Number(thresholdArg.slice("--threshold-ms=".length)) : undefined;
  let found;
  try {
    found = await watchFleet({ ...(thresholdMs === undefined ? {} : { thresholdMs }), lastPatchRunAt: readPatchRun,
      ...(post ? {} : { writeOffFleet: () => undefined }) });
  } catch (cause) {
    console.error(`CANNOT ASK: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = EXIT.CANNOT_ASK;
    return;
  }
  const refusal = readRefusalOrSay();
  if (!found.overdue.length && !found.offFleet.length && !refusal) {
    process.exitCode = EXIT.QUIET;
    return;
  }
  const body = [found.overdue.length ? watchBody(found.overdue) : null, found.offFleet.length ? offFleetBody(found.offFleet) : null,
    refusal ? refusalBody(refusal, Date.now()) : null].filter(Boolean).join("\n\n");
  console.log(body);
  if (post) {
    execFileSync("gh", ["issue", "comment", String(ORG_READING_ISSUE), "--body", body], { stdio: "inherit" });
  }
  process.exitCode = EXIT.ATTENTION;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
