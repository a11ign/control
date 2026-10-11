// no-token: gh -- every test below drives pure functions or `watch()` with an injected `getStatus`/
// `read`/`write`; none of them calls `main()`, so fleet-watch.ts's own `execFileSync("gh", ...)` (only
// reached from `main()` under `--post`) is never exercised here.
//
// #1815: "the fleet is the org's scarcest resource and the only major subsystem with no eyes on it."
// Every test below is fixture-driven -- a fake `fleetStatus`, a fake clock, an in-memory `read`/`write` --
// so none of it needs the fleet, matching `lab-watch.test.ts`'s own reasoning for the identical shape one
// subsystem over.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readState, writeState, advance, overdue, watchBody, watch, advanceCaptures, DEFAULT_THRESHOLD_MS,
  offFleetLines, offFleetBody, patchWindowMissed, parsePatchRun, readPatchRun, watchFleet, DEFAULT_OFF_FLEET_STATE_PATH,
  unitDriftTick, unitDriftBody, exitCodeFor, EXIT, UNREAD,
  withUseTick, useReading, useBody, postUseOnce, readCapturesState, MIN_USE_TICKS, USE_RESERVATION_MAX_MS, pidAlive, type CapturesState,
  type Drift, type FleetRow as WatchRow, type StatusReader,
} from "./fleet-watch.ts";
import { fleetConsistency } from "../../worker-fleet/src/fleet-consistency.ts";
import { controlUnitDrift } from "./control-unit-drift.ts";
import { NO_INCIDENT_TICK } from "./fleet-build-incident.ts";

export type FleetRow = {name: string, state: string, readiness?: {reason?: string|null}|null};

function row(name: string, state: string, reason: string | null = null) {
  return { name, state, readiness: reason === null ? null : { reason } };
}

test("readState: a missing or corrupt file reads as EMPTY, never as a crash", () => {
  const throwing = () => { throw new Error("ENOENT"); };
  assert.deepEqual(readState("runs/fleet-watch-state.json", throwing as never), {});
  assert.deepEqual(readState("runs/fleet-watch-state.json", (() => "not json") as never), {});
  assert.deepEqual(readState("runs/fleet-watch-state.json", (() => "[1,2,3]") as never), {},
    "an array is not the {name: timestamp} shape this state is, and must not be handed back as one");
});

test("readState/writeState round-trip through an injected store", () => {
  let stored = "";
  const write = ((_path: string, data: string) => { stored = data; }) as never;
  writeState("state.json", { "a11y-worker-3": 12345 }, write);
  const read = (() => stored) as never;
  assert.deepEqual(readState("state.json", read), { "a11y-worker-3": 12345 });
});

test("advance: a worker seen non-ready for the FIRST time gets `now` as its since-timestamp", () => {
  const rows = [row("a11y-worker-3", "warming")];
  assert.deepEqual(advance(rows, {}, 1_000), { "a11y-worker-3": 1_000 });
});

test("advance: an already-tracked worker KEEPS its original timestamp -- this is the duration", () => {
  const rows = [row("a11y-worker-3", "warming")];
  const previous = { "a11y-worker-3": 1_000 };
  assert.deepEqual(advance(rows, previous, 999_000), { "a11y-worker-3": 1_000 },
    "if this returned `now` on every tick, no worker could ever be seen as overdue");
});

test("advance: a `ready` worker CLEARS ITSELF -- the chairman's 2026-09-19 rule, held here", () => {
  // .claude/rules/agent-practices.md: "a waiting condition is DATA... both clear themselves, and that is
  // the whole point." A recovered worker must not linger as a resolved entry someone has to prune.
  const rows = [row("a11y-worker-3", "ready")];
  assert.deepEqual(advance(rows, { "a11y-worker-3": 1_000 }, 999_000), {});
});

test("advance: `busy` is not stuck -- a worker mid-capture is occupied, not overdue", () => {
  const rows = [row("a11y-worker-3", "busy")];
  assert.deepEqual(advance(rows, { "a11y-worker-3": 1_000 }, 999_000), {});
});

test("advance: `unreachable` is the RESTING state -- absent from the ledger, even if it was tracked before (#3023)", () => {
  const rows = [row("a11y-worker-3", "unreachable")];
  assert.deepEqual(advance(rows, {}, 999_000), {}, "a powered-off box never enters the ledger");
  assert.deepEqual(advance(rows, { "a11y-worker-3": 1_000 }, 999_000), {},
    "and a box that was warming and then went dark is dropped, not kept ageing");
});

test("overdue: warming for SECONDS produces nothing -- the positive control this row exists for", () => {
  const rows = [row("a11y-worker-3", "warming")];
  const state = { "a11y-worker-3": 1_000 };
  const entries = overdue(rows, state, 1_000 + 5_000, DEFAULT_THRESHOLD_MS);
  assert.deepEqual(entries, [], "5 seconds of warming is ordinary startup, not a finding");
});

test("overdue: warming PAST the threshold produces an entry, with its age and reason", () => {
  const rows = [row("a11y-worker-3", "warming", "not ready: noForegroundBlocker")];
  const state = { "a11y-worker-3": 1_000 };
  const now = 1_000 + DEFAULT_THRESHOLD_MS;
  const entries = overdue(rows, state, now, DEFAULT_THRESHOLD_MS);
  assert.deepEqual(entries, [{
    name: "a11y-worker-3", state: "warming", ageMs: DEFAULT_THRESHOLD_MS,
    reason: "not ready: noForegroundBlocker",
  }]);
});

test("overdue: exactly AT the threshold counts -- >=, not >, so the boundary is inclusive", () => {
  const rows = [row("a11y-worker-3", "warming")];
  const entries = overdue(rows, { "a11y-worker-3": 0 }, DEFAULT_THRESHOLD_MS, DEFAULT_THRESHOLD_MS);
  assert.equal(entries.length, 1);
});

test("overdue: not yet tracked (absent from state) never appears, even past what would be the threshold", () => {
  const rows = [row("a11y-worker-3", "warming")];
  assert.deepEqual(overdue(rows, {}, 999_000, DEFAULT_THRESHOLD_MS), []);
});

test("overdue: several overdue workers sort OLDEST FIRST", () => {
  const rows = [row("a11y-worker-4", "warming"), row("a11y-worker-10", "warming")];
  const state = { "a11y-worker-4": 10_000, "a11y-worker-10": 5_000 };
  const now = 10_000 + DEFAULT_THRESHOLD_MS + 5_000;
  const entries = overdue(rows, state, now, DEFAULT_THRESHOLD_MS);
  assert.deepEqual(entries.map((e) => e.name), ["a11y-worker-10", "a11y-worker-4"],
    "worker-10 has been stuck longer (since 5,000) than worker-4 (since 10,000)");
});

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function memoryStore() {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const data = files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  }) as never;
  const write = ((path: string, data: string) => { files.set(path, data); }) as never;
  return { read, write };
}

