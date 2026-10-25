/**
 * BOOKING (A11-244): every job leases its boxes through the ledger before it starts and lets them go when it ends, so jobs that want the same box queue
 * and never collide. A Runner over a real store AND a real ledger, in temp directories, with fake captures that count how many sit on a box at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staticResolver } from "./fake-fleet.ts";
import { LedgerBusy } from "../fleet-leases/ledger.ts";
import { DriftUnreadable } from "./drift.ts";
import { holderOf, ledgerClaims } from "./claims.ts";
import { meanCaptureMs, queueViewOf } from "./queue-view.ts";
import { remote } from "./remote.ts";
import { BOXES, PAGES, harness, tick } from "./runner.fixture.ts";
import { Runner } from "./runner.ts";
import { renderView, viewJob } from "./view.ts";
import type { JobStore } from "./store.ts";
import type { Box, JobRequest } from "./types.ts";

const MIN = 60_000;
const requestOf = (store: JobStore, id: string): JobRequest => {
  const read = store.readRequest(id);
  assert.ok(read?.ok, `no readable request for ${id}`);
  return (read as { ok: true; value: JobRequest }).value;
};
const startedOf = (state: { captures: { startedAt?: string }[] }): number => Math.min(...state.captures.map((c) => Date.parse(c.startedAt!)));
const finishedOf = (state: { captures: { finishedAt?: string }[] }): number => Math.max(...state.captures.map((c) => Date.parse(c.finishedAt!)));

/** A capture that waits for `open()` before it answers, so a test can look at a job that is running. */
function gated() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
}

async function ticks(times: number): Promise<void> { for (let i = 0; i < times; i++) await tick(); }

test("two jobs asking for overlapping named boxes run one after the other: the second is queued at place 1, waiting on the first, and starts only after it ends", async () => {
  const g = gated();
  const t = harness({ capture: async (box, body) => { t.asked.push({ box: box.name, page: body.url as string }); await g.gate; return { status: 200, json: {} }; } });
  const first = t.submit({ kind: "named", names: ["w2", "w3"] });
  const second = t.submit({ kind: "named", names: ["w3", "w4"] });
  await t.runner.tick();
  assert.equal(t.state(first).state, "running");
  assert.equal(t.store.readState(second), null, "the second stays queued while the first holds w3");
  const standing = queueViewOf({ ledger: t.ledger, store: t.store, now: Date.now(), fleet: BOXES.map((b) => b.name) }, second);
  assert.deepEqual([standing?.place, standing?.of, standing?.waitingOn], [1, 1, [holderOf(first)]]);
  g.open();
  await t.runner.settled();
  await t.drain();
  await t.runner.settled();
  assert.equal(t.state(first).state, "done");
  assert.equal(t.state(second).state, "done");
  assert.ok(startedOf(t.state(second)) >= finishedOf(t.state(first)), "no capture of the second began before the first had ended");
  assert.deepEqual(t.ledger.held(), {}, "both leases are gone");
  t.done();
});

test("two jobs asking for 2 boxes of a 2-box fleet run one after the other, and no box ever holds two captures", async () => {
  const t = harness({ boxes: staticResolver(BOXES.slice(0, 2)) });
  const first = t.submit({ kind: "count", count: 2 });
  const second = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  assert.equal(t.store.readState(second), null);
  await t.runner.settled();
  await t.drain();
  assert.equal(t.state(first).state, "done");
  assert.equal(t.state(second).state, "done");
  assert.ok([...t.peak.values()].every((n) => n === 1), `peak per box: ${[...t.peak]}`);
  assert.ok(startedOf(t.state(second)) >= finishedOf(t.state(first)));
  t.done();
});

