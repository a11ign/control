/**
 * THE DAILY FREEZE WAITS FOR A LEASE (A11-244, step 2). A real ledger in a temp directory, an injected clock, and a fake `ansible-playbook` that records
 * which boxes it was started on and writes the record `freeze.yml` writes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseLedger } from "./ledger.ts";
import { batchRecordOf, mergeRecords, runDailyFreeze } from "./freeze-daily.ts";
import type { FreezeOutcome } from "./freeze-daily.ts";

const HOUR = 3_600_000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "freeze-daily-"));
  const clock = { at: Date.parse("2026-10-26T04:11:00Z") };
  const ledger = new LeaseLedger(join(dir, "ledger.json"), { now: () => clock.at });
  return { dir, clock, ledger, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A capture holding `boxes` for as long as the test says: its lease outlives any day-long wait unless it is released. */
const capture = (ledger: LeaseLedger, id: string, boxes: string[]) =>
  ledger.tryTake({ id, holder: `fleet-jobs:${id}`, kind: "capture", label: id, boxes, ttlMs: 48 * HOUR });

type Play = { boxes: string[]; during: Record<string, string[]> };

/** A fake `freeze.yml`: records the batch, notes who holds each box while it runs, and writes the record the play writes. */
function fakePlaybook(t: ReturnType<typeof setup>, { status = 0, record = (boxes: string[]) => ({ frozen: boxes, putBack: {}, unreachable: [], failed: [] }) as Record<string, unknown> | null }: {
  status?: number; record?: (boxes: string[]) => Record<string, unknown> | null } = {}) {
  const plays: Play[] = [];
  let running = 0;
  const run = async (boxes: string[], recordPath: string): Promise<number | null> => {
    running += 1;
    assert.equal(running, 1, "one play at a time");
    plays.push({ boxes: [...boxes], during: t.ledger.held() });
    const written = record(boxes);
    if (written) writeFileSync(recordPath, JSON.stringify({ checkedAt: new Date(t.clock.at).toISOString(), scope: boxes.join(","), ...written }));
    running -= 1;
    return status;
  };
  return { plays, run };
}

const drive = (t: ReturnType<typeof setup>, boxes: string[], run: (boxes: string[], recordPath: string) => Promise<number | null>, over: { sleep?: (ms: number) => Promise<void>; deadlineMs?: number } = {}): Promise<FreezeOutcome> =>
  runDailyFreeze({ ledger: t.ledger, boxes, runPlaybook: run, now: () => t.clock.at, heartbeat: () => () => {}, deadlineMs: over.deadlineMs ?? 6 * HOUR,
    sleep: over.sleep ?? (async (ms) => { t.clock.at += ms; }) });

test("the scheduled re-apply waits for a lease: a box a capture holds is frozen in a later batch, once that lease is released", async () => {
  const t = setup();
  const play = fakePlaybook(t);
  assert.equal(capture(t.ledger, "job-a", ["w2"]).taken, true);
  let sleeps = 0;
  const outcome = await drive(t, ["w1", "w2", "w3"], play.run, { sleep: async (ms) => {
    t.clock.at += ms;
    sleeps += 1;
    if (sleeps === 3) t.ledger.releaseAll("job-a");
  } });
  assert.deepEqual(play.plays.map((p) => p.boxes), [["w1", "w3"], ["w2"]], "w1 and w3 first; w2 only after the capture let it go");
  assert.ok(sleeps >= 3, "it waited, polling, while the capture held w2");
  assert.deepEqual(outcome.record.frozen, ["w1", "w2", "w3"]);
  assert.deepEqual(outcome.record.leased, {});
  assert.equal(outcome.exitCode, 0);
  const during = play.plays[0]!.during;
  assert.deepEqual(Object.keys(during).sort(), ["w1", "w2", "w3"], "while the first batch ran, w1 and w3 were held by the freeze and w2 by the capture");
  assert.deepEqual(during.w2, ["fleet-jobs:job-a"]);
  assert.match(during.w3![0]!, /^fleet-freeze:/);
  assert.match(play.plays[0]!.during.w1![0]!, /^fleet-freeze:/);
  assert.deepEqual(t.ledger.held(), {}, "every lease is let go at the end");
  assert.deepEqual(t.ledger.queued(), [], "and nothing is left in the queue");
  t.done();
});

