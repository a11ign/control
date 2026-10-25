// @ts-check
/**
 * THE FLEET AGAINST ITS MANIFEST, READ ON A CLOCK AND AT USE TIME (A11-205, docs/adr/0001).
 *
 * `fleet:status` compares every box with `deploy-pins.json` (`driftOf`) and prints the whole table. This is the same reading without the table: it asks each
 * box what it runs, names every difference (the box, the field, what it has, what the manifest wants), and can write the answer down. Three things use it:
 *
 *   - `a11y-fleet-drift.timer` runs it every hour on the control plane with `--record`. It READS and changes nothing: it installs nothing, wakes nothing and
 *     restarts nothing, so `no-scheduled-install.test.ts` lets its unit run. A box that is asleep is unread, not a difference.
 *   - `lab:job` reads the workers a capture job needs just before it dispatches (`driftingBoxes`) and leaves the ones that differ out of the pool.
 *   - `fleet:patch` ends its run with it (`readFleetDrift`): the deliberate upgrade is not done until every box reads back as the manifest.
 *
 * ## The record (`runs/fleet-drift.json`), and what reads it
 *
 * `fleet-watch` on the agents host copies it to `runs/fleet-drift-mirror.json`, and agent-org's `incident:fleet-drift` reads that mirror to tell the chairman's
 * announcement channel. So it holds NAMES AND VERSIONS, never an address. `firstSeenAt` is when the current run of differences began (carried from the
 * previous record while it lasts), so the incident's hold-down counts from the first sighting and not from the latest hour.
 *
 * ## A difference that goes to sleep is still a difference
 *
 * The idle-off timer powers workers off, and the hourly read never wakes one. A box seen off the manifest and unreadable on the next hour has not been shown
 * back on it, so its last differences are CARRIED into the new record (`carried: true`) until it answers and agrees, or the manifest moves. Without this the
 * incident would resolve itself the first night the box slept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredWorkers, refuseUnknownFlags } from "./worker-fleet-carried.ts";
import { inventoryHosts } from "./fleet-discover.ts";
import { inventoryPathFor } from "./control-plane-fleet.ts";
import { driftOf, fleetToProbe, inventoryName, probeWorker } from "./fleet-status.ts";
import type { Difference, Expectation, FleetDrift, WorkerProbe } from "./fleet-status.ts";
import { DRIFT_FIELDS, readExpectedFleet } from "./fleet-pins.ts";
import type { ExpectedFleet } from "./fleet-pins.ts";
import { bookReads, ledgerOnThisHost } from "./fleet-leases/booking.ts";
import type { LeaseLedger } from "./fleet-leases/ledger.ts";

refuseUnknownFlags(["--json", "--record"], { entry: import.meta.url, command: "npm run fleet:drift" });

/** Relative to the working directory, as `fleet-watch`'s other records are: the unit's `WorkingDirectory` is control's checkout on the plane. */
export const FLEET_DRIFT_PATH = "runs/fleet-drift.json";

/** Where `ansible/freeze.yml` leaves the daily freeze's own record on the control plane. */
export const FREEZE_RUN_PATH = "runs/fleet-freeze-last-run.json";

/** The port every worker serves `/health` on (`a11y_port`; `lab-job.yml` asserts the same). */
const WORKER_PORT = 8765;

/** A difference as the record keeps it: `carried` is true when the box did not answer this hour and the difference is its last known one. */
export type RecordedDifference = Difference & { carried: boolean; };

/** The daily freeze's last run, as `ansible/freeze.yml` wrote it, cut to what an announcement needs. */
export type FreezeRun = {
  checkedAt: string; scope: string; putBack: Record<string, string[]>; unreachable: string[]; failed: string[];
  /** Box -> who still held it when the freeze stopped waiting (A11-244): the box was NOT frozen that day. Empty on a record from before booking. */
  leased: Record<string, string>;
};

