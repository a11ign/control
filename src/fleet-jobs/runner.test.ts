/**
 * THE SERVICE LOOP, IN PROCESS (A11-243): a Runner over a real store in a temp directory, with the capture and the health read handed in. These show
 * what a job does; `service.test.ts` shows it across a real process, a kill and a restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryClaims } from "./claims.ts";
import { staticResolver } from "./fake-fleet.ts";
import { RE_CAPTURED, Runner } from "./runner.ts";
import type { CaptureResult, RunnerDeps } from "./runner.ts";
import { JobStore, newJobId } from "./store.ts";
import { STORE_VERSION } from "./types.ts";
import type { Box, BoxRequest, JobRequest, JobStateFile } from "./types.ts";

const BOXES: Box[] = ["w2", "w3", "w4"].map((name) => ({ name, url: `http://127.0.0.1:1/${name}` }));
const PAGES = ["https://x.test/a", "https://x.test/b", "https://x.test/c", "https://x.test/d"];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(over: Partial<RunnerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-jobs-"));
  const store = new JobStore(dir);
  const log: string[] = [];
  const asked: { box: string; page: string }[] = [];
  const holding = new Map<string, number>();
  const peak = new Map<string, number>();
  const capture = async (box: Box, body: Record<string, unknown>): Promise<CaptureResult> => {
    holding.set(box.name, (holding.get(box.name) ?? 0) + 1);
    peak.set(box.name, Math.max(peak.get(box.name) ?? 0, holding.get(box.name)!));
    asked.push({ box: box.name, page: body.url as string });
    await tick();
    holding.set(box.name, holding.get(box.name)! - 1);
    return { status: 200, json: { transcript: [body.url] } };
  };
  const deps: RunnerDeps = {
    store, claims: memoryClaims(), boxes: staticResolver(BOXES), capture, health: async () => ({ busy: false, code: "c", environment: {}, policy: {} }),
    pins: () => ({ pins: {} }), log: (line) => log.push(line), retryQueuedMs: 0, busyPollMs: 1, busyWaitMs: 5, ...over };
  const runner = new Runner(deps);
  let submitted = 0;
  const submit = (boxes: BoxRequest = { kind: "count", count: 2 }, over: Partial<JobRequest> = {}): string => {
    // one second apart in the ID's own clock, so the jobs sort in the order they were submitted
    const id = newJobId(new Date(Date.UTC(2026, 9, 25, 9, 0, submitted)), () => (submitted++).toString(16).padStart(3, "0"));
    store.writeRequest({ version: STORE_VERSION, id, label: "A11-243", pages: PAGES, boxes, passes: 1, body: { steps: 600 }, freeze: null, submittedBy: "t@h",
      submittedAt: new Date().toISOString(), ...over });
    return id;
  };
  const state = (id: string): JobStateFile => {
    const read = store.readState(id);
    assert.ok(read?.ok, `no readable state for ${id}`);
    return (read as { ok: true; value: JobStateFile }).value;
  };
  const drain = async (runner_: Runner = runner) => { await runner_.tick(); await runner_.settled(); };
  return { dir, store, runner, deps, log, asked, peak, submit, state, drain, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a job runs every page on every pass to a record, then is done with a manifest", async () => {
  const t = harness();
  const id = t.submit({ kind: "count", count: 2 }, { passes: 2 });
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.equal(state.captures.length, 8);
  assert.ok(state.captures.every((c) => c.status === "done" && c.httpStatus === 200));
  const files = readdirSync(t.store.resultsDir(id)).sort();
  assert.equal(files.length, 9, "eight records and the manifest");
  assert.ok(files.includes("manifest.json"));
  const record = JSON.parse(readFileSync(join(t.store.resultsDir(id), state.captures[0]!.file), "utf8"));
  assert.deepEqual(Object.keys(record).sort(), ["capture", "capturedAt", "status", "worker"], "fleet_capture.mjs's shape");
  assert.equal(record.worker, "w2");
  const manifest = JSON.parse(readFileSync(join(t.store.resultsDir(id), "manifest.json"), "utf8"));
  assert.equal(manifest.state, "done");
  assert.ok(manifest.finishedAt && manifest.startedAt);
  assert.equal(manifest.captures.length, 8);
  t.done();
});

test("the two passes of a page are captured on two different boxes", async () => {
  const t = harness();
  const id = t.submit({ kind: "count", count: 3 }, { passes: 2 });
  await t.drain();
  for (const page of PAGES) {
    const boxes = t.state(id).captures.filter((c) => c.page === page).map((c) => c.box);
    assert.equal(new Set(boxes).size, 2, `${page}: ${boxes}`);
  }
  t.done();
});

test("a capture that fails is a record and the job goes on to done", async () => {
  const t = harness({ capture: async (box, body) => ({ status: body.url === PAGES[1] ? 400 : 200, json: body.url === PAGES[1] ? { error: "page refused" } : {} }) });
  const id = t.submit({ kind: "count", count: 2 });
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.deepEqual(state.captures.map((c) => c.status), ["done", "failed", "done", "done"]);
  assert.equal(state.captures[1]!.error, "page refused");
  const record = JSON.parse(readFileSync(join(t.store.resultsDir(id), state.captures[1]!.file), "utf8"));
  assert.equal(record.status, 400, "the failure is in the record, as fleet_capture.mjs writes it");
  assert.equal(state.dropped.length, 0, "a page that errors is the page's, not the box's");
  t.done();
});

test("a connection that fails is a record naming the worker and never its address", async () => {
  const t = harness({ capture: async (box) => { throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:1 (${box.url})`), { code: "ECONNREFUSED" }); } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.drain();
  const record = JSON.parse(readFileSync(join(t.store.resultsDir(id), t.state(id).captures[0]!.file), "utf8"));
  assert.equal(record.status, 0);
  assert.match(record.capture.error, /^w2: connect ECONNREFUSED w2:1/);
  assert.ok(!JSON.stringify(record).includes("127.0.0.1"));
  t.done();
});

test("a box that fails three captures in a row is dropped, and its pages move to the others", async () => {
  const t = harness({ capture: async (box, body) => box.name === "w2" ? { status: 500, json: { error: "worker wedged" } } : { status: 200, json: {} } });
  const id = t.submit({ kind: "count", count: 2 }, { pages: [...PAGES, "https://x.test/e", "https://x.test/f", "https://x.test/g", "https://x.test/h"] });
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done", state.reason ?? "");
  assert.equal(state.dropped.length, 1);
  assert.equal(state.dropped[0]!.box, "w2");
  assert.match(state.dropped[0]!.reason, /3 captures in a row failed on it; the last: worker wedged/);
  assert.equal(state.captures.filter((c) => c.box === "w2").length, 3, "three pages ran on it, then it was dropped");
  assert.ok(state.captures.filter((c) => c.box === "w3").length >= 5, "the rest moved to w3");
  assert.ok(state.captures.every((c) => c.status === "done" || c.status === "failed"), "every page ended");
  t.done();
});

test("a success between faults resets the count", async () => {
  let n = 0;
  const t = harness({ capture: async () => ({ status: ++n % 3 === 0 ? 200 : 500, json: { error: "x" } }) });
  const id = t.submit({ kind: "count", count: 1 }, { pages: [...PAGES, "https://x.test/e", "https://x.test/f"] });
  await t.drain();
  assert.deepEqual(t.state(id).dropped, []);
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("a job with no box left fails, naming each box dropped and why", async () => {
  const t = harness({ capture: async () => ({ status: 503, json: { error: "down" } }) });
  const id = t.submit({ kind: "count", count: 2 }, { pages: [...PAGES, "https://x.test/e", "https://x.test/f", "https://x.test/g", "https://x.test/h"] });
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "failed");
  assert.match(state.reason ?? "", /no box was left to capture \d+ pages/);
  assert.match(state.reason ?? "", /w2: 3 captures in a row failed on it; the last: down/);
  assert.match(state.reason ?? "", /w3: 3 captures in a row failed/);
  assert.equal(JSON.parse(readFileSync(join(t.store.resultsDir(id), "manifest.json"), "utf8")).state, "failed");
  t.done();
});

test("more passes than boxes fails the job at start, in words, and writes a state", async () => {
  const t = harness();
  const id = t.submit({ kind: "ready" }, { passes: 4 });
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /4 passes need 4 different boxes and only 3 are given/);
  t.done();
});

test("a cancelled job stops sending pages; the capture already on a box ends and is kept", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const t = harness({ capture: async (box, body) => { started.push(body.url as string); await gate; return { status: 200, json: {} }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await tick();
  assert.equal(started.length, 2, "one capture in flight on each box");
  t.store.markCancelled(id, new Date().toISOString());
  release();
  await t.runner.settled();
  const state = t.state(id);
  assert.equal(state.state, "cancelled");
  assert.deepEqual(state.captures.map((c) => c.status), ["done", "done", "pending", "pending"], "the two in flight ended and are kept; nothing else was sent");
  assert.equal(started.length, 2);
  assert.equal(readdirSync(t.store.resultsDir(id)).filter((f) => f !== "manifest.json").length, 2);
  assert.match(state.reason ?? "", /cancelled/);
  t.done();
});

test("a queued job that is cancelled never starts, and says so", async () => {
  const t = harness();
  const id = t.submit();
  t.store.markCancelled(id, new Date().toISOString());
  await t.drain();
  assert.equal(t.state(id).state, "cancelled");
  assert.deepEqual(t.asked, []);
  t.done();
});

test("two jobs never run on the same box at once: the second waits until the first ends, then runs", async () => {
  const t = harness();
  const first = t.submit({ kind: "named", names: ["w2", "w3"] });
  const second = t.submit({ kind: "named", names: ["w3", "w4"] });
  await t.runner.tick();
  assert.equal(t.store.readState(second), null, "the second is still queued while the first holds w3");
  assert.equal(t.state(first).state, "running");
  await t.runner.settled();
  await t.runner.tick();
  await t.runner.settled();
  assert.equal(t.state(first).state, "done");
  assert.equal(t.state(second).state, "done");
  assert.ok([...t.peak.values()].every((n) => n === 1), `no box held two captures at once: ${[...t.peak]}`);
  const lastOfFirst = Math.max(...t.state(first).captures.map((c) => Date.parse(c.finishedAt!)));
  const firstOfSecond = Math.min(...t.state(second).captures.map((c) => Date.parse(c.startedAt!)));
  assert.ok(firstOfSecond >= lastOfFirst, "the second began after the first ended");
  t.done();
});

test("a job of `ready` takes the boxes no other job holds", async () => {
  const t = harness();
  const first = t.submit({ kind: "named", names: ["w2"] });
  const second = t.submit({ kind: "ready" });
  await t.runner.tick();
  assert.deepEqual(t.state(second).boxes, ["w3", "w4"]);
  await t.runner.settled();
  assert.equal(t.state(first).state, "done");
  t.done();
});

test("a counted job that cannot have its count waits while another job holds boxes, and starts when it has them", async () => {
  const t = harness();
  const first = t.submit({ kind: "count", count: 2 });
  const second = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  assert.equal(t.store.readState(second), null, "only one box is free, and two were asked for");
  await t.runner.settled();
  await t.drain();
  assert.equal(t.state(first).state, "done");
  assert.equal(t.state(second).state, "done");
  assert.equal(t.state(second).boxes.length, 2);
  t.done();
});

test("an unreadable request.json fails the job with the reason; it is not skipped", async () => {
  const t = harness();
  const id = newJobId();
  mkdirSync(join(t.dir, id));
  writeFileSync(join(t.dir, id, "request.json"), "{ not json");
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /request\.json is unreadable/);
  t.done();
});

test("a file of a version the service does not know fails the job and names the version", async () => {
  const t = harness();
  const id = t.submit();
  const path = join(t.dir, id, "request.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: 7 }));
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /request\.json is store version 7, and this service reads version 1/);
  t.done();
});

test("an unreadable state.json is moved aside and the job fails with the reason", async () => {
  const t = harness();
  const id = t.submit();
  writeFileSync(join(t.dir, id, "state.json"), JSON.stringify({ version: 2, state: "running" }));
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /state\.json is store version 2/);
  assert.ok(readFileSync(join(t.dir, id, "state.unreadable.json"), "utf8").includes('"version":2'), "the file of the unknown version is kept");
  t.done();
});

/** A job as a service killed mid-capture leaves it: `a` and `b` have records, `c` was sent, `d` was not. */
function interrupted(t: ReturnType<typeof harness>): string {
  const id = t.submit({ kind: "count", count: 2 });
  const captures = PAGES.map((page, i) => ({ page, pass: 1, file: `${"abcd"[i]}.p1.json`, box: i % 2 ? "w3" : "w2",
    status: (["done", "done", "dispatched", "pending"] as const)[i]!, startedAt: new Date(1000 * i).toISOString() }));
  for (const c of captures.slice(0, 2)) {
    t.store.writeRecord(id, c.file, { capturedAt: "2026-10-25T09:00:00.000Z", worker: c.box, status: 200, capture: { before: "the restart" } });
  }
  t.store.writeState(id, { version: STORE_VERSION, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], captures, notes: [], startedAt: "2026-10-25T09:00:00.000Z" });
  return id;
}