test("no two plays ever target one box, and a box is not run twice", async () => {
  const t = setup();
  const play = fakePlaybook(t);
  capture(t.ledger, "job-a", ["w1"]);
  capture(t.ledger, "job-b", ["w3"]);
  let sleeps = 0;
  await drive(t, ["w1", "w2", "w3"], play.run, { sleep: async (ms) => {
    t.clock.at += ms;
    sleeps += 1;
    if (sleeps === 2) t.ledger.releaseAll("job-a");
    if (sleeps === 4) t.ledger.releaseAll("job-b");
  } });
  const targeted = play.plays.flatMap((p) => p.boxes);
  assert.deepEqual([...targeted].sort(), ["w1", "w2", "w3"]);
  assert.equal(new Set(targeted).size, targeted.length);
  t.done();
});

test("at the deadline a box still leased is named in `leased`, is not frozen, and the run exits non-zero", async () => {
  const t = setup();
  const play = fakePlaybook(t);
  capture(t.ledger, "job-a", ["w2"]);
  const outcome = await drive(t, ["w1", "w2", "w3"], play.run, { deadlineMs: HOUR });
  assert.deepEqual(play.plays.map((p) => p.boxes), [["w1", "w3"]], "w2 was never run");
  assert.deepEqual(outcome.record.frozen, ["w1", "w3"]);
  assert.deepEqual(outcome.record.leased, { w2: "fleet-jobs:job-a" });
  assert.equal(outcome.exitCode, 1);
  assert.ok(t.clock.at - Date.parse("2026-10-26T04:11:00Z") >= HOUR, "it waited out the whole bound, and no longer than the poll");
  assert.deepEqual(t.ledger.queued(), [], "the freeze's waiter does not outlive the run");
  assert.equal(t.ledger.leaseOf("job-a")?.holder, "fleet-jobs:job-a", "and the capture's lease is untouched");
  t.done();
});