export type DriftRecord = {
  checkedAt: string;
  /** When the current run of differences began, or `null` when there is none. Carried from the previous record while the run lasts. */
  firstSeenAt: string | null;
  /** What the manifest wants of every box, or `null` when it could not be read. */
  expected: ExpectedFleet | null;
  /** Why `expected` is `null`: a check with no expectation passes every box, so this fails the check. */
  unreadable: string | null;
  reachable: number;
  total: number;
  /** The boxes that did not answer: unread, not a difference. */
  unreachable: string[];
  differences: RecordedDifference[];
  /** The daily freeze's last record, so one record says everything about the freeze. `null` when it has not run on this host. */
  freeze: FreezeRun | null;
  /**
   * The unreachable boxes whose last known state was lost because the previous record EXISTED and could not be read (a missing one is a first run, not a loss).
   * A box that did not answer cannot be vouched for without it, so a non-empty list fails the check as a difference does. The loss lasts until the box answers
   * (a box that is still silent stays listed in the next record), and ends there. Empty when nothing was lost.
   */
  carryLost: string[];
  /**
   * The boxes this reading did not ask because a `maintain` lease held them (A11-244), with who held them. They are also in `unreachable`: unread, not a
   * difference, and their last differences are carried. Empty when nothing was held.
   */
  skipped: Record<string, string>;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const stringMap = (value: unknown): Record<string, string> =>
  (isObject(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {});

/** The freeze run as `ansible/freeze.yml` writes it, out of an already-parsed value; `null` when it is not that shape. */
function freezeRunFrom(parsed: unknown): FreezeRun | null {
  if (!isObject(parsed) || typeof parsed.checkedAt !== "string") return null;
  const putBack = isObject(parsed.putBack)
    ? Object.fromEntries(Object.entries(parsed.putBack).map(([box, levers]) => [box, stringList(levers)]))
    : {};
  return { checkedAt: parsed.checkedAt, scope: typeof parsed.scope === "string" ? parsed.scope : "the fleet",
    putBack, unreachable: stringList(parsed.unreachable), failed: stringList(parsed.failed), leased: stringMap(parsed.leased) };
}

/** JSON text that may be missing or not JSON, as a value: `undefined` is "no record", never a crash. */
function parsedOrUndefined(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The freeze run's record out of its file's text, or `null` when it is missing or not the shape `freeze.yml` writes. */
export function parseFreezeRun(text: string | null): FreezeRun | null {
  return freezeRunFrom(parsedOrUndefined(text));
}

/** A previous record, or `null` when the file is missing or is not one. Only what carrying needs is checked. */
export function parseDriftRecord(text: string | null): DriftRecord | null {
  const parsed = parsedOrUndefined(text);
  if (!isObject(parsed) || typeof parsed.checkedAt !== "string" || !Array.isArray(parsed.differences)) return null;
  const differences = parsed.differences.filter(isObject).flatMap((entry): RecordedDifference[] =>
    (typeof entry.box === "string" && DRIFT_FIELDS.some((field) => field === entry.field) && typeof entry.wants === "string"
      ? [{ box: entry.box, field: entry.field as RecordedDifference["field"], has: typeof entry.has === "string" ? entry.has : null,
        wants: entry.wants, carried: entry.carried === true }]
      : []));
  const expected = isObject(parsed.expected) && DRIFT_FIELDS.every((field) => typeof (parsed.expected as Record<string, unknown>)[field] === "string")
    ? parsed.expected as ExpectedFleet : null;
  return { checkedAt: parsed.checkedAt, firstSeenAt: typeof parsed.firstSeenAt === "string" ? parsed.firstSeenAt : null, expected,
    unreadable: typeof parsed.unreadable === "string" ? parsed.unreadable : null,
    reachable: Number(parsed.reachable) || 0, total: Number(parsed.total) || 0, unreachable: stringList(parsed.unreachable), differences,
    freeze: freezeRunFrom(parsed.freeze), carryLost: stringList(parsed.carryLost), skipped: stringMap(parsed.skipped) };
}

const sameExpectation = (a: ExpectedFleet | null, b: ExpectedFleet | null): boolean =>
  a !== null && b !== null && DRIFT_FIELDS.every((field) => a[field] === b[field]);

/**
 * The record of one reading. Pure: the clock, the previous record and the freeze run are arguments.
 *
 * - `differences` are this reading's, plus the previous record's for a box that did not answer now (carried), when the manifest has not moved since: a
 *   difference against a manifest that was edited is a different fact, and the box is read again against the new one.
 * - `firstSeenAt` is the previous record's while both readings have a failure (a difference, or a manifest that cannot be read), and `now` when this one
 *   begins a run; `null` when there is no failure.
 */
export function driftRecordOf({ drift, probes, previous, previousUnreadable = false, freeze, now }: {
  drift: FleetDrift; probes: WorkerProbe[]; previous: DriftRecord | null; previousUnreadable?: boolean; freeze: FreezeRun | null; now: Date;
}): DriftRecord {
  const unreachable = probes.filter((probe) => !probe.reachable).map((probe) => inventoryName(probe.name))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const current: RecordedDifference[] = drift.differences.map((difference) => ({ ...difference, carried: false }));
  const carried: RecordedDifference[] = previous !== null && sameExpectation(previous.expected, drift.expected)
    ? previous.differences.filter(({ box }) => unreachable.includes(box)).map((difference) => ({ ...difference, carried: true }))
    : [];
  const differences = [...current, ...carried];
  const carryLost = previousUnreadable ? unreachable : (previous?.carryLost ?? []).filter((box) => unreachable.includes(box));
  const failing = differences.length > 0 || drift.unreadable !== null || carryLost.length > 0;
  const checkedAt = now.toISOString();
  const previousFailing = previous !== null && (previous.differences.length > 0 || previous.unreadable !== null || previous.carryLost.length > 0);
  return {
    checkedAt,
    firstSeenAt: !failing ? null : (previousFailing && previous.firstSeenAt !== null ? previous.firstSeenAt : checkedAt),
    expected: drift.expected, unreadable: drift.unreadable,
    reachable: probes.length - unreachable.length, total: probes.length, unreachable, differences, freeze, carryLost, skipped: {},
  };
}

/**
 * The exit codes of `fleet:drift`. 3 is `fleet:status`'s: the code `fleet:converge` and the lab's capture guard already read as "any box differs". "No box
 * answered" is 4, NOT `fleet:status`'s 1: the hourly unit excuses it (the idle-off timer powers workers off, and this read never wakes one), and exit 1 is also
 * what Node returns for a script it cannot load, so a unit that excused 1 would call a missing program a quiet night.
 */
export const DRIFT_EXIT = Object.freeze({ ON_MANIFEST: 0, DIFFERS: 3, NOTHING_ANSWERED: 4 });

export function driftExitCode(record: DriftRecord): number {
  // A manifest that cannot be read is a failure however many boxes answered: with every box asleep it must not read as a quiet night.
  if (record.unreadable !== null || record.differences.length > 0 || record.carryLost.length > 0) return DRIFT_EXIT.DIFFERS;
  return record.reachable === 0 ? DRIFT_EXIT.NOTHING_ANSWERED : DRIFT_EXIT.ON_MANIFEST;
}

/** What the daily freeze's last run put back and could not reach or hold, one line each; none when it has not run on this host. */
function freezeLines(freeze: FreezeRun | null): string[] {
  if (freeze === null) return [];
  const lines: string[] = [];
  const putBack = Object.entries(freeze.putBack).map(([box, levers]) => `${box} (${levers.join(", ")})`);
  if (putBack.length > 0) lines.push(`the freeze put back, at ${freeze.checkedAt}: ${putBack.join("; ")}`);
  if (freeze.unreachable.length > 0) lines.push(`the freeze did not reach, at ${freeze.checkedAt}: ${freeze.unreachable.join(", ")}`);
  if (freeze.failed.length > 0) lines.push(`the freeze did not hold on, at ${freeze.checkedAt}: ${freeze.failed.join(", ")}`);
  const leased = Object.entries(freeze.leased).map(([box, holder]) => `${box} (${holder})`);
  if (leased.length > 0) lines.push(`the freeze never got a lease on, so did not freeze today, at ${freeze.checkedAt}: ${leased.join(", ")}`);
  return lines;
}

/** The boxes this reading did not get an answer from, and why: held by a lease, silent, or all of them. */
function unreadLines(record: DriftRecord): string[] {
  const lines: string[] = [];
  const skipped = Object.entries(record.skipped).map(([box, why]) => `${box} (${why})`);
  if (skipped.length > 0) lines.push(`not read this time (a lease held the box; its last differences are carried): ${skipped.join(", ")}`);
  const silent = record.unreachable.filter((box) => !(box in record.skipped));
  if (silent.length > 0) lines.push(`not read (unreachable, not a difference): ${silent.join(", ")}`);
  if (record.reachable === 0) {
    lines.push(record.total > 0 && skipped.length === record.total ? "every box was under a lease: nothing was compared" : "no box answered: nothing was compared");
  }
  return lines;
}

/** The lines a person reads, one per fact. A carried difference says so: the box did not answer this hour. */
export function driftLines(record: DriftRecord): string[] {
  const lines: string[] = [];
  if (record.unreadable !== null) lines.push(`fleet OFF THE MANIFEST — cannot compare ${record.reachable} reachable box(es): ${record.unreadable}`);
  for (const { box, field, has, wants, carried } of record.differences) {
    lines.push(`fleet OFF THE MANIFEST — ${box} ${field} ${has === null ? "unreported" : `has ${has}`}, the manifest wants ${wants}`
      + (carried ? " (last read; the box did not answer this time)" : ""));
  }
  if (record.carryLost.length > 0) {
    lines.push(`fleet CANNOT VOUCH — the previous record could not be read, so what ${record.carryLost.join(", ")} last read as is lost: they did not answer and are not known to be on the manifest`);
  }
  if (record.differences.length === 0 && record.unreadable === null && record.carryLost.length === 0 && record.reachable > 0 && record.expected !== null) {
    lines.push(`fleet on the manifest — ${DRIFT_FIELDS.map((field) => `${field}: ${record.expected?.[field]}`).join("; ")}; all ${record.reachable} boxes that answered`);
  }
  lines.push(...unreadLines(record));
  return [...lines, ...freezeLines(record.freeze)];
}

type Worker = { name: string; url: string; };

type ReadDeps = {
  /** The workers to ask. Absent: `A11Y_WORKERS`, else this host's inventory, else the control plane's over ssh. */
  workers?: () => Worker[];
  probe?: (worker: Worker) => Promise<WorkerProbe>;
  /** What the manifest wants of every box. Absent: `deploy-pins.json` and the pinned worker release. */
  expected?: () => ExpectedFleet | Promise<ExpectedFleet>;
};

/** The fleet this host can ask: what a run named, else the inventory on this host (the control plane has one), else the control plane's own over ssh. */
export function workersToRead(): Worker[] {
  const named = configuredWorkers();
  if (named.length > 0) return named;
  const inventory = inventoryPathFor();
  if (existsSync(inventory)) {
    const declared = inventoryHosts(readFileSync(inventory, "utf8"));
    if (declared.length > 0) return declared.map(({ name, host }) => ({ name, url: `http://${host}:${WORKER_PORT}` }));
  }
  return fleetToProbe();
}

async function expectationOf(read: () => ExpectedFleet | Promise<ExpectedFleet>): Promise<Expectation> {
  try {
    return { expected: await read() };
  } catch (cause) {
    return { unreadable: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Ask every worker and compare it with the manifest. A box that does not answer is a probe with `reachable: false`, never a throw. */
export async function readFleetDrift(deps: ReadDeps = {}): Promise<{ drift: FleetDrift; probes: WorkerProbe[]; }> {
  const workers = (deps.workers ?? workersToRead)();
  const probe = deps.probe ?? probeWorker;
  const probes = await Promise.all(workers.map((worker) => probe(worker)));
  return { drift: driftOf(probes, await expectationOf(deps.expected ?? readExpectedFleet)), probes };
}

/**
 * The boxes among `workers` that differ from the manifest right now, for a job that is about to hand them work. `cannotAsk` when the manifest cannot be
 * read: with no expectation every box would pass, and the caller refuses ("could not ask is not may proceed").
 */
export async function driftingBoxes(workers: Worker[], deps: Omit<ReadDeps, "workers"> = {}): Promise<{ drifting: string[]; } | { cannotAsk: string; }> {
  const { drift } = await readFleetDrift({ ...deps, workers: () => workers });
  if (drift.unreadable !== null) return { cannotAsk: drift.unreadable };
  return { drifting: [...new Set(drift.differences.map(({ box }) => box))] };
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Written whole and renamed into place, so `fleet-watch`'s ssh `cat` never reads half a record. */
export function writeDriftRecord(path: string, record: DriftRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(partial, path);
}

/** The previous record, and whether one existed that could not be read: a missing file is a first run, a present one that does not parse is a loss. */
export function previousRecordOf(text: string | null): { previous: DriftRecord | null; previousUnreadable: boolean; } {
  const previous = parseDriftRecord(text);
  return { previous, previousUnreadable: text !== null && previous === null };
}

/** The previous record from disk: no file is a first run; a file that cannot be read for any other reason (permissions, a directory) is a loss, as one that does not parse is. */
export function readPreviousRecord(path: string, read: (path: string, encoding: "utf8") => string = readFileSync): ReturnType<typeof previousRecordOf> {
  try {
    return previousRecordOf(read(path, "utf8"));
  } catch (cause) {
    return (cause as NodeJS.ErrnoException)?.code === "ENOENT" ? previousRecordOf(null) : { previous: null, previousUnreadable: true };
  }
}

/** A probe for a box that was not asked because a lease held it: unreachable to the record, with the reason in `error`. */
const heldProbe = (worker: Worker, why: string): WorkerProbe => ({ ...worker, reachable: false, error: why });

/**
 * The hourly reading, booked (A11-244). With a `ledger` (`--record`, the unit's form) it takes a SHARED `read` lease on every box no `maintain` lease holds,
 * never queues, and lets it go at the end. A person's `fleet:drift` passes none. A read is safe beside a capture: it sends only `GET /health` and
 * `GET /progress` (`probeWorker`), the same two the job runner and auto-off send mid-capture on every tick, and the worker's `busy` flag exists to answer
 * them. A box under `maintain` (the daily freeze, a shutdown) is not asked this hour: it is recorded as unread, with who held it, and its last differences
 * are carried. `unbooked` is why no lease was taken when the ledger could not be read or locked: the boxes are then read anyway.
 */
export async function bookedReading({ workers, ledger, deps = {}, previous, freeze, now }: {
  workers: Worker[]; ledger: LeaseLedger | null; deps?: Omit<ReadDeps, "workers">; freeze: FreezeRun | null; now: Date;
  previous: ReturnType<typeof previousRecordOf>;
}): Promise<{ record: DriftRecord; unbooked: string | null; }> {
  const booking = ledger === null ? null
    : bookReads(ledger, { id: `fleet-drift:${process.pid}`, holder: `fleet-drift:${now.toISOString()}`, label: "a11y-fleet-drift", boxes: workers.map(({ name }) => inventoryName(name)) });
  const skipped = booking?.skipped ?? {};
  try {
    const held = workers.filter(({ name }) => inventoryName(name) in skipped);
    const { drift, probes } = await readFleetDrift({ ...deps, workers: () => workers.filter((worker) => !held.includes(worker)) });
    const unread = held.map((worker) => heldProbe(worker, skipped[inventoryName(worker.name)] ?? ""));
    const record = driftRecordOf({ drift, probes: [...probes, ...unread], ...previous, freeze, now });
    return { record: { ...record, skipped }, unbooked: booking?.unbooked ?? null };
  } finally {
    booking?.release();
  }
}

async function main() {
  const recording = process.argv.includes("--record");
  const { record, unbooked } = await bookedReading({ workers: workersToRead(), previous: readPreviousRecord(FLEET_DRIFT_PATH), now: new Date(),
    ledger: recording ? ledgerOnThisHost((line) => process.stderr.write(`fleet-drift: ${line}\n`)) : null, freeze: parseFreezeRun(readOrNull(FREEZE_RUN_PATH)) });
  if (unbooked !== null) process.stderr.write(`fleet-drift: no read lease was taken (${unbooked}); the boxes were read without one\n`);
  if (recording) writeDriftRecord(FLEET_DRIFT_PATH, record);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  else for (const line of driftLines(record)) process.stdout.write(`${line}\n`);
  process.exitCode = driftExitCode(record);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