test("a job running at a restart is resumed: its records are kept, the capture that was sent is taken again and says so", async () => {
  const t = harness();
  const id = interrupted(t);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.deepEqual(t.asked.map((a) => a.page).sort(), [PAGES[2], PAGES[3]], "the two finished pages are not captured again");
  assert.deepEqual(state.captures.map((c) => c.note), [undefined, undefined, RE_CAPTURED, undefined]);
  const kept = JSON.parse(readFileSync(join(t.store.resultsDir(id), "a.p1.json"), "utf8"));
  assert.deepEqual(kept.capture, { before: "the restart" });
  const retaken = JSON.parse(readFileSync(join(t.store.resultsDir(id), "c.p1.json"), "utf8"));
  assert.equal(retaken.note, RE_CAPTURED);
  assert.match(state.notes.join("\n"), /resumed after a service restart/);
  t.done();
});

test("the re-capture waits for the box to stop being busy with the capture the dead service sent it", async () => {
  let polls = 0;
  const t = harness({ health: async () => ({ busy: ++polls < 4, code: "c" }), busyWaitMs: 10_000 });
  const id = interrupted(t);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  assert.ok(polls >= 4, `the box was asked ${polls} times`);
  t.done();
});

test("a box that is still busy after the wait gets the capture anyway, and the record says so", async () => {
  const t = harness({ health: async () => ({ busy: true }), busyWaitMs: 5 });
  const id = interrupted(t);
  await t.drain();
  assert.match(t.state(id).captures[2]!.note ?? "", /still reported busy/);
  t.done();
});

