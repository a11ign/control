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
  type Drift, type FleetRow as WatchRow, type StatusReader,
} from "./fleet-watch.ts";
import { fleetConsistency } from "../../worker-fleet/src/fleet-consistency.ts";

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