test("two runners that share one ledger never put two jobs on a box, whatever each one's memory says", async () => {
  const g = gated();
  const a = harness({ capture: async (box, body) => { a.asked.push({ box: box.name, page: body.url as string }); await g.gate; return { status: 200, json: {} }; } });
  const b = harness({}, { ledger: a.ledger });
  const firstId = a.submit({ kind: "named", names: ["w2", "w3"] });
  // the two runners number their jobs alike, as two services' clocks could; a job ID is the ledger's key, so this one is made distinct
  const secondId = b.submit({ kind: "named", names: ["w3", "w4"] }, { id: "fj-20261025T090000Z-0ff0ff" });
  await a.runner.tick();
  await b.runner.tick();
  assert.equal(a.state(firstId).state, "running");
  assert.equal(b.store.readState(secondId), null, "the other runner is kept off w3 by the ledger, with no word from the first");
  g.open();
  await a.runner.settled();
  await b.drain();
  assert.equal(b.state(secondId).state, "done");
  assert.deepEqual(a.ledger.held(), {});
  a.done(); b.done();
});

test("an older queued job is served before a younger one, even when the younger reached the ledger first", async () => {
  const g = gated();
  const t = harness({ capture: async (box, body) => { t.asked.push({ box: box.name, page: body.url as string }); await g.gate; return { status: 200, json: {} }; } });
  const holder = t.submit({ kind: "named", names: ["w2"] });
  await t.runner.tick();
  const older = t.submit({ kind: "named", names: ["w2"] });
  const younger = t.submit({ kind: "named", names: ["w2"] });
  // the younger is already in the ledger, as a previous service left it; the older is enqueued after, and keeps its submission time
  ledgerClaims(t.ledger).enqueue({ id: younger, label: "A11-243", boxes: { kind: "named", names: ["w2"] }, submittedAt: (t.store.readRequest(younger) as { value: { submittedAt: string } }).value.submittedAt });
  await t.runner.tick();
  assert.deepEqual(t.ledger.queued().map((w) => w.id), [older, younger]);
  g.open();
  await t.runner.settled();
  await t.drain();
  await t.drain();
  assert.equal(t.state(holder).state, "done");
  assert.ok(startedOf(t.state(older)) <= startedOf(t.state(younger)));
  assert.ok(finishedOf(t.state(older)) <= startedOf(t.state(younger)), "and the younger waited for it");
  t.done();
});

test("a later small job does not start on free boxes while an earlier job waits for its count", async () => {
  const g = gated();
  const t = harness({ capture: async (box, body) => { t.asked.push({ box: box.name, page: body.url as string }); await g.gate; return { status: 200, json: {} }; } });
  const holder = t.submit({ kind: "named", names: ["w2"] });
  const big = t.submit({ kind: "count", count: 3 });
  const small = t.submit({ kind: "named", names: ["w4"] });
  await t.runner.tick();
  assert.equal(t.state(holder).state, "running");
  assert.equal(t.store.readState(big), null, "it needs 3 boxes and only 2 are free");
  assert.equal(t.store.readState(small), null, "w4 is free, but the job ahead of it has not been served: no starving");
  g.open();
  await t.runner.settled();
  await t.drain();
  await t.drain();
  assert.equal(t.state(big).state, "done");
  assert.equal(t.state(small).state, "done");
  assert.ok(startedOf(t.state(small)) >= finishedOf(t.state(big)));
  t.done();
});

test("a stale lease expires: it blocks a job until its expiry, and then the job takes the box and the stale entry is dropped from the file", async () => {
  const clock = { at: Date.UTC(2026, 9, 25, 9, 30) };
  const t = harness({ now: () => clock.at });
  t.ledger.tryTake({ id: "fj-gone", holder: holderOf("fj-gone"), kind: "capture", label: "a holder that has died", boxes: ["w2"], ttlMs: 5 * MIN });
  const id = t.submit({ kind: "named", names: ["w2"] });
  await t.drain();
  assert.equal(t.store.readState(id), null, "blocked by the lease");
  clock.at += 5 * MIN - 1;
  await t.drain();
  assert.equal(t.store.readState(id), null, "and still blocked a millisecond before it lapses");
  clock.at += 1;
  await t.drain();
  assert.equal(t.state(id).state, "done");
  const file = JSON.parse(readFileSync(t.ledger.path, "utf8")) as { leases: { id: string }[] };
  assert.ok(!file.leases.some((l) => l.id === "fj-gone"), "the stale entry is not in the file");
  t.done();
});