test("watch(): a fleet powered off on purpose stays silent past the threshold, and a warming worker beside it does not (#3023)", async () => {
  const { read, write } = memoryStore();
  const off = [row("a11y-worker-1", "unreachable"), row("a11y-worker-2", "unreachable")];
  const run = (rows: ReturnType<typeof row>[], at: number) => watch({
    getStatus: async () => ({ rows }), now: () => at, statePath: "runs/fleet-watch-state.json",
    thresholdMs: DEFAULT_THRESHOLD_MS, read, write,
  });
  await run(off, 1_000_000);
  assert.deepEqual(await run(off, 1_000_000 + TWO_DAYS_MS), [],
    "every worker unreachable for two days is the resting state, so the watch posts nothing");

  // Positive control: the emptiness above is not the whole assertion -- a reachable non-ready worker still fires.
  const mixed = [row("a11y-worker-1", "unreachable"), row("a11y-worker-3", "warming", "not ready: noForegroundBlocker")];
  await run(mixed, 1_000_000 + TWO_DAYS_MS + 1_000);
  const entries = await run(mixed, 1_000_000 + TWO_DAYS_MS + 1_000 + DEFAULT_THRESHOLD_MS);
  assert.deepEqual(entries.map((e) => e.name), ["a11y-worker-3"]);
});

test("watch(): `unreachable` -> `warming` starts a FRESH clock, so a cold start after two days off is not overdue (#3023)", async () => {
  const { read, write } = memoryStore();
  const run = (rows: ReturnType<typeof row>[], at: number) => watch({
    getStatus: async () => ({ rows }), now: () => at, statePath: "runs/fleet-watch-state.json",
    thresholdMs: DEFAULT_THRESHOLD_MS, read, write,
  });
  await run([row("a11y-worker-3", "unreachable")], 0);
  const wakesAt = TWO_DAYS_MS;
  assert.deepEqual(await run([row("a11y-worker-3", "warming")], wakesAt), [],
    "warming for the first tick, not 'warming for 2d' inherited from the unreachable ticks");
  assert.deepEqual(JSON.parse(String((read as (p: string) => string)("runs/fleet-watch-state.json"))),
    { "a11y-worker-3": wakesAt }, "`since` is the warming tick, not the unreachable one");
  const later = await run([row("a11y-worker-3", "warming")], wakesAt + DEFAULT_THRESHOLD_MS);
  assert.equal(later[0]?.ageMs, DEFAULT_THRESHOLD_MS, "and a genuinely stuck warm-up still fires from that fresh clock");
});

test("watchBody names the count, every entry with its age and reason, and the fix command", () => {
  const body = watchBody([
    { name: "a11y-worker-3", state: "warming", ageMs: 2 * 60 * 60 * 1000 + 5 * 60 * 1000,
      reason: "not ready: noForegroundBlocker" },
  ]);
  assert.match(body, /\*\*1 worker\(s\) non-`ready` past the threshold\*\* \(#1815\)\./);
  assert.match(body, /`a11y-worker-3` warming for 2h05m -- not ready: noForegroundBlocker/);
  assert.match(body, /fleet:recover -- --limit=<name>/);
});

test("watchBody with no reason names the worker and age without a dangling separator", () => {
  const body = watchBody([{ name: "a11y-worker-3", state: "warming", ageMs: 60_000, reason: null }]);
  assert.match(body, /`a11y-worker-3` warming for 1m$/m);
});

/**
 * `watch()` end to end over an IN-MEMORY store, driving the exact scenario #1815 asks for: one tick
 * where a worker has just started warming (nothing should fire), and a later tick -- fed the FIRST
 * tick's own persisted state, exactly as two separate scheduled runs would -- where it has been warming
 * long enough to be overdue.
 */
test("watch(): two ticks, an in-memory store standing in for two separate scheduled runs", async () => {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const data = files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  }) as never;
  const write = ((path: string, data: string) => { files.set(path, data); }) as never;

  const rows = [row("a11y-worker-3", "warming", "not ready: noForegroundBlocker")];
  const firstTickAt = 1_000_000;
  const firstEntries = await watch({
    getStatus: async () => ({ rows }), now: () => firstTickAt, statePath: "runs/fleet-watch-state.json",
    thresholdMs: DEFAULT_THRESHOLD_MS, read, write,
  });
  assert.deepEqual(firstEntries, [], "the worker was JUST seen warming for the first time -- no finding yet");

  const secondTickAt = firstTickAt + DEFAULT_THRESHOLD_MS;
  const secondEntries = await watch({
    getStatus: async () => ({ rows }), now: () => secondTickAt, statePath: "runs/fleet-watch-state.json",
    thresholdMs: DEFAULT_THRESHOLD_MS, read, write,
  });
  assert.equal(secondEntries.length, 1, "the SAME worker, still warming a full threshold later, is now overdue");
  assert.equal(secondEntries[0].name, "a11y-worker-3");
  assert.equal(secondEntries[0].ageMs, DEFAULT_THRESHOLD_MS);
});

test("watch(): a worker that recovers between ticks produces nothing on the next one", async () => {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const data = files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  }) as never;
  const write = ((path: string, data: string) => { files.set(path, data); }) as never;

  const firstTickAt = 1_000_000;
  await watch({
    getStatus: async () => ({ rows: [row("a11y-worker-3", "warming")] }), now: () => firstTickAt,
    statePath: "runs/fleet-watch-state.json", read, write,
  });
  const secondTickAt = firstTickAt + DEFAULT_THRESHOLD_MS;
  const secondEntries = await watch({
    getStatus: async () => ({ rows: [row("a11y-worker-3", "ready")] }), now: () => secondTickAt,
    statePath: "runs/fleet-watch-state.json", read, write,
  });
  assert.deepEqual(secondEntries, [], "ready by the second tick -- the condition cleared itself");
});

// #3205: the capture ledger read a COUNT SINCE BOOT, so a worker that worked between two polls was invisible.
// `fleet-captures-state.test.ts` holds the ledger's older behaviour; these hold the three ways it lost work.
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const MINUTES_PER_HOUR = 60;

function counted(name: string, captures: number, uptimeMinutes?: number) {
  return { name, state: "ready", captures, uptimeMinutes };
}

/** A ledger that began `hours` ago, with `w2` already in it at 0 captures. */
function ledgerBegunHoursAgo(hours: number) {
  return advanceCaptures([counted("w2", 0)], null, NOW - hours * HOUR);
}

test("ledger: a worker first seen in an EXISTING ledger, booted since it began, records every capture it holds", () => {
  const ledger = ledgerBegunHoursAgo(3);
  const after = advanceCaptures([counted("w7", 43, 45)], ledger, NOW);
  assert.deepEqual(after.workers.w7.rises, [{ at: NOW, by: 43 }]);
  assert.equal(after.workers.w7.lastRoseAt, NOW);
});

