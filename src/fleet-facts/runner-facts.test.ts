/**
 * A FACTS JOB IN THE SERVICE LOOP (A11-283): a Runner over a real store and lease ledger, with the facts read handed in (`readFacts`). These show how a facts
 * job books its boxes, what one box's failure does to the job, and that the play's `changed` count is asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticResolver } from "../fleet-jobs/fake-fleet.ts";
import { BOXES, harness, tick } from "../fleet-jobs/runner.fixture.ts";
import { Runner } from "../fleet-jobs/runner.ts";
import { JobStore } from "../fleet-jobs/store.ts";
import { meanCaptureMs } from "../fleet-jobs/queue-view.ts";
import { FACTS_PAGE, FACTS_STORE_VERSION, captureCount } from "../fleet-jobs/types.ts";
import type { Box, BoxRequest, JobRequest } from "../fleet-jobs/types.ts";
import { m720q, m720qFacts, prodesk } from "./facts.fixture.ts";
import type { FactsFile, FactsRecord } from "./types.ts";
import type { PlayRead } from "./play-result.ts";

const FACTS_REQUEST: Partial<JobRequest> = { version: FACTS_STORE_VERSION, kind: "facts", pages: [], passes: 1, body: {} };
const named = (...names: string[]): BoxRequest => ({ kind: "named", names });
const YESTERDAY_ENTRY = { readAt: "2026-10-24T09:00:00.000Z", stale: false, lastAttemptAt: "2026-10-24T09:00:00.000Z", lastJob: "fj-old", lastError: null, facts: m720qFacts() };

const statusOf = (store: JobStore, id: string, box: string): string | undefined => {
  const read = store.readState(id);
  return read?.ok ? read.value.captures.find((c) => c.box === box)?.status : undefined;
};

function facts(over: Partial<Parameters<typeof harness>[0]> & { read?: (box: Box) => Promise<PlayRead> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-facts-file-"));
  const factsFile = join(dir, "fleet-facts.json");
  const reads: string[] = [];
  const { read: custom, ...rest } = over;
  const read = custom ?? (async (box: Box): Promise<PlayRead> => { await tick(); return { changed: 0, output: box.name === "w4" ? prodesk() : m720q() }; });
  const t = harness({ factsFile, readFacts: async (box) => { reads.push(box.name); return read(box); }, ...rest });
  const file = (): FactsFile => JSON.parse(readFileSync(factsFile, "utf8")) as FactsFile;
  const record = (id: string, box: string): FactsRecord => JSON.parse(readFileSync(join(t.store.resultsDir(id), `${box}.facts.json`), "utf8")) as FactsRecord;
  return { ...t, reads, factsFile, file, record, done: () => { t.done(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a facts job reads every named box once, records each, writes the facts file and ends done", async () => {
  const t = facts();
  const id = t.submit(named("w2", "w3", "w4"), FACTS_REQUEST);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.equal(state.version, FACTS_STORE_VERSION);
  assert.deepEqual(state.captures.map((c) => [c.box, c.page, c.pass, c.file, c.status]), [
    ["w2", FACTS_PAGE, 1, "w2.facts.json", "done"], ["w3", FACTS_PAGE, 1, "w3.facts.json", "done"], ["w4", FACTS_PAGE, 1, "w4.facts.json", "done"]]);
  assert.deepEqual([...t.reads].sort(), ["w2", "w3", "w4"]);
  assert.deepEqual(Object.keys(t.file().boxes).sort(), ["w2", "w3", "w4"]);
  assert.equal(t.file().boxes.w2!.facts!.machineType, "10T8");
  assert.equal(t.file().boxes.w4!.facts!.machineType, "4KX37EA#ABD");
  assert.equal(t.file().boxes.w2!.stale, false);
  assert.equal(t.file().boxes.w2!.lastJob, id);
  assert.ok(t.file().boxes.w2!.readAt);
  const record = t.record(id, "w2");
  assert.deepEqual(Object.keys(record).sort(), ["changed", "facts", "readAt", "status", "worker"]);
  assert.equal(record.status, "done");
  assert.equal(record.worker, "w2");
  assert.equal(record.changed, 0);
  assert.ok(readdirSync(t.store.resultsDir(id)).includes("manifest.json"));
  t.done();
});

test("a facts job is not a capture: no page is sent to a worker, and no /health is read at its start", async () => {
  let healthRead = 0;
  let captured = 0;
  const t = facts({ health: async () => { healthRead++; return { busy: false }; }, capture: async () => { captured++; return { status: 200, json: {} }; } });
  const id = t.submit(named("w2"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  assert.equal([healthRead, captured].join(","), "0,0");
  t.done();
});

test("each box is leased while it is read and let go as its own read ends, not when the whole job does", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const leasedDuring: Record<string, string[]> = {};
  let id = "";
  const t = facts({
    read: async (box) => {
      leasedDuring[box.name] = [...(t.ledger.leaseOf(id)?.boxes ?? [])];
      if (box.name === "w3") await gate;
      return { changed: 0, output: m720q() };
    },
  });
  id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  const running = t.drain();
  for (let i = 0; i < 100 && statusOf(t.store, id, "w2") !== "done"; i++) await tick();
  assert.deepEqual(t.ledger.leaseOf(id)?.boxes, ["w3"], "w2 was let go as its read ended, while w3 is still being read");
  release();
  await running;
  assert.equal(t.ledger.leaseOf(id), null, "the job holds no box once it ends");
  assert.deepEqual(leasedDuring.w2!.sort(), ["w2", "w3"], "both boxes were booked before the first read began");
  t.done();
});

test("a box that fails to wake is a failed entry with the reason, the other boxes are read, and the job ends done", async () => {
  const t = facts({ read: async (box) => { if (box.name === "w3") throw new Error("w3 did not come up when woken: no answer"); return { changed: 0, output: m720q() }; } });
  const id = t.submit(named("w2", "w3", "w4"), FACTS_REQUEST);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.deepEqual(state.captures.map((c) => [c.box, c.status]), [["w2", "done"], ["w3", "failed"], ["w4", "done"]]);
  assert.equal(state.captures[1]!.error, "w3 did not come up when woken: no answer");
  assert.deepEqual(state.dropped, [{ box: "w3", reason: "w3 did not come up when woken: no answer" }]);
  assert.equal(t.file().boxes.w3!.facts, null);
  assert.equal(t.file().boxes.w3!.stale, true);
  assert.equal(t.file().boxes.w3!.lastError, "w3 did not come up when woken: no answer");
  assert.equal(t.record(id, "w3").status, "failed");
  assert.equal(t.ledger.leaseOf(id), null);
  t.done();
});

test("a box that answered yesterday and does not today keeps yesterday's facts and readAt in the file, stale", async () => {
  const t = facts({ read: async () => { throw new Error("unreachable"); } });
  writeFileSync(t.factsFile, JSON.stringify({ version: 1, boxes: { w3: YESTERDAY_ENTRY } }));
  const id = t.submit(named("w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "failed", "no box could be read, so the job itself fails");
  assert.match(t.state(id).reason!, /no box could be read: w3: unreachable/);
  const entry = t.file().boxes.w3!;
  assert.equal(entry.stale, true);
  assert.equal(entry.readAt, "2026-10-24T09:00:00.000Z");
  assert.deepEqual(entry.facts, m720qFacts());
  assert.equal(entry.lastError, "unreachable");
  assert.equal(entry.lastJob, id);
  t.done();
});

test("the box that did not answer is stale in the file while the job, with other boxes read, ends done", async () => {
  const t = facts({ read: async (box) => { if (box.name === "w3") throw new Error("unreachable"); return { changed: 0, output: m720q() }; } });
  writeFileSync(t.factsFile, JSON.stringify({ version: 1, boxes: { w3: YESTERDAY_ENTRY } }));
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  assert.equal(t.file().boxes.w3!.stale, true);
  assert.deepEqual(t.file().boxes.w3!.facts, m720qFacts());
  assert.equal(t.file().boxes.w2!.stale, false);
  t.done();
});

test("a play that changed anything fails that box's entry and does not update its facts", async () => {
  const t = facts({ read: async (box) => ({ changed: box.name === "w3" ? 2 : 0, output: m720q() }) });
  writeFileSync(t.factsFile, JSON.stringify({ version: 1, boxes: { w3: YESTERDAY_ENTRY } }));
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.equal(state.captures[1]!.status, "failed");
  assert.equal(state.captures[1]!.error, "the facts play changed 2 things on w3; it must change nothing");
  assert.equal(t.record(id, "w3").changed, 2);
  assert.equal(t.record(id, "w3").facts, undefined, "the facts of a play that changed something are not kept");
  const entry = t.file().boxes.w3!;
  assert.equal(entry.readAt, "2026-10-24T09:00:00.000Z", "its facts were not updated");
  assert.equal(entry.stale, true);
  assert.equal(entry.lastError, "the facts play changed 2 things on w3; it must change nothing");
  assert.equal(t.file().boxes.w2!.stale, false);
  t.done();
});

test("one thing changed reads as one thing", async () => {
  const t = facts({ read: async () => ({ changed: 1, output: m720q() }) });
  const id = t.submit(named("w2"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).captures[0]!.error, "the facts play changed 1 thing on w2; it must change nothing");
  t.done();
});

test("output that is not whole fails the box's entry, naming the field", async () => {
  const t = facts({ read: async (box) => { const raw = m720q(); if (box.name === "w3") delete raw.processors; return { changed: 0, output: raw }; } });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).captures[1]!.error, "the facts of w3 could not be read: processors is empty");
  assert.equal(t.file().boxes.w3!.facts, null);
  t.done();
});

test("a facts job is not subject to drift: a box the drift record lists is still read", async () => {
  const t = facts({ drift: () => ({ w2: "off the manifest: Edge 155.0 (wants 156.0)" }) });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  assert.deepEqual([...t.reads].sort(), ["w2", "w3"]);
  assert.equal(t.state(id).dropped.length, 0);
  t.done();
});

test("a facts job does not wait on a drift record that cannot be read", async () => {
  const t = facts({ drift: () => { throw new Error("runs/fleet-drift.json is not JSON"); } });
  const id = t.submit(named("w2"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("named boxes are located and not woken by the job: a resolver whose choose refuses is not asked", async () => {
  const boxes = { ...staticResolver(BOXES), choose: async () => { throw new Error("choose would wake the boxes"); } };
  const t = facts({ boxes });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a count of boxes is chosen from the free ones", async () => {
  const t = facts();
  const id = t.submit({ kind: "count", count: 2 }, FACTS_REQUEST);
  await t.drain();
  assert.deepEqual(t.state(id).boxes, ["w2", "w3"]);
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a facts job on a box another job holds waits for it, like a capture", async () => {
  const t = facts();
  t.ledger.tryTake({ id: "other", holder: "fleet-jobs:other", kind: "capture", label: "A11-1", boxes: ["w3"], ttlMs: 60_000 });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(existsSync(t.store.resultsDir(id)), false, "it has not started");
  assert.deepEqual(t.reads, []);
  t.ledger.releaseAll("other");
  await t.drain();
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a facts job whose every read fails ends failed, with each box's reason", async () => {
  const t = facts({ read: async (box) => { throw new Error(`${box.name} is unreachable`); } });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.equal(t.state(id).reason, "no box could be read: w2: w2 is unreachable; w3: w3 is unreachable");
  assert.equal(t.ledger.leaseOf(id), null);
  t.done();
});

test("a facts file that cannot be read is left alone: the record still lands in the results and the entry is failed, naming the file", async () => {
  const t = facts();
  writeFileSync(t.factsFile, "{ not json");
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(readFileSync(t.factsFile, "utf8"), "{ not json");
  const state = t.state(id);
  assert.equal(state.state, "failed", "every entry failed");
  assert.match(state.captures[0]!.error!, new RegExp(`^w2 was read but .*fleet-facts\\.json is unreadable.*, so it was left alone$`));
  assert.equal(t.record(id, "w2").facts?.machineType, "10T8", "the read itself is in the job's results");
  assert.equal(t.record(id, "w2").status, "failed");
  t.done();
});

test("a store that only reads versions 1 and 2 fails a facts job by name and never runs it as a page job", async () => {
  const t = facts();
  const id = t.submit(named("w2"), FACTS_REQUEST);
  const older = new Runner({ ...t.deps, store: new JobStore(t.dir, { accepts: [1, 2] }) });
  await older.tick();
  await older.settled();
  const state = t.state(id);
  assert.equal(state.state, "failed");
  assert.match(state.reason!, /request\.json is store version 3, and this service reads version 1 and 2/);
  assert.deepEqual(t.reads, [], "nothing was read");
  t.done();
});

test("a facts job running at a restart is resumed: the read it had sent is made again, and a box gone from the inventory fails its own entry", async () => {
  const t = facts({ boxes: staticResolver(BOXES.filter((box) => box.name !== "w3")) });
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  t.store.writeState(id, { version: FACTS_STORE_VERSION, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], notes: [], startedAt: new Date().toISOString(),
    captures: [
      { page: FACTS_PAGE, pass: 1, file: "w2.facts.json", box: "w2", status: "dispatched", startedAt: new Date().toISOString() },
      { page: FACTS_PAGE, pass: 1, file: "w3.facts.json", box: "w3", status: "pending" }] });
  t.ledger.tryTake({ id, holder: `fleet-jobs:${id}`, kind: "capture", label: "A11-243", boxes: ["w2", "w3"], ttlMs: 60_000 });
  await t.drain();
  const state = t.state(id);
  assert.deepEqual(state.captures.map((c) => [c.box, c.status]), [["w2", "done"], ["w3", "failed"]]);
  assert.match(state.captures[1]!.error!, /^w3 left the fleet: it is no longer in the inventory$/);
  assert.deepEqual(t.reads, ["w2"], "w3's read was not moved to another box");
  t.done();
});

test("a facts read is not a capture: it does not move the capture estimate, and a queued facts job counts one read per box", async () => {
  const t = facts();
  const id = t.submit(named("w2", "w3"), FACTS_REQUEST);
  await t.drain();
  assert.equal(meanCaptureMs(t.store), null, "the two finished reads are not captures, so no capture has completed");
  const mean = t.submit({ kind: "count", count: 1 });
  await t.drain();
  assert.ok(meanCaptureMs(t.store) !== null, "positive control: a finished capture counts");
  assert.equal(captureCount({ pages: [], passes: 1, ...FACTS_REQUEST, boxes: named("w2", "w3") }), 2);
  assert.equal(captureCount({ pages: [], passes: 1, ...FACTS_REQUEST, boxes: { kind: "count", count: 3 } }), 3);
  assert.ok(id && mean);
  t.done();
});

test("the manifest of a facts job says so, at version 3, and names the reads as its captures", async () => {
  const t = facts();
  const id = t.submit(named("w2"), FACTS_REQUEST);
  await t.drain();
  const manifest = JSON.parse(readFileSync(join(t.store.resultsDir(id), "manifest.json"), "utf8"));
  assert.equal(manifest.kind, "facts");
  assert.equal(manifest.version, 3);
  assert.equal(manifest.state, "done");
  assert.deepEqual(manifest.captures.map((c: { page: string; file: string; status: string }) => [c.page, c.file, c.status]), [[FACTS_PAGE, "w2.facts.json", "done"]]);
  t.done();
});