test("a stale queue entry in the ledger does not hold up the job behind it", async () => {
  const clock = { at: Date.UTC(2026, 9, 25, 9, 30) };
  const t = harness({ now: () => clock.at });
  t.ledger.enqueue({ id: "fj-ghost", holder: holderOf("fj-ghost"), kind: "capture", label: "a job whose service died", want: { count: 3 }, enqueuedAt: 1, ttlMs: 5 * MIN });
  const id = t.submit({ kind: "named", names: ["w2"] });
  await t.drain();
  assert.equal(t.store.readState(id), null, "the ghost is at the head of the line");
  clock.at += 5 * MIN;
  await t.drain();
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a running job renews its lease every renewEveryMs and says when it expects to end; a queued job renews its place", async () => {
  const clock = { at: Date.UTC(2026, 9, 25, 9, 30) };
  const g = gated();
  let calls = 0;
  const t = harness({ now: () => clock.at, renewEveryMs: 30_000, capture: async () => { calls += 1; if (calls > 1) await g.gate; clock.at += 1000; return { status: 200, json: {} }; } });
  const running = t.submit({ kind: "named", names: ["w2"] });
  const queued = t.submit({ kind: "named", names: ["w2"] });
  await t.runner.tick();
  await ticks(5);
  const taken = t.ledger.leaseOf(running)!;
  clock.at += 31_000;
  await t.runner.tick();
  const renewed = t.ledger.leaseOf(running)!;
  assert.equal(renewed.takenAt, taken.takenAt);
  assert.ok(renewed.renewedAt >= taken.renewedAt + 31_000, "renewed after the interval");
  assert.ok(renewed.expiresAt > taken.expiresAt, "and pushed out");
  assert.ok(renewed.expectedEnd !== null && renewed.expectedEnd > renewed.renewedAt, "with an expected end from the captures it has finished");
  assert.ok(t.ledger.queued().find((w) => w.id === queued)!.expiresAt > taken.expiresAt, "the queued job renewed its place");
  g.open();
  await t.runner.settled();
  t.done();
});

test("a lease is released when the job ends: done, failed or cancelled", async () => {
  const done = harness();
  await (async () => { done.submit({ kind: "count", count: 2 }); await done.drain(); })();
  assert.deepEqual(done.ledger.held(), {}, "done");
  done.done();

  const failed = harness({ capture: async () => ({ status: 503, json: { error: "down" } }) });
  const failedId = failed.submit({ kind: "count", count: 2 }, { pages: [...PAGES, ...PAGES] });
  await failed.drain();
  assert.equal(failed.state(failedId).state, "failed");
  assert.deepEqual(failed.ledger.held(), {}, "failed");
  failed.done();

  const g = gated();
  const cancelled = harness({ capture: async () => { await g.gate; return { status: 200, json: {} }; } });
  const id = cancelled.submit({ kind: "count", count: 2 });
  await cancelled.runner.tick();
  await tick();
  assert.equal(Object.keys(cancelled.ledger.held()).length, 2, "it holds its boxes while it runs");
  cancelled.store.markCancelled(id, new Date().toISOString());
  g.open();
  await cancelled.runner.settled();
  assert.equal(cancelled.state(id).state, "cancelled");
  assert.deepEqual(cancelled.ledger.held(), {}, "cancelled");
  cancelled.done();
});

test("a queued job that is cancelled leaves the queue", async () => {
  const g = gated();
  const t = harness({ capture: async () => { await g.gate; return { status: 200, json: {} }; } });
  t.submit({ kind: "named", names: ["w2"] });
  const waiting = t.submit({ kind: "named", names: ["w2"] });
  await t.runner.tick();
  assert.deepEqual(t.ledger.queued().map((w) => w.id), [waiting]);
  t.store.markCancelled(waiting, new Date().toISOString());
  await t.runner.tick();
  assert.equal(t.state(waiting).state, "cancelled");
  assert.deepEqual(t.ledger.queued(), []);
  g.open();
  await t.runner.settled();
  t.done();
});