test("ledger: NEGATIVE CONTROL -- a worker whose uptime is LONGER than the ledger's age predates it and records nothing", () => {
  const ledger = ledgerBegunHoursAgo(3);
  const after = advanceCaptures([counted("w7", 43, 4 * MINUTES_PER_HOUR)], ledger, NOW);
  assert.deepEqual(after.workers.w7.rises, []);
  assert.equal(after.workers.w7.lastRoseAt, null);
});

test("ledger: the FIRST poll of a brand-new ledger over a fleet up for weeks is a baseline, not a day of captures", () => {
  const weeks = 21 * 24 * MINUTES_PER_HOUR;
  const fresh = advanceCaptures([counted("w7", 9000, weeks), counted("w8", 40, 45)], null, NOW);
  assert.deepEqual(fresh.workers.w7.rises, []);
  assert.deepEqual(fresh.workers.w8.rises, [], "even a young worker: the ledger is `since` now, so nothing is shorter than zero");
});

test("ledger: with NO uptime on the row the rule is a baseline, because only an uptime can say the count postdates the ledger", () => {
  // The rule when `uptimeMinutes` is absent (an older worker, or a row built by hand): treat the first sight as
  // predating the ledger. The alternative -- counting it -- would read a month of history as today the first time
  // a worker answered without vitals, which is the one error the alarm cannot afford (it reads 0 as "idle").
  const after = advanceCaptures([counted("w7", 43)], ledgerBegunHoursAgo(3), NOW);
  assert.deepEqual(after.workers.w7.rises, []);
});

test("ledger: a count that FELL is a restart and records a rise equal to the NEW count", () => {
  const seen = advanceCaptures([counted("w2", 12)], null, NOW - 2 * HOUR);
  const after = advanceCaptures([counted("w2", 5)], seen, NOW);
  assert.deepEqual(after.workers.w2.rises, [{ at: NOW, by: 5 }]);
});

test("ledger: a restart to ZERO captures records no rise (nothing was captured)", () => {
  const seen = advanceCaptures([counted("w2", 12)], null, NOW - 2 * HOUR);
  assert.deepEqual(advanceCaptures([counted("w2", 0)], seen, NOW).workers.w2.rises, []);
});

test("ledger: a worker that restarted and passed its old count (uptime shorter than the gap) records ALL of it", () => {
  const seen = advanceCaptures([counted("w2", 12, 600)], null, NOW - 2 * HOUR);
  const after = advanceCaptures([counted("w2", 30, 45)], seen, NOW);
  assert.deepEqual(after.workers.w2.rises, [{ at: NOW, by: 30 }], "30 since boot, not 30 - 12");
});

test("ledger: a worker that did NOT restart (uptime longer than the gap) still records only the difference", () => {
  const seen = advanceCaptures([counted("w2", 12, 600)], null, NOW - HOUR);
  const after = advanceCaptures([counted("w2", 30, 660)], seen, NOW);
  assert.deepEqual(after.workers.w2.rises, [{ at: NOW, by: 18 }]);
});

test("ledger: a worker that woke at a NEW ADDRESS is the same worker, and the old address's entry is folded in", () => {
  const before = advanceCaptures([counted("w2  203.0.113.1:8080", 5)], null, NOW - 2 * HOUR);
  const rose = advanceCaptures([counted("w2  203.0.113.1:8080", 8)], before, NOW - HOUR);
  const after = advanceCaptures([counted("w2  203.0.113.9:8080", 11)], rose, NOW);
  assert.deepEqual(Object.keys(after.workers), ["w2"], "one entry, keyed by the name without the address");
  assert.deepEqual(after.workers.w2.rises, [{ at: NOW - HOUR, by: 3 }, { at: NOW, by: 3 }]);
});

test("ledger: a ledger written when keys still carried the address is read by name", () => {
  const legacy = { since: NOW - 3 * HOUR, workers: {
    "w2  203.0.113.1:8080": { captures: 5, seenAt: NOW - HOUR, lastRoseAt: null, rises: [] },
  } };
  const after = advanceCaptures([counted("w2  203.0.113.1:8080", 9)], legacy, NOW);
  assert.deepEqual(Object.keys(after.workers), ["w2"]);
  assert.deepEqual(after.workers.w2.rises, [{ at: NOW, by: 4 }]);
});

// ---------------------------------------------------------------------------------------------------------------
// #4447: a box off the fleet's build or display mode is posted before capture day.
//
// The drift is built here in the shape `fleetConsistency` returns it (`values` keyed by the guest's URL), and the
// display half is also driven through the REAL `fleetConsistency`, so a fixture cannot invent a shape the fleet does not produce.
// ---------------------------------------------------------------------------------------------------------------
const BUILD = "26100.4652";
const NEXT_BUILD = "26100.4946";

const addressOf = (n: number) => `10.0.0.${n}`;
const urlOf = (n: number) => `http://${addressOf(n)}:8765`;
const boxName = (n: number) => `a11y-worker-${n}`;
const boxRow = (n: number, state = "ready"): WatchRow => ({ name: `${boxName(n)}  ${addressOf(n)}`, url: urlOf(n), state });
const driftOf = (field: string, byBox: Record<number, unknown>): Drift =>
  ({ field, values: Object.fromEntries(Object.entries(byBox).map(([n, value]) => [urlOf(Number(n)), value])) });
const reading = (rows: WatchRow[], drift: { mismatches?: Drift[], reportedOnly?: Drift[] }) => ({ rows, ...drift });
const lines = (found: { line: string }[]) => found.map(({ line }) => line);

test("off-fleet build: a box ONE UBR behind the fleet raises one line naming the box and both builds", () => {
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const found = offFleetLines(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: "26100.4651" })] }));
  assert.deepEqual(lines(found), [`a11y-worker-5: build 26100.4651 (fleet ${BUILD})`]);
  assert.equal(found[0].box, "a11y-worker-5", "the box is named without its address, as the ledger keys workers");
});

test("off-fleet build: NEGATIVE CONTROL -- a fleet on one build, and a field nobody reports, raise nothing", () => {
  const rows = [2, 3, 4].map((n) => boxRow(n));
  assert.deepEqual(offFleetLines(reading(rows, {})), [], "no drift entry at all: every box agrees");
  assert.deepEqual(offFleetLines(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD })] })), []);
  assert.deepEqual(offFleetLines(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: "unknown" })] })), [],
    "a box that has not sampled yet reports the placeholder `unknown`, which is no reading and is never named as a build");
});

test("off-fleet display: a box on the wrong display mode raises one line naming the box and both modes", () => {
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const found = offFleetLines(reading(rows, { mismatches: [driftOf("displayMode", { 2: "1024x768", 3: "1024x768", 4: "640x480", 5: "1024x768" })] }));
  assert.deepEqual(lines(found), ["a11y-worker-4: display 640x480 (fleet 1024x768)"]);
});