test("a resumed job whose box has left the inventory drops it and finishes on the others", async () => {
  const t = harness({ boxes: staticResolver(BOXES.filter((b) => b.name !== "w3")) });
  const id = interrupted(t);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.deepEqual(state.dropped.map((d) => d.box), ["w3"]);
  assert.match(state.dropped[0]!.reason, /no longer in the inventory/);
  assert.equal(state.captures.filter((c) => c.status === "pending").length, 0);
  t.done();
});

test("a graceful stop lets the captures in flight end and be recorded, and the next start re-captures nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = harness({ capture: async (box, body) => { await gate; return { status: 200, json: { page: body.url } }; } });
  const id = t.submit({ kind: "count", count: 2 });
  await t.runner.tick();
  await tick();
  const stopped = t.runner.stop();
  release();
  await stopped;
  const state = t.state(id);
  assert.equal(state.state, "running", "a stopped service leaves the job running, to be resumed");
  assert.deepEqual(state.captures.map((c) => c.status), ["done", "done", "pending", "pending"], "nothing is left dispatched");
  const resent: string[] = [];
  const second = harness({ store: t.store, capture: async (box, body) => { resent.push(body.url as string); return { status: 200, json: { page: body.url } }; } });
  await second.drain();
  assert.equal(t.state(id).state, "done");
  assert.ok(t.state(id).captures.every((c) => c.note === undefined), "no capture was taken again");
  assert.deepEqual(resent.sort(), [PAGES[2], PAGES[3]], "only the two pages that were never sent");
  t.done();
});

test("a store that cannot write a record fails the job with the reason, after the captures in flight have ended, and frees its boxes", async () => {
  const t = harness();
  const real = t.store.writeRecord.bind(t.store);
  let writes = 0;
  t.store.writeRecord = (id, file, record) => { if (++writes === 1) throw new Error("ENOSPC: no space left on device"); real(id, file, record); };
  const id = t.submit({ kind: "count", count: 2 });
  await t.drain();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /internal error: .*ENOSPC/);
  assert.deepEqual(t.deps.claims.held(), {}, "the job let go of its boxes");
  assert.equal(t.state(id).captures.filter((c) => c.status === "done").length, 1, "the other box's capture in flight ended and is recorded before the job gave up");
  t.done();
});
