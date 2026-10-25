/**
 * THE PURE PARTS OF THE FLEET JOB SERVICE (A11-243): the plan, the page files, durations, the estimate, the claims, the manifest and the request check.
 * None reads a clock, a network or a disk, so each assertion names the one behaviour it holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryClaims } from "./claims.ts";
import { MAX_WAIT_MS, formatDuration, parseDuration } from "./duration.ts";
import { buildManifest } from "./manifest.ts";
import { parsePages, recordFile } from "./pages.ts";
import { passesRefusal, planCaptures, reassign } from "./plan.ts";
import { submitRefusal } from "./remote.ts";
import type { SubmitPayload } from "./remote.ts";
import { JOB_ID, newJobId } from "./store.ts";
import { STORE_VERSION } from "./types.ts";
import type { CaptureEntry, JobRequest, JobStateFile } from "./types.ts";
import { estimateFinish, viewJob } from "./view.ts";
import { parseBoxes } from "./cli.ts";

const pages = ["https://x.test/a", "https://x.test/b", "https://x.test/c"];

test("the passes of a page fall on different boxes, and every box gets the same share", () => {
  const plan = planCaptures(pages, ["w2", "w3", "w4"], 2);
  assert.equal(plan.length, 6);
  for (const page of pages) {
    const boxes = plan.filter((c) => c.page === page).map((c) => c.box);
    assert.equal(new Set(boxes).size, 2, `${page} must be on two boxes: ${boxes}`);
  }
  assert.deepEqual(["w2", "w3", "w4"].map((box) => plan.filter((c) => c.box === box).length), [2, 2, 2]);
  // capture_fleet.py's own spread: pass k of page i goes to box (i + k - 1) mod n
  assert.deepEqual(plan.map((c) => `${c.page.slice(-1)}.${c.pass}:${c.box}`), ["a.1:w2", "a.2:w3", "b.1:w3", "b.2:w4", "c.1:w4", "c.2:w2"]);
});

test("more passes than boxes is refused, in words, and as many passes as boxes is not", () => {
  assert.match(passesRefusal(2, 3) ?? "", /3 passes need 3 different boxes and only 2 are given/);
  assert.equal(passesRefusal(2, 2), null);
  assert.match(passesRefusal(1, 2) ?? "", /only 1 is given/);
});

test("a dropped box's pending captures go to the others, apart from the page's other pass where a box allows", () => {
  const captures = planCaptures(pages, ["w2", "w3", "w4"], 2);
  const moved = reassign(captures, "w2", ["w3", "w4"]);
  assert.deepEqual(moved.map((c) => `${c.page.slice(-1)}.${c.pass}`).sort(), ["a.1", "c.2"]);
  for (const page of pages) {
    const boxes = captures.filter((c) => c.page === page).map((c) => c.box);
    assert.equal(captures.filter((c) => c.box === "w2").length, 0);
    assert.equal(new Set(boxes).size, 2, `${page} stayed on two boxes: ${boxes}`);
  }
});

test("with one box left, the passes of a page share it rather than the job not finishing; with none left nothing moves", () => {
  const captures = planCaptures(["https://x.test/a"], ["w2", "w3"], 2);
  assert.equal(reassign(captures, "w2", ["w3"]).length, 1);
  assert.deepEqual(captures.map((c) => c.box), ["w3", "w3"]);
  assert.deepEqual(reassign(planCaptures(pages, ["w2"], 1), "w2", []), []);
});

test("a finished or running capture is never moved", () => {
  const captures = planCaptures(pages, ["w2", "w3"], 1);
  captures[0]!.status = "done";
  captures[2]!.status = "dispatched";
  assert.deepEqual(reassign(captures, "w2", ["w3"]), []);
  assert.deepEqual(captures.map((c) => c.box), ["w2", "w3", "w2"]);
});

test("a duration is a whole number and a unit; no wait is unbounded", () => {
  assert.deepEqual(parseDuration("90s"), { ms: 90_000 });
  assert.deepEqual(parseDuration("30m"), { ms: 1_800_000 });
  assert.deepEqual(parseDuration("2h"), { ms: 7_200_000 });
  assert.deepEqual(parseDuration("24h"), { ms: MAX_WAIT_MS });
  for (const bad of ["", "0", "0s", "30", "1.5h", "-5m", "forever", "infinity", "inf", "25h", "9999h", "1d", "5 m"]) {
    assert.ok("refusal" in parseDuration(bad), `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(formatDuration(90_000), "1m30s");
  assert.equal(formatDuration(3_660_000), "1h01m");
});

test("pages are read from a list, from capture_fleet.py's sample file, and from lines; a duplicate is kept once", () => {
  assert.deepEqual(parsePages('["https://x.test/a", {"url": "https://x.test/b"}, "https://x.test/a"]'), { pages: ["https://x.test/a", "https://x.test/b"] });
  assert.deepEqual(parsePages('{"sample": [{"url": "https://x.test/a", "why": "r"}]}'), { pages: ["https://x.test/a"] });
  assert.deepEqual(parsePages("https://x.test/a\n# a comment\n\nhttps://x.test/b # trailing\n"), { pages: ["https://x.test/a", "https://x.test/b"] });
  for (const bad of ["", "[]", "ftp://x.test/a", '["not a url"]', '{"sample": 3}', "[1]", "{broken"]) {
    assert.ok("refusal" in parsePages(bad), `${JSON.stringify(bad)} must be refused`);
  }
});

test("a record's file is safe in a path, and two pages that read alike do not share one", () => {
  const file = recordFile("https://x.test/a b/../c?d=1&e=2", 2);
  assert.match(file, /^[A-Za-z0-9._-]+\.p2\.json$/);
  assert.notEqual(recordFile("https://x.test/a?b=1", 1), recordFile("https://x.test/a/b=1", 1));
  assert.notEqual(recordFile("https://x.test/a", 1), recordFile("https://x.test/a", 2));
});

test("a job ID sorts by time and is safe in a path", () => {
  const id = newJobId(new Date("2026-10-25T08:58:15.789Z"), () => "a1b");
  assert.equal(id, "fj-20261025T085815Z-315a1b");
  assert.ok(JOB_ID.test(id));
  assert.ok(newJobId(new Date("2026-10-25T08:58:16Z")) > id);
  assert.ok(newJobId(new Date("2026-10-25T08:58:15.790Z")) > id, "two jobs in one second sort in the order they were submitted");
  assert.ok(newJobId(new Date("2026-10-25T08:58:15.099Z")) < id);
  for (const bad of ["../x", "fj-1", "fj-20261025T085815Z-A1B2C3", `${id}/../..`]) assert.ok(!JOB_ID.test(bad));
});

test("two jobs never hold one box: a claim is all of a job's boxes or none, and a release frees them", () => {
  const claims = memoryClaims();
  assert.deepEqual(claims.tryClaim("j1", ["w2", "w3"]), { claimed: true });
  assert.deepEqual(claims.tryClaim("j2", ["w3", "w4"]), { claimed: false, heldBy: { w3: "j1" } });
  assert.deepEqual(claims.held(), { w2: "j1", w3: "j1" }, "a refused claim takes nothing, not even the free box");
  assert.deepEqual(claims.tryClaim("j1", ["w2"]), { claimed: true }, "a job's own claim is not a conflict");
  claims.release("j1");
  assert.deepEqual(claims.tryClaim("j2", ["w3", "w4"]), { claimed: true });
});

const entry = (box: string, start: number | null, end: number | null, status: CaptureEntry["status"]): CaptureEntry => ({
  page: `https://x.test/${Math.random()}`, pass: 1, file: "f", box, status,
  ...(start === null ? {} : { startedAt: new Date(start).toISOString() }), ...(end === null ? {} : { finishedAt: new Date(end).toISOString() }),
});

test("the estimate is each box's remaining captures times that box's own mean, the latest box deciding; unknown before the first ends", () => {
  assert.equal(estimateFinish([entry("w2", null, null, "pending")], 1000), null);
  assert.equal(estimateFinish([entry("w2", 1000, null, "dispatched")], 1000), null);
  const captures = [
    entry("w2", 0, 10_000, "done"), entry("w2", 10_000, 20_000, "done"), entry("w2", null, null, "pending"), entry("w2", null, null, "pending"),
    entry("w3", 0, 40_000, "done"), entry("w3", null, null, "pending"),
  ];
  // w2: 2 left x 10 s = 20 s; w3: 1 left x 40 s = 40 s; the later one decides
  assert.equal(estimateFinish(captures, 100_000), 140_000);
  // a box that has finished nothing yet uses the job's mean (10, 10, 40 -> 20 s)
  assert.equal(estimateFinish([...captures, entry("w4", null, null, "pending")], 100_000), 140_000);
  assert.equal(estimateFinish([...captures.slice(0, 2), entry("w4", null, null, "pending"), entry("w4", null, null, "pending")], 0), 20_000);
});

const request = (over: Partial<JobRequest> = {}): JobRequest => ({
  version: STORE_VERSION, id: "fj-20261025T085815Z-a1b2c3", label: "A11-243", pages, boxes: { kind: "count", count: 2 }, passes: 1,
  body: { steps: 600 }, freeze: null, submittedBy: "agent@host", submittedAt: "2026-10-25T08:58:15.000Z", ...over });
const running = (captures: CaptureEntry[], over: Partial<JobStateFile> = {}): JobStateFile => ({
  version: STORE_VERSION, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], captures, notes: [], startedAt: "2026-10-25T09:00:00.000Z", ...over });

test("a job with a request and no state reads as queued, with its total from the request and no progress", () => {
  const view = viewJob({ request: request({ passes: 2 }), state: null, cancelled: false, beat: null, now: 0 });
  assert.equal(view.state, "queued");
  assert.equal(view.total, 6);
  assert.deepEqual([view.done, view.remaining, view.boxes], [0, 6, []]);
  assert.equal(view.estimate, "unknown until the first capture ends");
  assert.equal(view.results.location, "control:/var/lib/a11y-fleet-jobs/fj-20261025T085815Z-a1b2c3/results");
});

test("status shows progress per box, counts failed captures as ended, and names the service's last beat", () => {
  const captures = [entry("w2", 0, 5000, "done"), entry("w2", 5000, 6000, "failed"), entry("w2", null, null, "pending"), entry("w3", 0, 4000, "done")];
  captures[1]!.httpStatus = 500;
  captures[1]!.error = "fault on page";
  const beat = { pid: 1, commit: "abcdef0123456789", startedAt: "2026-10-25T09:00:00.000Z", heartbeatAt: new Date(100_000).toISOString() };
  const view = viewJob({ request: request(), state: running(captures), cancelled: false, beat, now: 110_000 });
  assert.deepEqual(view.boxes, [{ box: "w2", done: 2, failed: 1, total: 3 }, { box: "w3", done: 1, failed: 0, total: 1 }]);
  assert.deepEqual([view.total, view.done, view.failed, view.remaining], [4, 3, 1, 1]);
  assert.deepEqual(view.failedCaptures.map((f) => [f.box, f.httpStatus, f.error]), [["w2", 500, "fault on page"]]);
  assert.equal(view.service?.alive, true);
  assert.equal(viewJob({ request: request(), state: running(captures), cancelled: false, beat, now: 200_000 }).service?.alive, false, "a beat 100 s old is a service that is not running");
});

test("a finished job states no estimate, and the manifest names its pages, boxes with their builds, versions, times and capture files", () => {
  const readings = { w2: { code: "c2", environment: { windowsBuild: "26300.1", browserVersion: "156.0", screenReaderVersion: "2026.1" }, policy: null },
    w3: { code: "c3", environment: { windowsBuild: "26300.2", browserVersion: "155.0", screenReaderVersion: "2026.1" }, policy: null } };
  const captures = [{ ...entry("w2", 0, 5000, "done"), page: pages[0]!, file: "a.p1.json" }];
  const state = running(captures, { state: "done", readings, finishedAt: "2026-10-25T09:05:00.000Z" });
  assert.equal(viewJob({ request: request(), state, cancelled: false, beat: null, now: 0 }).estimate, "ended");
  const manifest = buildManifest({ request: request({ freeze: { commit: "f".repeat(40), namedAt: "2026-10-24T00:00:00Z", objects: { a: 1 } } }), state, pins: { pins: { worker: "0.13.13" } } });
  assert.deepEqual(manifest.pages, pages);
  assert.deepEqual([manifest.startedAt, manifest.finishedAt], ["2026-10-25T09:00:00.000Z", "2026-10-25T09:05:00.000Z"]);
  assert.deepEqual(manifest.boxes.map((b) => [b.name, b.workerCode, b.windowsBuild, b.edge, b.nvda]), [["w2", "c2", "26300.1", "156.0", "2026.1"], ["w3", "c3", "26300.2", "155.0", "2026.1"]]);
  assert.deepEqual(manifest.pins, { pins: { worker: "0.13.13" } });
  assert.deepEqual(manifest.freeze, { commit: "f".repeat(40), namedAt: "2026-10-24T00:00:00Z" });
  assert.equal(manifest.agreement.consistent, false, "two boxes on different Edge versions are recorded as not agreeing");
  assert.ok(manifest.agreement.mismatches.some((line) => /browserVersion/i.test(line)), manifest.agreement.mismatches.join("|"));
  assert.ok(manifest.agreement.reportedOnly.some((line) => /windowsBuild/i.test(line)), "a Windows build split is recorded too");
  assert.deepEqual(manifest.captures.map((c) => c.file), ["a.p1.json"]);
  assert.ok(!JSON.stringify(manifest).includes("127.0.0.1"), "boxes are named, never addressed");
});

const payload = (over: Partial<SubmitPayload> = {}): SubmitPayload => ({
  label: "A11-243", pages, boxes: { kind: "count", count: 2 }, passes: 2, body: { steps: 600 }, freeze: null, submittedBy: "a@h", ...over });
const NOW = Date.parse("2026-10-25T12:00:00Z");

test("a request is checked at submit: label, pages, passes, boxes and the body", () => {
  const check = (over: Partial<SubmitPayload>, known: string[] | null = null) => submitRefusal(payload(over), { now: NOW, known: known && (() => known) });
  assert.equal(check({}), null);
  assert.match(check({ label: "" }) ?? "", /--label is required/);
  assert.match(check({ label: "a b" }) ?? "", /--label is required/);
  assert.match(check({ pages: [] }) ?? "", /no pages/);
  assert.match(check({ passes: 0 }) ?? "", /--passes/);
  assert.match(check({ passes: 3 }) ?? "", /3 passes need 3 different boxes/);
  assert.match(check({ boxes: { kind: "count", count: 0 } }) ?? "", /--boxes/);
  assert.match(check({ boxes: { kind: "named", names: ["w2", "w2"] } }) ?? "", /twice/);
  assert.match(check({ boxes: { kind: "named", names: ["w2", "no way"] } }) ?? "", /not a worker name/);
  assert.match(check({ boxes: { kind: "named", names: ["w2", "w9"] } }, ["w2", "w3"]) ?? "", /not boxes in the inventory: w9/);
  assert.equal(check({ boxes: { kind: "named", names: ["w2", "w3"] } }, ["w2", "w3"]), null);
  assert.match(check({ boxes: { kind: "named", names: ["w2"] } }) ?? "", /1 is given/);
  assert.equal(check({ boxes: { kind: "ready" }, passes: 2 }), null, "`ready` is counted when the job starts");
  for (const field of ["url", "captureId", "async"]) assert.match(check({ body: { [field]: "x" } }) ?? "", new RegExp(`sets ${field}, which the service sets`));
});

test("a freeze reference named in the future is refused", () => {
  const freeze = (namedAt: string) => ({ commit: "f".repeat(40), namedAt });
  assert.equal(submitRefusal(payload({ freeze: freeze("2026-10-24T00:00:00Z") }), { now: NOW, known: null }), null);
  assert.match(submitRefusal(payload({ freeze: freeze("2026-10-26T00:00:00Z") }), { now: NOW, known: null }) ?? "", /named in the future/);
  assert.match(submitRefusal(payload({ freeze: freeze("yesterday") }), { now: NOW, known: null }) ?? "", /no commit and namedAt/);
});

test("--boxes is a number, `ready`, or names", () => {
  assert.deepEqual(parseBoxes("3"), { kind: "count", count: 3 });
  assert.deepEqual(parseBoxes("ready"), { kind: "ready" });
  assert.deepEqual(parseBoxes("a11y-worker-2, a11y-worker-3"), { kind: "named", names: ["a11y-worker-2", "a11y-worker-3"] });
  assert.ok("refusal" in parseBoxes("0"));
  assert.ok("refusal" in parseBoxes(","));
});