test("off-fleet display: the line comes out of the REAL fleetConsistency drift, not only a fixture's idea of it", () => {
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const guests = [2, 3, 4, 5].map((n) => ({ worker: urlOf(n), environment: { displayMode: n === 3 ? "800x600" : "1024x768" } }));
  const { mismatches } = fleetConsistency(guests);
  assert.deepEqual(lines(offFleetLines(reading(rows, { mismatches }))), ["a11y-worker-3: display 800x600 (fleet 1024x768)"]);
  const agreeing = fleetConsistency(guests.map((guest) => ({ ...guest, environment: { displayMode: "1024x768" } })));
  assert.deepEqual(offFleetLines(reading(rows, { mismatches: agreeing.mismatches })), [], "the same call over agreeing boxes is quiet");
});

test("off-fleet: build and display are read independently, one line per odd box", () => {
  const rows = [2, 3, 4].map((n) => boxRow(n));
  const found = offFleetLines(reading(rows, {
    reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: NEXT_BUILD })],
    mismatches: [driftOf("displayMode", { 2: "640x480", 3: "1024x768", 4: "1024x768" })],
  }));
  assert.deepEqual(lines(found), [`a11y-worker-4: build ${NEXT_BUILD} (fleet ${BUILD})`, "a11y-worker-2: display 640x480 (fleet 1024x768)"]);
});

test("off-fleet: an ASLEEP box raises nothing -- and the same box awake does (positive control)", () => {
  const drift = { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: "26100.4651" })] };
  const awake = [2, 3, 4, 5].map((n) => boxRow(n));
  assert.equal(offFleetLines(reading(awake, drift)).length, 1, "positive control: box 5 awake and odd is named");
  const asleep = [boxRow(2), boxRow(3), boxRow(4), boxRow(5, "unreachable")];
  assert.deepEqual(offFleetLines(reading(asleep, drift)), [], "box 5 unreachable: it is the resting state and is not counted");
});

test("off-fleet: an unreachable box is not COUNTED either -- it cannot make a tie or outvote anyone", () => {
  const drift = { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: NEXT_BUILD, 5: NEXT_BUILD })] };
  const awake = [2, 3, 4, 5].map((n) => boxRow(n));
  assert.deepEqual(lines(offFleetLines(reading(awake, drift))), [`fleet-split: build ${BUILD}, ${NEXT_BUILD}`], "positive control: all four awake is a 2-2 tie");
  const oneAsleep = [boxRow(2), boxRow(3), boxRow(4), boxRow(5, "unreachable")];
  assert.deepEqual(lines(offFleetLines(reading(oneAsleep, drift))), [`a11y-worker-4: build ${NEXT_BUILD} (fleet ${BUILD})`],
    "with box 5 asleep, three boxes remain and 2 outvote 1: the sleeping box's value cannot hold the tie");
});

test("off-fleet: a two-way TIE raises fleet-split with both values, and a 3-1 split does not (negative control)", () => {
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const tie = offFleetLines(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: NEXT_BUILD, 5: NEXT_BUILD })] }));
  assert.deepEqual(tie, [{ box: null, line: `fleet-split: build ${BUILD}, ${NEXT_BUILD}` }]);
  const threeToOne = offFleetLines(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: NEXT_BUILD })] }));
  assert.deepEqual(lines(threeToOne), [`a11y-worker-5: build ${NEXT_BUILD} (fleet ${BUILD})`]);
});

test("off-fleet: FEWER THAN THREE boxes reporting raise fleet-split, never a 'fleet value' nobody holds", () => {
  const two = [boxRow(2), boxRow(3)];
  assert.deepEqual(lines(offFleetLines(reading(two, { mismatches: [driftOf("displayMode", { 2: "1024x768", 3: "640x480" })] }))),
    ["fleet-split: display 1024x768, 640x480"]);
  // Positive control on the boundary: the same disagreement with a third box agreeing with one of them names the odd box.
  const three = [boxRow(2), boxRow(3), boxRow(4)];
  assert.deepEqual(lines(offFleetLines(reading(three, { mismatches: [driftOf("displayMode", { 2: "1024x768", 3: "640x480", 4: "1024x768" })] }))),
    ["a11y-worker-3: display 640x480 (fleet 1024x768)"]);
  // And three boxes on three different values is a tie of one each, not a modal pick.
  assert.deepEqual(lines(offFleetLines(reading(three, { reportedOnly: [driftOf("windowsBuild", { 2: "1", 3: "2", 4: "3" })] }))), ["fleet-split: build 1, 2, 3"]);
});

test("patch-window-missed: fires at 29 days, not at 27 (and not at exactly 28)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const lastRun = Date.UTC(2026, 8, 1, 3, 0, 0);
  assert.equal(patchWindowMissed(lastRun, lastRun + 27 * DAY), null, "27 days: inside the window");
  assert.equal(patchWindowMissed(lastRun, lastRun + 28 * DAY), null, "exactly 28 days: the window has not yet closed");
  const missed = patchWindowMissed(lastRun, lastRun + 29 * DAY);
  assert.equal(missed?.line, "patch-window-missed: last patch run 2026-09-01, window 28 days");
  assert.equal(patchWindowMissed(lastRun, lastRun + 29 * DAY + DAY)?.line, missed?.line, "a day later it is the SAME line, so the ledger dedups it");
});

test("patch-window-missed: no run on record is not a miss, and a file that is not a record is an error, not 'none'", () => {
  assert.equal(patchWindowMissed(null, 1_800_000_000_000), null);
  assert.equal(parsePatchRun("{}"), null, "the control host answers `{}` when the file is absent");
  assert.equal(parsePatchRun('{"lastRunAt": 1790000000000}'), 1790000000000);
  assert.throws(() => parsePatchRun('{"lastRunAt": "yesterday"}'), /epoch-ms/);
  assert.throws(() => parsePatchRun("not json"));
  assert.equal(readPatchRun(() => '{"lastRunAt": 5}'), 5, "the reader hands the control host's text to the parser");
});

test("offFleetBody names the count, every line, and the live-reading command", () => {
  const body = offFleetBody(["a11y-worker-5: build 26100.4651 (fleet 26100.4652)", "fleet-split: display 1024x768, 640x480"]);
  assert.match(body, /\*\*2 off the fleet's build or display mode/);
  assert.match(body, /^- a11y-worker-5: build 26100\.4651 \(fleet 26100\.4652\)$/m);
  assert.match(body, /fleet:status/);
});

/** `watchFleet` over an in-memory store, one call per scheduled run. */
function offFleetRun(store: ReturnType<typeof memoryStore>, extra: Partial<Parameters<typeof watchFleet>[0]> = {}) {
  return (status: Awaited<ReturnType<StatusReader>>, at: number) =>
    watchFleet({ getStatus: async () => status, now: () => at, ...store, ...extra });
}

test("watchFleet(): the same odd box on the next tick is NOT raised twice; a recovered box is dropped and raised again if it relapses", async () => {
  const store = memoryStore();
  const run = offFleetRun(store);
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const odd = reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: "26100.4651" })] });
  assert.deepEqual((await run(odd, 1_000)).offFleet, [`a11y-worker-5: build 26100.4651 (fleet ${BUILD})`], "first tick: raised");
  assert.deepEqual((await run(odd, 2_000)).offFleet, [], "second tick, nothing changed: not raised twice");
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), { [`a11y-worker-5: build 26100.4651 (fleet ${BUILD})`]: 1_000 },
    "and the ledger keeps the FIRST-SEEN time");
  assert.deepEqual((await run(reading(rows, {}), 3_000)).offFleet, [], "box 5 patched: nothing to say");
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), {}, "a box back on the fleet build is DROPPED from the ledger");
  assert.equal((await run(odd, 4_000)).offFleet.length, 1, "a relapse is a new event and is raised again");
});