test("the merged record has the shape freeze.yml writes, plus `leased`, and merges every batch's levers", async () => {
  const t = setup();
  const play = fakePlaybook(t, { record: (boxes) => ({ frozen: boxes.filter((b) => b !== "w3"), putBack: { w1: ["Edge updater"] }, unreachable: boxes.includes("w3") ? ["w3"] : [], failed: [] }) });
  const outcome = await drive(t, ["w1", "w2", "w3"], play.run);
  assert.deepEqual(Object.keys(outcome.record).sort(), ["checkedAt", "failed", "frozen", "leased", "putBack", "scope", "unreachable"]);
  assert.deepEqual(outcome.record.frozen, ["w1", "w2"]);
  assert.deepEqual(outcome.record.putBack, { w1: ["Edge updater"] });
  assert.deepEqual(outcome.record.unreachable, ["w3"]);
  assert.equal(outcome.record.scope, "the fleet");
  assert.match(outcome.record.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  t.done();
});

test("a play that fails, or that wrote no record, fails the run and leaves its boxes `failed`, never frozen", async () => {
  const failing = setup();
  const noRecord = fakePlaybook(failing, { status: 2, record: () => null });
  const outcome = await drive(failing, ["w1", "w2"], noRecord.run);
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(outcome.record.frozen, []);
  assert.deepEqual(outcome.record.failed, ["w1", "w2"]);
  assert.deepEqual(failing.ledger.held(), {}, "the leases are let go though the play failed");
  failing.done();

  const putBack = setup();
  const play = fakePlaybook(putBack, { status: 2 });
  assert.equal((await drive(putBack, ["w1"], play.run)).exitCode, 1, "freeze.yml exits non-zero when a lever had to be put back: the unit still fails on it");
  putBack.done();
});

test("a job queued before the run keeps its turn on a box; the freeze goes after it", async () => {
  const t = setup();
  const play = fakePlaybook(t);
  capture(t.ledger, "job-a", ["w2"]);
  t.ledger.enqueue({ id: "job-b", holder: "fleet-jobs:job-b", kind: "capture", label: "job-b", want: { named: ["w2"] }, enqueuedAt: t.clock.at - 60_000, ttlMs: 48 * HOUR });
  let sleeps = 0;
  const outcome = await drive(t, ["w2"], play.run, { sleep: async (ms) => {
    t.clock.at += ms;
    sleeps += 1;
    if (sleeps === 2) t.ledger.releaseAll("job-a");
    if (sleeps === 4) { assert.equal(t.ledger.take("job-b", ["w2"]).taken, true, "job-b was served first"); }
    if (sleeps === 6) t.ledger.releaseAll("job-b");
  } });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(play.plays.map((p) => p.boxes), [["w2"]]);
  assert.ok(sleeps >= 6, "the freeze waited for job-b as well");
  t.done();
});

test("a ledger nobody can read holds every box: nothing is frozen, every box is named, the run fails", async () => {
  const t = setup();
  const play = fakePlaybook(t);
  mkdirSync(t.dir, { recursive: true });
  writeFileSync(join(t.dir, "ledger.json"), "{ not json");
  const outcome = await drive(t, ["w1", "w2"], play.run, { deadlineMs: HOUR });
  assert.deepEqual(play.plays, []);
  assert.deepEqual(Object.keys(outcome.record.leased), ["w1", "w2"]);
  assert.match(outcome.record.leased.w1!, /unreadable/);
  assert.equal(outcome.exitCode, 1);
  t.done();
});

test("batchRecordOf reads the shape freeze.yml writes, and nothing else", () => {
  assert.deepEqual(batchRecordOf(JSON.stringify({ checkedAt: "x", frozen: ["w1"], putBack: { w1: ["a"] }, unreachable: [], failed: ["w2"] })),
    { frozen: ["w1"], putBack: { w1: ["a"] }, unreachable: [], failed: ["w2"] });
  for (const text of [null, "", "[]", "not json", JSON.stringify({ frozen: ["w1"] })]) assert.equal(batchRecordOf(text), null, String(text));
  assert.deepEqual(mergeRecords({ batches: [], leased: {}, checkedAt: "t" }).frozen, []);
});

test("a ledger that fails for good (its directory cannot be made) is not a quiet wait: the reason is logged and named in `leased`", async () => {
  const t = setup();
  writeFileSync(join(t.dir, "blocker"), "a file, not a directory");
  const broken = new LeaseLedger(join(t.dir, "blocker", "ledger.json"), { now: () => t.clock.at });
  const play = fakePlaybook(t);
  const lines: string[] = [];
  const outcome = await runDailyFreeze({ ledger: broken, boxes: ["w1"], runPlaybook: play.run, now: () => t.clock.at, heartbeat: () => () => {}, deadlineMs: HOUR,
    sleep: async (ms) => { t.clock.at += ms; }, log: (line) => lines.push(line) });
  assert.deepEqual(play.plays, []);
  assert.match(outcome.record.leased.w1!, /EEXIST|ENOTDIR|not a directory/i);
  assert.ok(lines.some((line) => /could not queue w1/.test(line)), lines.join("\n"));
  assert.equal(outcome.exitCode, 1);
  t.done();
});

test("a play that refuses before it freezes anything (the patch-running guard) is tried again later, and the boxes are frozen once it clears", async () => {
  const t = setup();
  let attempts = 0;
  const plays = fakePlaybook(t, { record: (boxes) => (++attempts === 1 ? null : { frozen: boxes, putBack: {}, unreachable: [], failed: [] }) });
  const lines: string[] = [];
  const outcome = await runDailyFreeze({ ledger: t.ledger, boxes: ["w1", "w2"], runPlaybook: plays.run, now: () => t.clock.at, heartbeat: () => () => {}, deadlineMs: 6 * HOUR,
    sleep: async (ms) => { t.clock.at += ms; }, log: (line) => lines.push(line) });
  assert.deepEqual(plays.plays.map((p) => p.boxes), [["w1", "w2"], ["w1", "w2"]], "the same boxes, tried again");
  assert.deepEqual(outcome.record.frozen, ["w1", "w2"]);
  assert.deepEqual(outcome.record.failed, [], "a clean refusal is not `did not hold on`");
  assert.equal(outcome.exitCode, 0);
  assert.ok(lines.some((line) => /wrote no record for w1, w2/.test(line)));
  assert.ok(t.clock.at - Date.parse("2026-10-26T04:11:00Z") >= 10 * 60_000, "and not sooner than the retry delay");
  assert.deepEqual(t.ledger.held(), {}, "no lease is held while it waits to try again");
  assert.deepEqual(t.ledger.queued(), [], "and the freeze does not keep a place in the queue it is not going to use");
  t.done();
});

test("a play that throws still lets its boxes go", async () => {
  const t = setup();
  await assert.rejects(runDailyFreeze({ ledger: t.ledger, boxes: ["w1"], runPlaybook: async () => { throw new Error("spawn failed"); }, now: () => t.clock.at,
    heartbeat: () => () => {}, sleep: async (ms) => { t.clock.at += ms; } }), /spawn failed/);
  assert.deepEqual(t.ledger.held(), {});
  t.done();
});
