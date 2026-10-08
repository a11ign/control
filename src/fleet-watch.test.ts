// no-token: gh -- every test below drives pure functions or `watch()` with an injected `getStatus`/
// `read`/`write`; none of them calls `main()`, so fleet-watch.mjs's own `execFileSync("gh", ...)` (only
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
} from "./fleet-watch.mjs";

/** @typedef {{name: string, state: string, readiness?: {reason?: string|null}|null}} FleetRow */

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