test("watchFleet(): the same SPLIT on the next tick is not raised twice, and a different split is", async () => {
  const store = memoryStore();
  const run = offFleetRun(store);
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  const tie = reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: NEXT_BUILD, 5: NEXT_BUILD })] });
  assert.deepEqual((await run(tie, 1_000)).offFleet, [`fleet-split: build ${BUILD}, ${NEXT_BUILD}`]);
  assert.deepEqual((await run(tie, 2_000)).offFleet, [], "unchanged split: quiet");
  const wider = reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: "26100.5000", 5: "26100.5000" })] });
  assert.equal((await run(wider, 3_000)).offFleet.length, 1, "positive control: a split on different values IS a new line");
});

test("watchFleet(): an odd box that sleeps and wakes still odd is NOT announced a second time", async () => {
  const store = memoryStore();
  const run = offFleetRun(store);
  const drift = { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: "26100.4651" })] };
  assert.equal((await run(reading([2, 3, 4, 5].map((n) => boxRow(n)), drift), 1_000)).offFleet.length, 1);
  const sleeping = [boxRow(2), boxRow(3), boxRow(4), boxRow(5, "unreachable")];
  assert.deepEqual((await run(reading(sleeping, {}), 2_000)).offFleet, [], "asleep: nothing raised");
  assert.deepEqual((await run(reading([2, 3, 4, 5].map((n) => boxRow(n)), drift), 3_000)).offFleet, [],
    "woke on the same odd build: the first-seen entry was carried through the sleep");
  // Negative control: an AWAKE box that returns to the fleet value does clear, so carrying is only for the unreachable.
  await run(reading([2, 3, 4, 5].map((n) => boxRow(n)), {}), 4_000);
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), {});
});

test("watchFleet(): the off-fleet ledger is NOT the worker ledger -- agent-org reads every key of that one as a worker name", async () => {
  const store = memoryStore();
  const rows = [2, 3, 4, 5].map((n) => boxRow(n));
  await offFleetRun(store)(reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: BUILD, 5: "26100.4651" })] }), 1_000);
  assert.deepEqual(readState("runs/fleet-watch-state.json", store.read), {}, "a healthy-but-odd fleet leaves the stuck-worker ledger empty");
  assert.notEqual(DEFAULT_OFF_FLEET_STATE_PATH, "runs/fleet-watch-state.json");
});

test("watchFleet(): the patch window is read from the control host, posted once, and an unreadable host is said and carried", async () => {
  const DAY = 24 * 60 * 60 * 1000;
  const lastRun = 1_790_000_000_000;
  const store = memoryStore();
  const quiet = reading([boxRow(2)], {});
  let answer: () => number | null = () => lastRun;
  const run = offFleetRun(store, { lastPatchRunAt: () => answer() });
  assert.deepEqual((await run(quiet, lastRun + 27 * DAY)).offFleet, [], "27 days: nothing");
  const first = (await run(quiet, lastRun + 29 * DAY)).offFleet;
  assert.equal(first.length, 1);
  assert.match(first[0], /^patch-window-missed: last patch run /);
  assert.deepEqual((await run(quiet, lastRun + 30 * DAY)).offFleet, [], "the next tick: the same line is not posted again");
  const said: string[] = [];
  const spy = console.error; console.error = (message: string) => { said.push(message); };
  try {
    answer = () => { throw new Error("ssh: no route to host"); };
    assert.deepEqual((await run(quiet, lastRun + 31 * DAY)).offFleet, [], "an unreadable host raises nothing new");
  } finally { console.error = spy; }
  assert.match(said.join("\n"), /CANNOT READ the last patch run.*no route to host/, "and SAYS it could not look");
  answer = () => lastRun;
  assert.deepEqual((await run(quiet, lastRun + 32 * DAY)).offFleet, [], "the line was carried through the unreadable tick, so it is not re-posted when the host answers again");
  answer = () => lastRun + 31 * DAY;
  await run(quiet, lastRun + 33 * DAY);
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), {}, "a completed patch run clears the line");
});

// ---------------------------------------------------------------------------------------------------------------
// #4714: the hourly tick takes the control-unit-drift reading. Every reading below goes through the REAL
// `controlUnitDrift`, with a playbook and unit texts as fixtures, so a fixture cannot invent a finding the module
// does not produce. The row that motivated it: an installed unit still naming `lay-layer.mjs` failed 316 ticks.
// ---------------------------------------------------------------------------------------------------------------
const UNIT = "a11y-fleet-auto-off.service";
const TIMER = "a11y-fleet-auto-off.timer";
const SHIPPED_TEXT: Record<string, string> = {
  [UNIT]: "ExecStartPre=-node scripts/lay-layer.ts control\n",
  [TIMER]: "OnCalendar=hourly\n",
};
const STALE_TEXT = "ExecStartPre=-node scripts/lay-layer.mjs control\n";
const PLAYBOOK = `- name: install the units
  hosts: a11y_control
  tasks:
    - name: copy
      ansible.builtin.copy:
        src: "files/{{ item }}"
        dest: "/etc/systemd/system/{{ item }}"
      loop:
        - ${UNIT}
        - ${TIMER}
`;

/** The real reading over a control host holding `installed`; `host` may be a function that throws. */
function driftReader(host: Record<string, string> | (() => Record<string, string>)) {
  return () => controlUnitDrift({
    readHost: typeof host === "function" ? host : () => host,
    playbooks: () => [PLAYBOOK], shippedText: (unit) => SHIPPED_TEXT[unit],
  });
}
const asShipped = { ...SHIPPED_TEXT };
const staleService = { ...SHIPPED_TEXT, [UNIT]: STALE_TEXT };

test("unit drift: an installed unit whose text differs is ATTENTION and names the unit; an identical set is QUIET", () => {
  const stale = unitDriftTick(driftReader(staleService)());
  assert.deepEqual(lines(stale.found), [`unit-drift: ${UNIT} differs`]);
  assert.equal(stale.cannotTell, null);
  assert.deepEqual(unitDriftTick(driftReader(asShipped)()), { found: [], notShipped: [], cannotTell: null }, "positive control: the shipped text raises nothing");
});

test("unit drift: a shipped unit absent from the host is ATTENTION too", () => {
  const withoutTimer = Object.fromEntries(Object.entries(SHIPPED_TEXT).filter(([unit]) => unit !== TIMER));
  assert.deepEqual(lines(unitDriftTick(driftReader(withoutTimer)()).found), [`unit-drift: ${TIMER} missing-on-host`]);
});

