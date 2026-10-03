// no-token: none -- every test drives pure functions or `watch()` with an injected `getStatus`, clock and
// in-memory `read`/`write`; nothing reaches the fleet or runs `main()`.
//
// #2979 (found by #2937): the gate cannot ask "is the fleet idle while work waits" because no state it
// holds says WHEN the fleet last captured. `/health` `captures` is a count since boot with no time on it, so
// `fleet-watch.mjs` now keeps each worker's last count, when it was seen and when it last ROSE.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  advanceCaptures, captureTimes, readCapturesState, readCaptureTimes, writeCapturesState, watch,
  DEFAULT_CAPTURES_STATE_PATH,
} from "./fleet-watch.mjs";

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

function row(name: string, captures: number | null) {
  return { name, state: "ready", captures };
}

/** Run readings through the ledger in order, each at its own time, as separate scheduled runs would. */
function ledgerAfter(readings: Array<[number, Array<ReturnType<typeof row>>]>) {
  let state = null as ReturnType<typeof advanceCaptures> | null;
  for (const [at, rows] of readings) state = advanceCaptures(rows, state, at);
  return state;
}

test("a count that RISES records the time it rose", () => {
  const state = ledgerAfter([[NOW - 2 * HOUR, [row("w2", 10)]], [NOW - HOUR, [row("w2", 14)]]]);
  assert.deepEqual(state?.workers.w2, {
    captures: 14, seenAt: NOW - HOUR, lastRoseAt: NOW - HOUR, rises: [{ at: NOW - HOUR, by: 4 }],
  });
});

test("first sight of a worker records its count and NO capture: the count predates the ledger", () => {
  const state = ledgerAfter([[NOW, [row("w2", 500)]]]);
  assert.equal(state?.workers.w2.lastRoseAt, null);
  assert.deepEqual(state?.workers.w2.rises, []);
});

test("a count that FALLS is a restart: a reset baseline, and the new count is what it captured since boot (#3205)", () => {
  const state = ledgerAfter([
    [NOW - 3 * HOUR, [row("w2", 10)]],
    [NOW - 2 * HOUR, [row("w2", 12)]],
    [NOW - HOUR, [row("w2", 1)]],
  ]);
  const worker = state?.workers.w2;
  assert.equal(worker?.captures, 1, "the lower count is the new baseline");
  assert.equal(worker?.lastRoseAt, NOW - HOUR, "the restart's capture is a capture");
  assert.deepEqual(worker?.rises, [{ at: NOW - 2 * HOUR, by: 2 }, { at: NOW - HOUR, by: 1 }]);
  assert.equal(captureTimes(state, NOW)?.captures24h, 3, "never negative, and never the old count minus the new");

  const after = advanceCaptures([row("w2", 3)], state, NOW);
  assert.deepEqual(after.workers.w2.rises.at(-1), { at: NOW, by: 2 }, "and counting resumes from the new baseline");
});

test("a fleet whose count never rose in 24 h answers captures24h 0 WITH the last time it did", () => {
  const rose = NOW - 30 * HOUR;
  const state = ledgerAfter([[rose - HOUR, [row("w2", 5)]], [rose, [row("w2", 9)]], [NOW, [row("w2", 9)]]]);
  assert.deepEqual(captureTimes(state, NOW), { captures24h: 0, lastCaptureAt: rose, observedSince: rose - HOUR });
});

test("POSITIVE CONTROL: a worker whose count rose an hour ago answers a non-zero captures24h", () => {
  const state = ledgerAfter([[NOW - 2 * HOUR, [row("w2", 5)]], [NOW - HOUR, [row("w2", 8)]]]);
  assert.deepEqual(captureTimes(state, NOW), {
    captures24h: 3, lastCaptureAt: NOW - HOUR, observedSince: NOW - 2 * HOUR,
  });
});

test("the fleet answer sums every worker and takes the latest rise of any", () => {
  const state = ledgerAfter([
    [NOW - 3 * HOUR, [row("w2", 0), row("w3", 0)]],
    [NOW - 2 * HOUR, [row("w2", 4), row("w3", 0)]],
    [NOW - HOUR, [row("w2", 4), row("w3", 6)]],
  ]);
  assert.deepEqual(captureTimes(state, NOW), { captures24h: 10, lastCaptureAt: NOW - HOUR, observedSince: NOW - 3 * HOUR });
});

test("an unreachable worker is not a reading: its entry is kept, and a higher count later is a rise", () => {
  const state = ledgerAfter([
    [NOW - 3 * HOUR, [row("w2", 5)]],
    [NOW - 2 * HOUR, [row("w2", null)]],
    [NOW - HOUR, [row("w2", 7)]],
  ]);
  assert.deepEqual(state?.workers.w2.rises, [{ at: NOW - HOUR, by: 2 }]);
});

test("rises older than the window are pruned from the file but lastRoseAt outlives them", () => {
  const state = ledgerAfter([
    [NOW - 40 * HOUR, [row("w2", 0)]],
    [NOW - 39 * HOUR, [row("w2", 3)]],
    [NOW, [row("w2", 3)]],
  ]);
  assert.deepEqual(state?.workers.w2.rises, []);
  assert.equal(state?.workers.w2.lastRoseAt, NOW - 39 * HOUR);
});

test("a MISSING or CORRUPT file answers null -- unknown, never zero captures", () => {
  const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  assert.equal(readCaptureTimes("x.json", NOW, missing as never), null);
  for (const corrupt of ["not json", "[1,2]", "{}", '{"since":1,"workers":{"w2":{"captures":"3"}}}', "null"]) {
    assert.equal(readCaptureTimes("x.json", NOW, (() => corrupt) as never), null, corrupt);
  }
  assert.equal(captureTimes(null, NOW), null);
});

test("a ledger that has watched nothing rise is 0 with no last time, not null", () => {
  assert.deepEqual(captureTimes(ledgerAfter([[NOW, [row("w2", 4)]]]), NOW), {
    captures24h: 0, lastCaptureAt: null, observedSince: NOW,
  });
});

test("writeCapturesState/readCapturesState round-trip", () => {
  let stored = "";
  const state = ledgerAfter([[NOW - HOUR, [row("w2", 1)]], [NOW, [row("w2", 2)]]])!;
  writeCapturesState("x.json", state, ((_path: string, data: string) => { stored = data; }) as never);
  assert.deepEqual(readCapturesState("x.json", (() => stored) as never), state);
});

test("watch() records capture times across two ticks through the file, and a corrupt file starts over", async () => {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const data = files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  }) as never;
  const write = ((path: string, data: string) => { files.set(path, data); }) as never;
  const tick = (at: number, captures: number) => watch({
    getStatus: async () => ({ rows: [row("w2", captures)] }), now: () => at, read, write,
  });

  await tick(NOW - HOUR, 3);
  await tick(NOW, 8);
  const reader = (path: string) => files.get(path) as string;
  assert.deepEqual(readCaptureTimes(DEFAULT_CAPTURES_STATE_PATH, NOW, reader as never), {
    captures24h: 5, lastCaptureAt: NOW, observedSince: NOW - HOUR,
  });

  files.set(DEFAULT_CAPTURES_STATE_PATH, "garbage");
  await tick(NOW + HOUR, 9);
  assert.equal(readCaptureTimes(DEFAULT_CAPTURES_STATE_PATH, NOW + HOUR, reader as never)?.captures24h, 0,
    "a corrupt ledger restarts from this reading: the 9 predates it and is not a capture");
});
