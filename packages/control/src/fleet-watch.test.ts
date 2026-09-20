// #1815: "the fleet is the org's scarcest resource and the only major subsystem with no eyes on it."
// Every test below is fixture-driven -- a fake `fleetStatus`, a fake clock, an in-memory `read`/`write` --
// so none of it needs the fleet, matching `lab-watch.test.ts`'s own reasoning for the identical shape one
// subsystem over.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readState, writeState, advance, overdue, watchBody, watch, DEFAULT_THRESHOLD_MS } from "./fleet-watch.mjs";

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
  const body = watchBody([{ name: "a11y-worker-3", state: "unreachable", ageMs: 60_000, reason: null }]);
  assert.match(body, /`a11y-worker-3` unreachable for 1m$/m);
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