test("unit drift: a `not-shipped` unit alone is reported, never raised (a11y-bootstrap.service is on the plane and no playbook ships it)", () => {
  const tick = unitDriftTick(driftReader({ ...SHIPPED_TEXT, "a11y-bootstrap.service": "[Unit]\n" })());
  assert.deepEqual(tick.found, [], "not ATTENTION");
  assert.deepEqual(tick.notShipped, ["a11y-bootstrap.service"], "and still named");
  // Negative control: beside a real finding it is still not a line of its own.
  const beside = unitDriftTick(driftReader({ ...staleService, "a11y-bootstrap.service": "[Unit]\n" })());
  assert.deepEqual(lines(beside.found), [`unit-drift: ${UNIT} differs`]);
});

test("unit drift: a host that cannot be read is CANNOT_TELL with its reason, and is neither a finding nor a clean reading", () => {
  const unreadable = unitDriftTick(driftReader(() => { throw new Error("ssh: no route to host"); })());
  assert.match(unreadable.cannotTell ?? "", /no route to host/);
  assert.deepEqual(unreadable.found, []);
  const empty = unitDriftTick(driftReader({})());
  assert.match(empty.cannotTell ?? "", /no unit files/, "an empty answer is also 'I did not look'");
});

test("exitCodeFor: an unread host is CANNOT_ASK and never QUIET; a clean read is QUIET; any finding is ATTENTION and outranks it", () => {
  const found = (unitDrift: Partial<Parameters<typeof exitCodeFor>[0]["unitDrift"]>, rest: Partial<Parameters<typeof exitCodeFor>[0]> = {}) =>
    ({ overdue: [], offFleet: [], unitDrift: { fresh: [], notShipped: [], cannotTell: null, ...unitDrift }, buildIncident: NO_INCIDENT_TICK, ...rest });
  assert.equal(exitCodeFor(found({}), null), EXIT.QUIET, "positive control: nothing to say, host read");
  assert.equal(exitCodeFor(found({ cannotTell: "ssh refused" }), null), EXIT.CANNOT_ASK);
  assert.equal(exitCodeFor(found({ notShipped: ["a11y-bootstrap.service"] }), null), EXIT.QUIET, "not-shipped alone");
  assert.equal(exitCodeFor(found({ fresh: [`unit-drift: ${UNIT} differs`] }), null), EXIT.ATTENTION);
  assert.equal(exitCodeFor(found({ cannotTell: "ssh refused" }, { offFleet: ["a11y-worker-5: build x (fleet y)"] }), null), EXIT.ATTENTION,
    "a finding that was made stays made");
});

test("exitCodeFor: an unread auto-off refusal is CANNOT_ASK and never QUIET; a read {} is QUIET; a read refusal is ATTENTION (#4734)", () => {
  const nothing = { overdue: [], offFleet: [], unitDrift: { fresh: [], notShipped: [], cannotTell: null }, buildIncident: NO_INCIDENT_TICK };
  const refusal = { reason: "stale-checkout", detail: "behind main", at: 1 };
  assert.equal(exitCodeFor(nothing, null), EXIT.QUIET, "positive control: the host was read and refused nothing");
  assert.equal(exitCodeFor(nothing, UNREAD), EXIT.CANNOT_ASK);
  assert.equal(exitCodeFor(nothing, refusal), EXIT.ATTENTION);
  assert.equal(exitCodeFor({ ...nothing, offFleet: ["a11y-worker-5: build x (fleet y)"] }, UNREAD), EXIT.ATTENTION, "ATTENTION outranks it");
});

test("watchFleet(): a differing unit is raised once, carried through an unreadable tick, and clears when the unit is re-installed", async () => {
  const store = memoryStore();
  const quiet = reading([boxRow(2)], {});
  let host: () => Record<string, string> = () => staleService;
  const run = offFleetRun(store, { unitDrift: () => driftReader(host)() });
  const first = await run(quiet, 1_000);
  assert.deepEqual(first.unitDrift.fresh, [`unit-drift: ${UNIT} differs`], "first tick: raised");
  assert.deepEqual(first.offFleet, [], "and not as an off-fleet box line, which has its own heading");
  assert.deepEqual((await run(quiet, 2_000)).unitDrift.fresh, [], "second tick, nothing changed: not raised twice");
  const said: string[] = [];
  const spy = console.error; console.error = (message: string) => { said.push(message); };
  try {
    host = () => { throw new Error("ssh: no route to host"); };
    const unread = await run(quiet, 3_000);
    assert.equal(unread.unitDrift.fresh.length, 0, "an unread host raises nothing");
    assert.match(unread.unitDrift.cannotTell ?? "", /no route to host/);
  } finally { console.error = spy; }
  assert.match(said.join("\n"), /CANNOT READ the control host's unit drift.*no route to host/, "and SAYS it could not look");
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), { [`unit-drift: ${UNIT} differs`]: 1_000 }, "the line was carried, with its first-seen time");
  host = () => staleService;
  assert.deepEqual((await run(quiet, 4_000)).unitDrift.fresh, [], "the host answers again, still stale: not re-posted");
  host = () => asShipped;
  assert.equal((await run(quiet, 5_000)).unitDrift.cannotTell, null);
  assert.deepEqual(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read), {}, "a re-installed unit clears the line");
  host = () => staleService;
  assert.equal((await run(quiet, 6_000)).unitDrift.fresh.length, 1, "a relapse is a new event and is raised again");
});

test("watchFleet(): with no drift reader the tick claims nothing and the ledger's drift lines stand", async () => {
  const store = memoryStore();
  const quiet = reading([boxRow(2)], {});
  await offFleetRun(store, { unitDrift: driftReader(staleService) })(quiet, 1_000);
  const unasked = await offFleetRun(store)(quiet, 2_000);
  assert.deepEqual(unasked.unitDrift, { fresh: [], notShipped: [], cannotTell: null });
  assert.deepEqual(Object.keys(readState(DEFAULT_OFF_FLEET_STATE_PATH, store.read)), [`unit-drift: ${UNIT} differs`]);
});

test("watchFleet(): a drift reader that THROWS (not just a host that will not answer) is CANNOT_TELL, not a crash and not clean", async () => {
  const store = memoryStore();
  const spy = console.error; console.error = () => undefined;
  try {
    const run = await offFleetRun(store, { unitDrift: () => { throw new Error("ENOENT: ansible"); } })(reading([boxRow(2)], {}), 1_000);
    assert.match(run.unitDrift.cannotTell ?? "", /ENOENT: ansible/);
  } finally { console.error = spy; }
});

test("unitDriftBody names the count, every unit and kind, and the live-reading command", () => {
  const body = unitDriftBody([`unit-drift: ${UNIT} differs`, `unit-drift: ${TIMER} missing-on-host`]);
  assert.match(body, /\*\*2 control-plane unit\(s\) not running the text this repository ships/);
  assert.match(body, new RegExp(`^- ${UNIT} differs$`, "m"));
  assert.match(body, /control-unit-drift\.ts/);
});