test("a box whose part of the job is finished is released before the job ends, so the next job starts on it", async () => {
  const g = gated();
  const t = harness({ capture: async (box, body) => { t.asked.push({ box: box.name, page: body.url as string }); await g.gate; return { status: 200, json: {} }; } });
  const long = t.submit({ kind: "named", names: ["w2", "w3"] }, { pages: ["https://x.test/only"] });
  const next = t.submit({ kind: "named", names: ["w3"] });
  await t.runner.tick();
  assert.deepEqual(t.state(long).captures.map((c) => c.box), ["w2"], "the one page is on w2, and w3 has no work at all");
  assert.deepEqual(t.ledger.leaseOf(long)?.boxes, ["w2"], "w3 was let go at once");
  await t.runner.tick();
  assert.equal(t.state(next).state, "running", "the next job runs on w3 while the first is still running on w2");
  g.open();
  await t.runner.settled();
  t.done();
});

test("each box is released as its own share ends, while the job goes on with the others", async () => {
  const slow = gated();
  const t = harness({ capture: async (box) => { if (box.name === "w3") await slow.gate; return { status: 200, json: {} }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await ticks(10);
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w3"], "w2 finished its two pages and is free; w3 is still capturing");
  slow.open();
  await t.runner.settled();
  assert.equal(t.ledger.leaseOf(id), null);
  t.done();
});

test("a drift record that names a box in a running job takes that box out of the job: its unsent pages fail naming it, its lease is freed, and the others finish", async () => {
  const drift: Record<string, string> = {};
  const first = gated();
  const hold = gated();
  let w2Calls = 0;
  const t = harness({
    drift: () => drift,
    capture: async (box) => {
      if (box.name === "w2" && ++w2Calls === 1) await first.gate;
      if (box.name === "w3") await hold.gate;
      return { status: 200, json: {} };
    },
  });
  const id = t.submit({ kind: "count", count: 2 }, { pages: [...PAGES, "https://x.test/e", "https://x.test/f"] });
  await t.runner.tick();
  await ticks(3);
  drift.w2 = "off the manifest: edge is 155, the manifest wants 156";
  first.open();
  await ticks(10);
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w3"], "w2's lease is gone while w3 still works");
  hold.open();
  await t.runner.settled();
  const state = t.state(id);
  assert.equal(state.state, "done", state.reason ?? "");
  assert.deepEqual(state.dropped, [{ box: "w2", reason: "off the manifest: edge is 155, the manifest wants 156" }]);
  const w2 = state.captures.filter((c) => c.box === "w2");
  assert.equal(w2[0]!.status, "done", "the capture that was on the box ended and is kept");
  assert.ok(w2.slice(1).every((c) => c.status === "failed" && c.error === "w2 left the fleet: off the manifest: edge is 155, the manifest wants 156"));
  assert.ok(state.captures.filter((c) => c.box === "w3").every((c) => c.status === "done"));
  t.done();
});

test("a box leaving never frees its lease while a capture is still running on it", async () => {
  const drift: Record<string, string> = {};
  const g = gated();
  const t = harness({ drift: () => drift, capture: async (box) => { if (box.name === "w2") await g.gate; else await tick(); return { status: 200, json: {} }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await ticks(10);
  drift.w2 = "off the manifest";
  await ticks(10);
  assert.ok(t.ledger.leaseOf(id)?.boxes.includes("w2"), "w2 is mid-capture, so its lease stays");
  g.open();
  await t.runner.settled();
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a job that names a box the drift record lists fails at start, naming the box and the difference; a count is not offered it", async () => {
  const drift = { w3: "off the manifest: edge is 155, the manifest wants 156" };
  const t = harness({ drift: () => drift });
  const named = t.submit({ kind: "named", names: ["w2", "w3"] });
  const counted = t.submit({ kind: "count", count: 2 });
  await t.drain();
  assert.equal(t.state(named).state, "failed");
  assert.match(t.state(named).reason ?? "", /w3 is off the manifest: edge is 155, the manifest wants 156: a box that differs from the manifest is out of capture/);
  assert.deepEqual(t.state(counted).boxes, ["w2", "w4"]);
  assert.deepEqual(t.ledger.held(), {});
  t.done();
});

test("a job whose box the service lost its lease on cannot resume: it fails naming the box and who holds it", async () => {
  const t = harness();
  const id = t.submit({ kind: "count", count: 2 });
  t.store.writeState(id, { version: 1, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], notes: [], startedAt: "2026-10-25T09:00:00.000Z",
    captures: PAGES.map((page, i) => ({ page, pass: 1, file: `${i}.p1.json`, box: i % 2 ? "w3" : "w2", status: "pending" as const })) });
  t.ledger.tryTake({ id: "fj-other", holder: holderOf("fj-other"), kind: "capture", label: "other", boxes: ["w3"] });
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.equal(t.state(id).reason, `could not resume: w3 is held by ${holderOf("fj-other")}`);
  assert.deepEqual(t.ledger.leaseOf(id), null);
  t.done();
});

test("a graceful stop keeps the lease for the next start, which takes the same holder's lease again", async () => {
  const g = gated();
  const t = harness({ capture: async () => { await g.gate; return { status: 200, json: {} }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await tick();
  const stopped = t.runner.stop();
  g.open();
  await stopped;
  assert.equal(t.state(id).state, "running");
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w2", "w3"], "the stopped service did not give its boxes away");
  t.ledger.releaseAll(id);
  const again = gated();
  const second = new Runner({ ...t.deps, claims: ledgerClaims(t.ledger), capture: async () => { await again.gate; return { status: 200, json: {} }; } });
  await second.tick();
  await tick();
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w2", "w3"], "the resumed job holds its boxes again, under its own holder");
  assert.equal(t.ledger.leaseOf(id)?.holder, holderOf(id));
  again.open();
  await second.settled();
  assert.equal(t.state(id).state, "done");
  assert.equal(t.ledger.leaseOf(id), null);
  t.done();
});

test("a ledger that is busy for a moment fails neither a running job nor the tick: the lease is tried again, or lapses at its grace", async () => {
  const g = gated();
  let busy = true;
  const t = harness({ renewEveryMs: 0, capture: async () => { await g.gate; return { status: 200, json: {} }; } });
  const real = ledgerClaims(t.ledger);
  const guard = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => { if (busy) throw new LedgerBusy("the lease ledger lock is held"); return call(...args); };
  const claims = { ...real, renew: guard(real.renew), releaseBoxes: guard(real.releaseBoxes), release: guard(real.release) };
  const runner = new Runner({ ...t.deps, claims });
  const id = t.submit({ kind: "count", count: 2 });
  await runner.tick();
  await tick();
  await runner.tick();
  assert.ok(t.log.some((line) => /was not renewed, and will be tried again/.test(line)), "a renewal that could not be made was said, and the tick did not reject");
  g.open();
  await runner.settled();
  assert.equal(t.state(id).state, "done", "the job ended done although its lease could not be released");
  assert.ok(t.log.some((line) => /will lapse at its grace/.test(line)));
  assert.ok(t.ledger.leaseOf(id), "the lease is still there, to lapse at its expiry");
  busy = false;
  t.done();
});

test("a restart resumes a job on the boxes it still has pages for, not on one it had already let go of to another job", async () => {
  const t = harness();
  const id = t.submit({ kind: "count", count: 2 });
  const at = "2026-10-25T09:00:00.000Z";
  t.store.writeState(id, { version: 1, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], notes: [], startedAt: at,
    captures: [
      { page: PAGES[0]!, pass: 1, file: "a.p1.json", box: "w2", status: "done", startedAt: at, finishedAt: at },
      { page: PAGES[1]!, pass: 1, file: "b.p1.json", box: "w3", status: "pending" },
    ] });
  t.ledger.tryTake({ id: "fj-next", holder: holderOf("fj-next"), kind: "capture", label: "the job that took w2", boxes: ["w2"] });
  await t.drain();
  assert.equal(t.state(id).state, "done", t.state(id).reason ?? "");
  assert.deepEqual(t.asked.map((a) => a.box), ["w3"], "only w3's page was sent");
  assert.deepEqual(t.ledger.held(), { w2: [holderOf("fj-next")] }, "the other job's lease on w2 was never touched");
  t.done();
});

test("a lease that lapsed under a job still capturing is taken again at the next renewal, and the job behind it stays queued", async () => {
  const clock = { at: Date.UTC(2026, 9, 25, 9, 30) };
  const g = gated();
  const t = harness({ now: () => clock.at, renewEveryMs: 30_000, capture: async () => { await g.gate; return { status: 200, json: {} }; } });
  const running = t.submit({ kind: "named", names: ["w2"] });
  const behind = t.submit({ kind: "named", names: ["w2"] });
  await t.runner.tick();
  await tick();
  clock.at += 5 * MIN + 1;
  assert.equal(t.ledger.leaseOf(running), null, "the lease lapsed: the tick was blocked past its grace");
  await t.runner.tick();
  assert.deepEqual(t.ledger.leaseOf(running)?.boxes, ["w2"], "taken again for the box with a capture on it");
  assert.equal(t.store.readState(behind), null, "so the next job did not start on it");
  g.open();
  await t.runner.settled();
  t.done();
});

test("a drift record that names a box the job has already finished with changes nothing about the job", async () => {
  const drift: Record<string, string> = {};
  const slow = gated();
  const t = harness({ drift: () => drift, capture: async (box) => { if (box.name === "w3") await slow.gate; return { status: 200, json: {} }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await ticks(10);
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w3"], "w2 is finished and let go");
  drift.w2 = "off the manifest";
  slow.open();
  await t.runner.settled();
  assert.deepEqual(t.state(id).dropped, [], "a box that left the job's work is not recorded as having left the fleet");
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a drift record that cannot be read keeps a job that has not started queued, and takes no box from one that is running", async () => {
  let readable = false;
  const hold = gated();
  const t = harness({ drift: () => { if (!readable) throw new DriftUnreadable("the fleet drift record is not JSON"); return {}; },
    capture: async () => { await hold.gate; return { status: 200, json: {} }; } });
  const queuedId = t.submit({ kind: "named", names: ["w2"] });
  await t.drain();
  assert.equal(t.store.readState(queuedId), null, "not started on a record nobody can read");
  assert.ok(t.log.some((line) => /stays queued: the fleet drift record is not JSON/.test(line)));
  readable = true;
  await t.runner.tick();
  assert.equal(t.state(queuedId).state, "running", "and started once it can be read");
  readable = false;
  await ticks(5);
  hold.open();
  await t.runner.settled();
  assert.equal(t.state(queuedId).state, "done", "the running job went on");
  assert.deepEqual(t.state(queuedId).dropped, [], "and no box was taken from it on a guess");
  t.done();
});

// ---- the status a queued job shows

function queued() {
  const clock = { at: Date.UTC(2026, 9, 25, 9, 30) };
  const t = harness({ now: () => clock.at });
  const holder = t.submit({ kind: "named", names: ["w2", "w3"] });
  const waiting = t.submit({ kind: "named", names: ["w3", "w4"] });
  return { t, clock, holder, waiting };
}

test("`fleet job status` shows a queued job's place and estimated start, and who it waits on, in text and in --json", async () => {
  const { t, clock, holder, waiting } = queued();
  await t.runner.tick();
  const expectedEnd = clock.at + 12 * MIN;
  t.ledger.renew(holder, { expectedEnd });
  const fleet = BOXES.map((b: Box) => b.name);
  const reply = remote(["status", waiting], { store: t.store, ledger: t.ledger, known: () => fleet, now: () => clock.at });
  assert.equal(reply.code, 0, reply.stderr);
  const view = JSON.parse(reply.stdout);
  assert.deepEqual(view.queue, { place: 1, of: 1, estimatedStart: new Date(expectedEnd).toISOString(), estimateReason: null, waitingOn: [holderOf(holder)] });
  const text = renderView(viewJob({ request: requestOf(t.store, waiting), state: null, cancelled: false, beat: null, now: clock.at, queue: view.queue })).join("\n");
  assert.match(text, /^place: 1 of 1$/m);
  assert.match(text, new RegExp(`^estimated start: ${new Date(expectedEnd).toISOString()}$`, "m"));
  assert.match(text, new RegExp(`^waiting on: ${holderOf(holder).replace(/[.]/g, "\\.")}$`, "m"));
  await t.runner.settled();
  t.done();
});

test("an estimated start that cannot be worked out says it is unknown, and why", async () => {
  const { t, clock, waiting } = queued();
  await t.runner.tick();
  const view = JSON.parse(remote(["status", waiting], { store: t.store, ledger: t.ledger, known: () => [], now: () => clock.at }).stdout);
  assert.equal(view.queue.estimatedStart, null);
  assert.match(view.queue.estimateReason, /has no expected end/);
  const text = renderView(viewJob({ request: requestOf(t.store, waiting), state: null, cancelled: false, beat: null, now: clock.at, queue: view.queue })).join("\n");
  assert.match(text, /^estimated start: unknown \(fleet-jobs:fj-.* has no expected end\)$/m);
  await t.runner.settled();
  t.done();
});

test("a running job and a job that has ended show no queue", async () => {
  const { t, clock, holder } = queued();
  await t.runner.tick();
  const view = JSON.parse(remote(["status", holder], { store: t.store, ledger: t.ledger, known: () => [], now: () => clock.at }).stdout);
  assert.equal(view.queue, null);
  await t.runner.settled();
  t.done();
});

test("`fleet lease list` shows the live leases and the queue in order, each waiter with its place and estimated start", async () => {
  const { t, clock, holder, waiting } = queued();
  await t.runner.tick();
  const reply = remote(["lease-list"], { store: t.store, ledger: t.ledger, known: () => BOXES.map((b: Box) => b.name), now: () => clock.at });
  assert.equal(reply.code, 0, reply.stderr);
  const listing = JSON.parse(reply.stdout);
  assert.deepEqual(listing.leases.map((l: { id: string; boxes: string[]; kind: string }) => [l.id, l.boxes, l.kind]), [[holder, ["w2", "w3"], "capture"]]);
  assert.deepEqual(listing.queue.map((w: { id: string; place: number; of: number; waitingOn: string[] }) => [w.id, w.place, w.of, w.waitingOn]), [[waiting, 1, 1, [holderOf(holder)]]]);
  await t.runner.settled();
  t.done();
});

test("the mean capture time is taken over the last 20 completed captures, newest first, and is null before any", () => {
  const t = harness();
  assert.equal(meanCaptureMs(t.store), null);
  const id = t.submit({ kind: "count", count: 1 });
  const at = (s: number) => new Date(Date.UTC(2026, 9, 25, 9, 0, s)).toISOString();
  t.store.writeState(id, { version: 1, state: "done", boxes: ["w2"], readings: {}, dropped: [], notes: [], startedAt: at(0), finishedAt: at(99),
    captures: Array.from({ length: 25 }, (_, i) => ({ page: `p${i}`, pass: 1, file: `${i}.json`, box: "w2", status: "done" as const, startedAt: at(0), finishedAt: new Date(Date.UTC(2026, 9, 25, 9, 0, 0) + (i < 5 ? 100_000 : 10_000)).toISOString() })) });
  assert.equal(meanCaptureMs(t.store), 10_000, "the 5 oldest, slow captures are outside the last 20");
  const bad = t.submit({ kind: "count", count: 1 });
  t.store.writeState(bad, { version: 1, state: "done", boxes: ["w2"], readings: {}, dropped: [], notes: [], startedAt: at(0), finishedAt: at(99),
    captures: [{ page: "p", pass: 1, file: "x.json", box: "w2", status: "done", startedAt: "not a time", finishedAt: at(5) }] });
  assert.equal(meanCaptureMs(t.store), 10_000, "a capture with a timestamp that is not a time is left out, not turned into NaN");
  t.done();
});