// ---- the fleet's daily use reading (#5016) ----

const USE_NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const USE_HOUR = 3_600_000;
const withCount = (name: string, state: string, captures: number) => ({ name, state, captures } as unknown as WatchRow);

/** `ticks` hourly ticks ending at USE_NOW, each fed `rowsAt(i)` through the same functions the watch runs. */
function ledgerOfTicks(ticks: number, rowsAt: (i: number) => WatchRow[]): CapturesState {
  let state: CapturesState | null = null;
  for (let i = 0; i < ticks; i++) {
    const at = USE_NOW - (ticks - 1 - i) * USE_HOUR;
    const rows = rowsAt(i);
    state = withUseTick(advanceCaptures(rows, state, at), rows, at);
  }
  return state as CapturesState;
}

const lastTick = (state: CapturesState) => state.ticks![state.ticks!.length - 1];

test("use tick: a box whose count ROSE is worked and one awake and idle is not; unreachable is neither (#3023)", () => {
  const before = advanceCaptures([withCount("w2", "ready", 4), withCount("w3", "ready", 7), withCount("w4", "unreachable", 0)], null, USE_NOW - USE_HOUR);
  const rows = [withCount("w2", "ready", 6), withCount("w3", "ready", 7), withCount("w4", "unreachable", 0)];
  const after = withUseTick(advanceCaptures(rows, before, USE_NOW), rows, USE_NOW);
  assert.deepEqual(lastTick(after).awake, ["w2", "w3"], "the unreachable box is not awake");
  assert.deepEqual(lastTick(after).worked, ["w2"], "w3 was awake and idle; w4 was not awake, so it cannot have worked");
});

test("use tick: a `busy` box is worked even when its count did not move", () => {
  const rows = [withCount("w2", "busy", 4)];
  const first = advanceCaptures(rows, null, USE_NOW);
  assert.deepEqual(lastTick(withUseTick(first, rows, USE_NOW)).worked, ["w2"]);
});

test("use tick: a rise the 10 s auto-off probe saw between two ticks still makes that tick's box worked", () => {
  const rows = [withCount("w2", "ready", 4)];
  const t0 = withUseTick(advanceCaptures(rows, null, USE_NOW - USE_HOUR), rows, USE_NOW - USE_HOUR);
  const probed = advanceCaptures([withCount("w2", "ready", 5)], t0, USE_NOW - USE_HOUR / 2);
  const rowsNow = [withCount("w2", "ready", 5)];
  const after = withUseTick(advanceCaptures(rowsNow, probed, USE_NOW), rowsNow, USE_NOW);
  assert.deepEqual(lastTick(after).worked, ["w2"]);
});

test("use tick: ticks are bounded to 48 h", () => {
  const state = ledgerOfTicks(60, () => [withCount("w2", "ready", 1)]);
  assert.ok(state.ticks!.every((tick) => USE_NOW - tick.at < 48 * USE_HOUR));
  assert.equal(state.ticks!.length, 48);
});

test("useReading: fewer than 20 ticks is `unknown`, naming the count and the start -- not a share", () => {
  const reading = useReading(ledgerOfTicks(MIN_USE_TICKS - 1, () => [withCount("w2", "busy", 1)]), USE_NOW);
  assert.equal(reading.kind, "unknown");
  assert.equal(reading.kind === "unknown" && reading.observedTicks, MIN_USE_TICKS - 1);
  assert.match(useBody(reading, USE_NOW), /^### Fleet use, 2026-10-11\n\nunknown: observed 19 ticks since 2026-10-10T/);
});

test("useReading: at 20 ticks the share is worked over awake, per box and in total", () => {
  // w2 is busy every tick; w3 awake and idle every tick; w4 never answers.
  const state = ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 3), withCount("w3", "ready", 0), withCount("w4", "unreachable", 0)]);
  const reading = useReading(state, USE_NOW);
  assert.equal(reading.kind, "reading");
  if (reading.kind !== "reading") return;
  assert.equal(reading.awakeTicks, 40);
  assert.equal(reading.workedTicks, 20);
  assert.equal(reading.share, 0.5);
  assert.deepEqual(reading.boxes.map((r) => [r.box, r.awakeTicks, r.workedTicks]), [["w2", 20, 20], ["w3", 20, 0], ["w4", 0, 0]]);
  assert.match(useBody(reading, USE_NOW), /\| w3 \| 0 \| 20 \| 0 \|[\s\S]*50% of awake box-hours did work/);
});

test("useReading: a fleet where nothing ever answered has NO share, rather than 0%", () => {
  const state = ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "unreachable", 0)]);
  const reading = useReading(state, USE_NOW);
  assert.equal(reading.kind === "reading" && reading.share, null);
});

test("readCapturesState: a file written before the use reading (no `ticks`) is READ, and reads as unknown", () => {
  const old = JSON.stringify({ since: USE_NOW - USE_HOUR, workers: { w2: { captures: 3, seenAt: USE_NOW, lastRoseAt: null, rises: [] } } });
  const state = readCapturesState("x", (() => old) as never);
  assert.notEqual(state, null);
  assert.deepEqual(useReading(state, USE_NOW), { kind: "unknown", observedTicks: 0, since: USE_NOW - USE_HOUR });
  const after = withUseTick(advanceCaptures([withCount("w2", "ready", 3)], state, USE_NOW), [withCount("w2", "ready", 3)], USE_NOW);
  assert.equal(after.ticks!.length, 1, "the next tick starts the field on the old ledger");
});

test("advanceCaptures from the auto-off probe keeps the ticks and the posted day it did not write", () => {
  const state = { ...ledgerOfTicks(3, () => [withCount("w2", "ready", 1)]), usePostedOn: "2026-10-11" };
  const after = advanceCaptures([withCount("w2", "ready", 2)], state, USE_NOW + 10_000);
  assert.equal(after.ticks!.length, 3);
  assert.equal(after.usePostedOn, "2026-10-11");
});

test("postUseOnce: the first tick of a UTC day posts, a second the same day posts NOTHING, the next day posts again", () => {
  let file = JSON.stringify(ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]));
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  const posted: string[] = [];
  const run = (now: number) => postUseOnce({ path: "c.json", now, post: (b) => posted.push(b), read, write });
  assert.equal(run(USE_NOW), "posted");
  assert.equal(run(USE_NOW + USE_HOUR), "already-posted");
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^### Fleet use, 2026-10-11/);
  assert.equal(run(USE_NOW + 24 * USE_HOUR), "posted", "positive control: the guard is the day, not a latch");
  assert.equal(posted.length, 2);
});

test("postUseOnce: an unreadable ledger posts nothing and writes nothing", () => {
  let written = false;
  const write = (() => { written = true; }) as never;
  assert.equal(postUseOnce({ path: "c.json", now: USE_NOW, post: () => assert.fail("posted"), read: (() => "nope") as never, write }), "unreadable");
  assert.equal(written, false);
});

test("postUseOnce: a tick that lands WHILE the first is posting posts nothing (the day is reserved before the post, #53 review)", () => {
  let file = JSON.stringify(ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]));
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  const posted: string[] = [];
  let during: string | null = null;
  // pid and liveness are injected: the test must not depend on what `process.pid` or `process.kill` are inside a runner's worker
  const owner = { pid: 111, alive: (pid: number) => pid === 111 };
  const second = () => postUseOnce({ path: "c.json", now: USE_NOW + 60_000, post: (b) => posted.push(b), read, write, ...owner, pid: 222 });
  const first = postUseOnce({ path: "c.json", now: USE_NOW, read, write, ...owner, post: (b) => { posted.push(b); during = second(); } });
  assert.equal(first, "posted");
  assert.equal(during, "in-progress", "the racing tick found the day reserved");
  assert.equal(posted.length, 1);
});

test("postUseOnce: a SLOW live owner keeps the day however long its post runs; a DEAD owner's reservation is taken over", () => {
  let file = JSON.stringify(ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]));
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  const live = new Set([111]);
  const alive = (pid: number) => live.has(pid);
  // run A (pid 111) is still posting, an hour less a minute on: its reservation stands
  file = JSON.stringify({ ...JSON.parse(file), useReservedAt: USE_NOW, useReservedBy: 111 });
  const posted: string[] = [];
  const run = (now: number, pid: number) => postUseOnce({ path: "c.json", now, read, write, pid, alive, post: (b) => posted.push(b) });
  assert.equal(run(USE_NOW + USE_RESERVATION_MAX_MS - 1, 222), "in-progress", "a slow owner is not mistaken for a dead one");
  live.delete(111);
  assert.equal(run(USE_NOW + 1_000, 222), "posted", "the owner is gone, so the day is not lost");
  assert.equal(JSON.parse(file).usePostedOn, "2026-10-11");
  assert.equal(JSON.parse(file).useReservedBy, undefined);
  assert.equal(run(USE_NOW + 2_000, 333), "already-posted");
  assert.equal(posted.length, 1);
});

test("postUseOnce: a reservation older than the cap is not believed even if its pid is alive (a recycled pid)", () => {
  let file = JSON.stringify({ ...ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]), useReservedAt: USE_NOW, useReservedBy: 111 });
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  const posted: string[] = [];
  const out = postUseOnce({ path: "c.json", now: USE_NOW + USE_RESERVATION_MAX_MS, read, write, pid: 222, alive: () => true, post: (b) => posted.push(b) });
  assert.equal(out, "posted");
});

test("postUseOnce: the commit is written only AFTER the post returned", () => {
  let file = JSON.stringify(ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]));
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  let seenDuring: { usePostedOn?: string, useReservedAt?: number, useReservedBy?: number } = {};
  postUseOnce({ path: "c.json", now: USE_NOW, read, write, pid: 111, post: () => { seenDuring = JSON.parse(file); } });
  assert.equal(seenDuring.usePostedOn, undefined);
  assert.equal(seenDuring.useReservedAt, USE_NOW);
  assert.equal(seenDuring.useReservedBy, 111);
});

test("postUseOnce: a failed post RELEASES the reservation, so the race fix does not lose the day", () => {
  let file = JSON.stringify(ledgerOfTicks(MIN_USE_TICKS, () => [withCount("w2", "busy", 1)]));
  const read = (() => file) as never;
  const write = ((_p: string, data: string) => { file = data; }) as never;
  assert.throws(() => postUseOnce({ path: "c.json", now: USE_NOW, read, write, post: () => { throw new Error("gh down"); } }));
  assert.equal(JSON.parse(file).usePostedOn, undefined);
  const posted: string[] = [];
  assert.equal(postUseOnce({ path: "c.json", now: USE_NOW + USE_HOUR, read, write, post: (b) => posted.push(b) }), "posted");
});

test("pidAlive: a signal that lands is alive, EPERM is alive (exists, not ours), ESRCH is dead", () => {
  const raising = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(pidAlive(1, () => true), true);
  assert.equal(pidAlive(1, raising("EPERM")), true);
  assert.equal(pidAlive(1, raising("ESRCH")), false);
});

test("the post body rendered from a fixture state (the PR shows this)", () => {
  const state = ledgerOfTicks(MIN_USE_TICKS, (i) => [withCount("a11y-worker-2", i % 2 ? "busy" : "ready", 0), withCount("a11y-worker-3", "ready", 0), withCount("a11y-worker-4", "unreachable", 0)]);
  console.log(useBody(useReading(state, USE_NOW), USE_NOW));
});

// a11ign#5026: the Windows build spread files ONE stop-the-line incident, behind `WatchDeps.buildIncident`.

test("watchFleet(): the build-incident seam is handed the status of THIS reading and its tick comes back on the finding", async () => {
  const rows = [2, 3, 4].map((n) => boxRow(n));
  const status = reading(rows, { reportedOnly: [driftOf("windowsBuild", { 2: BUILD, 3: BUILD, 4: "26100.4651" })] });
  const asked: unknown[] = [];
  const run = offFleetRun(memoryStore(), { buildIncident: (seen) => { asked.push(seen); return { fresh: ["filed #9001"], closed: [], cannotAsk: null }; } });
  const found = await run(status, 1_000);
  assert.deepEqual(found.buildIncident.fresh, ["filed #9001"]);
  assert.equal(asked.length, 1, "one call per reading");
  assert.deepEqual((asked[0] as { rows: unknown }).rows, rows);
});

test("watchFleet(): with no build-incident seam nothing is claimed (NEGATIVE CONTROL: a caller that did not ask)", async () => {
  const found = await offFleetRun(memoryStore())(reading([boxRow(2)], {}), 1_000);
  assert.deepEqual(found.buildIncident, NO_INCIDENT_TICK);
});

test("exitCodeFor: a filed build incident is ATTENTION; one that could not be asked is CANNOT_ASK and never QUIET; ATTENTION outranks it", () => {
  const base = { overdue: [], offFleet: [], unitDrift: { fresh: [], notShipped: [], cannotTell: null } };
  const incident = (tick: Partial<typeof NO_INCIDENT_TICK>) => ({ ...base, buildIncident: { ...NO_INCIDENT_TICK, ...tick } });
  assert.equal(exitCodeFor(incident({}), null), EXIT.QUIET, "positive control: a clean tick is QUIET");
  assert.equal(exitCodeFor(incident({ fresh: ["filed #9001"] }), null), EXIT.ATTENTION);
  assert.equal(exitCodeFor(incident({ cannotAsk: "gh: HTTP 502" }), null), EXIT.CANNOT_ASK);
  assert.equal(exitCodeFor(incident({ cannotAsk: "gh: HTTP 502", fresh: ["filed #9001"] }), null), EXIT.ATTENTION);
  assert.equal(exitCodeFor(incident({ closed: [5100] }), null), EXIT.QUIET, "a close is the line lifting, not a finding");
});
