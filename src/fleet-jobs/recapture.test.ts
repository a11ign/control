/**
 * CASES, GROUPS AND RE-CAPTURE, IN THE RUNNER AND THE CLI (A11-263): a good/bad pair on one box, a body of its own for every case, a re-capture of a
 * case after a failed evidence check on the box its pair was taken on, and the refusals in words. The runner is the real one over a real store and lease
 * ledger (`runner.fixture.ts`); the CLI is the real `main` with a route to `remote.ts` on this machine (`cli.fixture.ts`).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureTolerantly } from "@a11ign/screenreader-fleet/capture-client";
import { main, realDeps } from "./cli.ts";
import type { Transport } from "./cli.ts";
import { fakeWorker, staticResolver } from "./fake-fleet.ts";
import { remote } from "./remote.ts";
import type { RemoteResult } from "./remote.ts";
import { BOXES, PAGES, harness, tick } from "./runner.fixture.ts";
import { Runner, SKIPPED } from "./runner.ts";
import type { CaptureResult } from "./runner.ts";
import { JobStore } from "./store.ts";
import type { Box, CaseSpec, GroupSpec, JobRequest } from "./types.ts";

type Harness = ReturnType<typeof harness>;
const cleanups: (() => void)[] = [];
after(() => { for (const cleanup of cleanups) cleanup(); });

const pair = (name: string, extra: Partial<CaseSpec> = {}): CaseSpec[] => ["good", "bad"].map((variant) => ({
  id: `${name}.${variant}`, url: `https://pages.test/${name}/${variant}.html`, body: { task: `${name} ${variant}`, probeTables: variant === "bad" }, group: name, ...extra }));

/** A case job as `submit` writes it: no pages, one pass, an empty body, version 2. */
const caseJob = (t: Harness, cases: CaseSpec[], groups: Record<string, GroupSpec> = {}, boxes: JobRequest["boxes"] = { kind: "count", count: 3 }): string =>
  t.submit(boxes, { version: 2, pages: [], cases, groups });

/** A heartbeat the remote half reads as a service that is running. */
const beat = (store: JobStore): void => writeFileSync(store.servicePath(), JSON.stringify({ pid: 1, commit: "t", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));

const recaptureRemote = (t: Harness, source: string, cases: string[], over: { known?: () => string[] } = {}): RemoteResult => {
  beat(t.store);
  return remote(["recapture"], { store: t.store, known: () => BOXES.map((b) => b.name), ...over, stdin: () => JSON.stringify({ source, cases, label: "A11-263", submittedBy: "t@h" }) });
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const manifestOf = (t: Harness, id: string) => readJson(join(t.store.resultsDir(id), "manifest.json"));

/** A capture that records what each box was asked, in order, with the body exactly as the runner handed it over, and the most it ever held at once. */
function recording(): { asked: { box: string; body: Record<string, unknown> }[]; peak: Map<string, number>; capture: (box: Box, body: Record<string, unknown>) => Promise<CaptureResult> } {
  const asked: { box: string; body: Record<string, unknown> }[] = [];
  const holding = new Map<string, number>();
  const peak = new Map<string, number>();
  return { asked, peak, capture: async (box, body) => {
    holding.set(box.name, (holding.get(box.name) ?? 0) + 1);
    peak.set(box.name, Math.max(peak.get(box.name) ?? 0, holding.get(box.name)!));
    asked.push({ box: box.name, body });
    await tick();
    holding.set(box.name, holding.get(box.name)! - 1);
    return { status: 200, json: { title: body.url } };
  } };
}

test("a pair is captured on ONE box, good before bad, whichever boxes the job has", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture });
  const id = caseJob(t, [...pair("form-error-silent"), ...pair("table-header")]);
  await t.drain();
  assert.equal(t.state(id).state, "done");
  for (const group of ["form-error-silent", "table-header"]) {
    const mine = seen.asked.filter((a) => (a.body.task as string).startsWith(group));
    assert.deepEqual(mine.map((a) => (a.body.task as string).split(" ")[1]), ["good", "bad"], `${group}: good first, then bad`);
    assert.equal(new Set(mine.map((a) => a.box)).size, 1, `${group} was on one box: ${mine.map((a) => a.box)}`);
  }
  assert.notEqual(seen.asked.find((a) => String(a.body.task).startsWith("form"))!.box, seen.asked.find((a) => String(a.body.task).startsWith("table"))!.box, "the two groups spread across the boxes");
  assert.deepEqual([...seen.peak.values()], [1, 1], "a box did one capture at a time");
  t.done();
});

test("a group's cases are captured one after another on its box, and a box with no group left is released at once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const log: string[] = [];
  const t = harness({ capture: async (box, body) => { log.push(`${box.name} start ${body.task}`); if (body.task === "a good") await gate; log.push(`${box.name} end ${body.task}`); return { status: 200, json: {} }; } });
  const id = caseJob(t, [...pair("a"), ...pair("b")], {}, { kind: "count", count: 2 });
  await t.runner.tick();
  await tick(); await tick();
  assert.deepEqual(log.filter((l) => l.includes(" a ")), ["w2 start a good"], "a.bad does not start while a.good is on the box");
  await t.ledger.live();
  assert.deepEqual(Object.keys(t.ledger.held()), ["w2"], "w3 finished its whole group and was let go while w2 goes on");
  release();
  await t.runner.settled();
  assert.deepEqual(log.filter((l) => l.includes(" a ")), ["w2 start a good", "w2 end a good", "w2 start a bad", "w2 end a bad"]);
  assert.equal(t.state(id).state, "done");
  t.done();
});

test("each case is sent its own body exactly, plus its URL, and nothing from the page job's defaults", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture });
  caseJob(t, pair("a"), {}, { kind: "count", count: 1 });
  await t.drain();
  assert.deepEqual(seen.asked.map((a) => a.body), [
    { task: "a good", probeTables: false, url: "https://pages.test/a/good.html" },
    { task: "a bad", probeTables: true, url: "https://pages.test/a/bad.html" },
  ]);
  t.done();
});

test("a worker is asked with exactly the case's body over HTTP, through the real capture client", async () => {
  const workers = await Promise.all(["w2", "w3"].map((name) => fakeWorker(name)));
  cleanups.push(() => { void Promise.all(workers.map((w) => w.close())); });
  const t = harness({ boxes: staticResolver(workers), capture: (box, body) => captureTolerantly({ worker: box.url, body }) });
  const cases: CaseSpec[] = [
    { id: "one", url: "https://pages.test/one", body: { steps: 80, probeForms: true } },
    { id: "two", url: "https://pages.test/two", body: { probeNavigation: false, reuseScreenReader: true } },
  ];
  const id = caseJob(t, cases, {}, { kind: "count", count: 2 });
  await t.drain();
  assert.equal(t.state(id).state, "done", t.state(id).reason);
  assert.deepEqual(workers[0]!.bodies, [{ steps: 80, probeForms: true, url: "https://pages.test/one" }]);
  assert.deepEqual(workers[1]!.bodies, [{ probeNavigation: false, reuseScreenReader: true, url: "https://pages.test/two" }]);
  t.done();
});

test("the manifest of a case job names its cases, their groups and attempts, each box's whole environment, and each capture's case", async () => {
  const t = harness({ health: async () => ({ busy: false, code: "c", environment: { screenReaderVersion: "2026.1", windowsBuild: "26300.1", nvdaAddons: ["x"] }, policy: {} }) });
  const id = caseJob(t, [...pair("a"), { id: "solo", url: "https://pages.test/solo", body: {} }], {}, { kind: "count", count: 2 });
  await t.drain();
  const manifest = manifestOf(t, id);
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.cases.map((c: { id: string; group: string; attempt: number }) => [c.id, c.group, c.attempt]), [["a.good", "a", 1], ["a.bad", "a", 1], ["solo", "solo", 1]]);
  assert.deepEqual(manifest.cases[0].body, { task: "a good", probeTables: false });
  assert.deepEqual(manifest.boxes[0].environment, { screenReaderVersion: "2026.1", windowsBuild: "26300.1", nvdaAddons: ["x"] });
  assert.equal(manifest.boxes[0].nvda, "2026.1", "the fields it names today are kept beside it");
  assert.deepEqual(manifest.captures.map((c: { case: string; group: string; attempt: number; file: string }) => [c.case, c.group, c.attempt, c.file]),
    [["a.good", "a", 1, "a.good.a1.json"], ["a.bad", "a", 1, "a.bad.a1.json"], ["solo", "solo", 1, "solo.a1.json"]]);
  assert.equal(manifest.recaptureOf, null);
  t.done();
});

test("a page job is unchanged: version 1 state and manifest with no case fields, pages times passes, and the job's one body for every page", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture });
  const id = t.submit({ kind: "count", count: 2 }, { passes: 2 });
  await t.drain();
  const manifest = manifestOf(t, id);
  assert.equal(t.state(id).version, 1);
  assert.equal(manifest.version, 1);
  assert.ok(!("cases" in manifest) && !("recaptureOf" in manifest) && !("environment" in manifest.boxes[0]) && !("case" in manifest.captures[0]));
  assert.equal(manifest.captures.length, PAGES.length * 2);
  assert.deepEqual(Object.keys(manifest.captures[0]).sort(), ["box", "error", "file", "finishedAt", "httpStatus", "note", "page", "pass", "startedAt", "status"]);
  assert.ok(seen.asked.every((a) => a.body.steps === 600 && Object.keys(a.body).sort().join() === "steps,url"), "the job's one body, with the page's URL");
  t.done();
});

test("a re-capture after a failed evidence check: the bad case is captured again, as x.bad.a2.json, on the box its good was taken on", async () => {
  let badAttempts = 0;
  const seen = recording();
  const t = harness({ capture: async (box, body) => {
    const result = await seen.capture(box, body);
    return body.task === "x bad" && ++badAttempts === 1 ? { status: 200, json: { title: "a different page" } } : result;
  } });
  const source = caseJob(t, [...pair("y"), ...pair("x")]);
  await t.drain();
  const goodBox = t.state(source).captures.find((c) => c.case === "x.good")!.box;
  const first = readJson(join(t.store.resultsDir(source), "x.bad.a1.json"));
  assert.notEqual(first.capture.title, "https://pages.test/x/bad.html", "the evidence check rejects this record: the title is not the page's");

  const reply = recaptureRemote(t, source, ["x.bad"]);
  assert.equal(reply.code, 0, reply.stderr);
  const again = JSON.parse(reply.stdout).id as string;
  assert.notEqual(again, source);
  await t.drain();

  const state = t.state(again);
  assert.equal(state.state, "done", state.reason);
  assert.deepEqual(state.captures.map((c) => [c.case, c.attempt, c.box, c.file]), [["x.bad", 2, goodBox, "x.bad.a2.json"]]);
  assert.equal(seen.asked.at(-1)!.box, goodBox, "the worker that took the good variant was asked again");
  assert.deepEqual(seen.asked.at(-1)!.body, { task: "x bad", probeTables: true, url: "https://pages.test/x/bad.html" }, "with the same body");
  assert.equal(readJson(join(t.store.resultsDir(again), "x.bad.a2.json")).capture.title, "https://pages.test/x/bad.html");
  const manifest = manifestOf(t, again);
  assert.equal(manifest.recaptureOf, source);
  assert.deepEqual(manifest.boxes.map((b: { name: string }) => b.name), [goodBox]);
  assert.deepEqual(manifest.cases.map((c: { id: string; attempt: number }) => [c.id, c.attempt]), [["x.bad", 2]]);
  assert.deepEqual(readdirSync(t.store.resultsDir(source)).filter((f) => f.startsWith("x.")), ["x.bad.a1.json", "x.good.a1.json"], "the source job's records are not touched");

  const third = JSON.parse(recaptureRemote(t, again, ["x.bad"]).stdout).id as string;
  await t.drain();
  assert.deepEqual(t.state(third).captures.map((c) => [c.attempt, c.box, c.file]), [[3, goodBox, "x.bad.a3.json"]], "a re-capture of a re-capture works the same way, from that job");
  assert.equal(manifestOf(t, third).recaptureOf, again);
  t.done();
});

test("a re-capture names the case's whole group when its pair is named, and keeps the group together on the box", async () => {
  const t = harness();
  const source = caseJob(t, [...pair("x"), ...pair("y")]);
  await t.drain();
  const again = JSON.parse(recaptureRemote(t, source, ["x.good", "x.bad", "y.bad"]).stdout).id as string;
  const request = t.store.readRequest(again);
  assert.ok(request?.ok);
  const value = (request as { value: JobRequest }).value;
  assert.equal(value.version, 2);
  assert.deepEqual(value.cases!.map((c) => [c.id, c.group, c.attempt]), [["x.good", "x", 2], ["x.bad", "x", 2], ["y.bad", "y", 2]]);
  assert.equal(value.recaptureOf, source);
  assert.deepEqual(value.boxes, { kind: "named", names: [...new Set(Object.values(value.groups!).map((g) => g.box!))] }, "the boxes are asked for by name");
  await t.drain();
  const state = t.state(again);
  assert.equal(new Set(state.captures.filter((c) => c.group === "x").map((c) => c.box)).size, 1);
  t.done();
});

test("a re-capture queues while another job holds that box, and starts when the box is let go", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const seen = recording();
  const t = harness({ capture: async (box, body) => { if (String(body.url).includes("blocker")) await gate; return seen.capture(box, body); } });
  const source = caseJob(t, pair("x"), {}, { kind: "named", names: ["w3"] });
  await t.drain();
  assert.equal(t.state(source).captures[0]!.box, "w3");

  const blocker = t.submit({ kind: "named", names: ["w3"] }, { pages: ["https://pages.test/blocker"] });
  await t.runner.tick();
  await tick();
  assert.equal(t.state(blocker).state, "running");
  const again = JSON.parse(recaptureRemote(t, source, ["x.bad"]).stdout).id as string;
  await t.runner.tick();
  assert.equal(t.store.readState(again), null, "the re-capture is queued: no state while the blocker holds w3");
  assert.ok(t.ledger.place(again), "and it has a place in the ledger's queue");

  release();
  await t.runner.settled();
  await t.drain();
  assert.equal(t.state(blocker).state, "done");
  assert.equal(t.state(again).state, "done");
  assert.equal(seen.peak.get("w3"), 1, "the blocker and the re-capture were never on w3 at once");
  assert.equal(seen.asked.at(-1)!.box, "w3");
  t.done();
});

test("a re-capture is refused in words: a job that is not done, an unknown case, a job of pages, no cases, a label that is not a key", async () => {
  const t = harness();
  const source = caseJob(t, pair("x"));
  assert.match(recaptureRemote(t, source, ["x.bad"]).stderr, new RegExp(`job ${source} is queued: only a job that is done can be re-captured`));
  await t.drain();
  assert.match(recaptureRemote(t, source, ["x.nope"]).stderr, new RegExp(`job ${source} has no case x\\.nope`));
  assert.match(recaptureRemote(t, source, []).stderr, /no cases were named/);
  beat(t.store);
  const badLabel = remote(["recapture"], { store: t.store, stdin: () => JSON.stringify({ source, cases: ["x.bad"], label: "not a key!", submittedBy: "t" }) });
  assert.match(badLabel.stderr, /--label is required/);

  const pages = t.submit({ kind: "count", count: 2 });
  await t.drain();
  assert.match(recaptureRemote(t, pages, ["x.bad"]).stderr, new RegExp(`job ${pages} is a job of pages`));
  assert.equal(recaptureRemote(t, "fj-20200101T000000Z-abcdef", ["x"]).code, 4, "an unknown job is the unknown-job exit");
  assert.equal(t.store.list().length, 2, "a refusal writes no job");
  t.done();
});

test("a re-capture whose pinned box is gone from the inventory is refused, naming the box and the group, and saying to submit the group whole", async () => {
  const t = harness();
  const source = caseJob(t, pair("x"), {}, { kind: "named", names: ["w2"] });
  await t.drain();
  const reply = recaptureRemote(t, source, ["x.bad"], { known: () => ["w3", "w4"] });
  assert.equal(reply.code, 2);
  assert.equal(reply.stderr, "group x was captured on w2, which is not in the inventory now: submit the whole group as a new job\n");
  assert.equal(t.store.list().length, 1);
  t.done();
});

test("a re-capture is not accepted when no service is running, as a submit is not", async () => {
  const t = harness();
  const source = caseJob(t, pair("x"));
  await t.drain();
  writeFileSync(t.store.servicePath(), JSON.stringify({ pid: 1, commit: "t", startedAt: "2020-01-01T00:00:00Z", heartbeatAt: "2020-01-01T00:00:00Z" }));
  const reply = remote(["recapture"], { store: t.store, stdin: () => JSON.stringify({ source, cases: ["x.bad"], label: "A11-263", submittedBy: "t" }) });
  assert.equal(reply.code, 5);
  assert.match(reply.stderr, /the fleet job service is not running/);
  t.done();
});

test("a pinned box that is drifting makes the re-capture fail at start, naming the box, as a named job does", async () => {
  let drifting: Record<string, string> = {};
  const t = harness({ drift: () => drifting });
  const source = caseJob(t, pair("x"), {}, { kind: "named", names: ["w2"] });
  await t.drain();
  drifting = { w2: "off the manifest: Edge 155" };
  const again = JSON.parse(recaptureRemote(t, source, ["x.bad"]).stdout).id as string;
  await t.drain();
  assert.equal(t.state(again).state, "failed");
  assert.match(t.state(again).reason ?? "", /w2 is off the manifest: Edge 155: a box that differs from the manifest is out of capture/);
  t.done();
});

test("a group whose skipWhen matches the box sends nothing and writes no record; its cases read skipped; the group that does not match is captured", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture, health: async () => ({ busy: false, code: "c", environment: { screenReaderVersion: "2026.1" }, policy: {} }) });
  const id = caseJob(t, [...pair("a"), ...pair("b")], {
    a: { skipWhen: { environment: { screenReaderVersion: "2026.1", guidepupVersion: null } } },
    b: { skipWhen: { environment: { screenReaderVersion: "2025.9" } } },
  }, { kind: "count", count: 1 });
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done");
  assert.deepEqual(state.captures.map((c) => [c.case, c.status, c.note]), [["a.good", "skipped", SKIPPED], ["a.bad", "skipped", SKIPPED], ["b.good", "done", undefined], ["b.bad", "done", undefined]]);
  assert.deepEqual(seen.asked.map((a) => a.body.task), ["b good", "b bad"], "nothing was sent for the skipped group");
  assert.deepEqual(readdirSync(t.store.resultsDir(id)).sort(), ["b.bad.a1.json", "b.good.a1.json", "manifest.json"], "no record is written for it");
  assert.deepEqual(manifestOf(t, id).captures.map((c: { status: string }) => c.status), ["skipped", "skipped", "done", "done"]);
  t.done();
});

test("a box whose health was not read never skips", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture, health: async () => null });
  caseJob(t, pair("a"), { a: { skipWhen: { environment: { guidepupVersion: null } } } }, { kind: "count", count: 1 });
  await t.drain();
  assert.deepEqual(seen.asked.map((a) => a.body.task), ["a good", "a bad"]);
  t.done();
});

test("a box that leaves mid-job fails its unsent cases and the others carry on; nothing moves onto them", async () => {
  const t = harness({ evictAfter: 1, capture: async (box) => box.name === "w2" ? { status: 500, json: { error: "wedged" } } : { status: 200, json: {} } });
  const id = caseJob(t, [...pair("a"), ...pair("b")], {}, { kind: "count", count: 2 });
  await t.drain();
  const state = t.state(id);
  assert.deepEqual(state.captures.map((c) => [c.case, c.box, c.status]), [["a.good", "w2", "failed"], ["a.bad", "w2", "failed"], ["b.good", "w3", "done"], ["b.bad", "w3", "done"]]);
  assert.match(state.captures[1]!.error ?? "", /^w2 left the fleet/);
  t.done();
});

const MATCHING = { skipWhen: { environment: { v: "1" } } };
const envOne = async () => ({ busy: false, code: "c", environment: { v: "1" }, policy: {} });

test("a box whose last groups are all skipped is let go at once, while another box is still capturing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const t = harness({ health: envOne, capture: async (box, body) => { if (body.task === "long good") await gate; return { status: 200, json: {} }; } });
  // w2 gets the larger group, w3 gets the two pairs that skip
  caseJob(t, [...pair("long"), { id: "long.c", url: "https://pages.test/long/c", body: { task: "long c" }, group: "long" }, ...pair("a"), ...pair("b")], { a: MATCHING, b: MATCHING }, { kind: "count", count: 2 });
  await t.runner.tick();
  await tick(); await tick();
  assert.deepEqual(Object.keys(t.ledger.held()), ["w2"], "w3 had nothing to capture and was let go while w2 goes on");
  release();
  await t.runner.settled();
  t.done();
});

test("a box that leaves skips a pending group whose skipWhen matches, and fails only the groups that needed a capture", async () => {
  const t = harness({ evictAfter: 1, health: envOne, capture: async () => ({ status: 500, json: { error: "wedged" } }) });
  const id = caseJob(t, [...pair("a"), ...pair("b"), ...pair("c")], { b: MATCHING }, { kind: "count", count: 1 });
  await t.drain();
  const byGroup = Object.fromEntries(["a", "b", "c"].map((g) => [g, t.state(id).captures.filter((c) => c.group === g).map((c) => c.status)]));
  assert.deepEqual(byGroup, { a: ["failed", "failed"], b: ["skipped", "skipped"], c: ["failed", "failed"] });
  assert.ok(!readdirSync(t.store.resultsDir(id)).some((f) => f.startsWith("b.")), "no record is written for the skipped group");
  t.done();
});

test("a restart that finds a box gone skips a group whose skipWhen matches that box's reading, and moves or fails only the rest", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture, boxes: staticResolver(BOXES.filter((b) => b.name !== "w2")) });
  const id = interruptedCases(t, { c: MATCHING });
  const state = t.state(id);
  state.readings = { w2: { code: "c", environment: { v: "1" }, policy: null }, w3: { code: "c", environment: { v: "9" }, policy: null } };
  t.store.writeState(id, state);
  await t.drain();
  assert.deepEqual(t.state(id).captures.filter((c) => c.group === "c").map((c) => c.status), ["skipped", "skipped"]);
  assert.ok(!seen.asked.some((a) => String(a.body.task).startsWith("c ")));
  t.done();
});

test("a job that loses every box says how many cases were left, not pages", async () => {
  const t = harness({ evictAfter: 1, capture: async () => ({ status: 500, json: { error: "wedged" } }) });
  const id = caseJob(t, [...pair("a"), ...pair("b")], {}, { kind: "named", names: ["w2"] });
  await t.drain();
  assert.match(t.state(id).reason ?? "", /no box was left to capture 3 cases/);
  t.done();
});

/** A case job as a killed service leaves it: `a` is partly done on w2 (its bad was not sent), `c` is untouched on w2, `b` is whole on w3. */
function interruptedCases(t: Harness, groups: Record<string, GroupSpec> = {}): string {
  const id = caseJob(t, [...pair("a"), ...pair("b"), ...pair("c")], groups, { kind: "count", count: 2 });
  const onBox = { a: "w2", b: "w3", c: "w2" } as const;
  const captures = [...pair("a"), ...pair("b"), ...pair("c")].map((c) => ({ page: c.url, pass: 1, case: c.id, group: c.group!, attempt: 1, file: `${c.id}.a1.json`, box: onBox[c.group as "a"],
    status: (c.id === "a.good" ? "done" : "pending") as "done" | "pending" }));
  t.store.writeRecord(id, "a.good.a1.json", { capturedAt: "2026-10-25T09:00:00.000Z", worker: "w2", status: 200, capture: { before: "the restart" } });
  t.store.writeState(id, { version: 2, state: "running", boxes: ["w2", "w3"], readings: {}, dropped: [], captures, notes: [], startedAt: "2026-10-25T09:00:00.000Z" });
  return id;
}

test("a restart that finds a box gone moves an untouched group whole to a box that is left, and fails a partly-done group naming why", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture, boxes: staticResolver(BOXES.filter((b) => b.name !== "w2")) });
  const id = interruptedCases(t);
  await t.drain();
  const state = t.state(id);
  assert.equal(state.state, "done", state.reason);
  assert.deepEqual(state.captures.filter((c) => c.group === "c").map((c) => [c.box, c.status]), [["w3", "done"], ["w3", "done"]], "c moved whole");
  const bad = state.captures.find((c) => c.case === "a.bad")!;
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "w2 left the fleet; group a was already partly captured there, and a group is never split across boxes");
  assert.equal(readJson(join(t.store.resultsDir(id), "a.bad.a1.json")).capture.error, bad.error, "and a record says so");
  assert.ok(!seen.asked.some((a) => String(a.body.task).startsWith("a ")), "a is not captured again anywhere");
  assert.deepEqual(state.dropped.map((d) => d.box), ["w2"]);
  t.done();
});

test("a group a re-capture pinned is not moved by a restart: it fails, naming the pin", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture, boxes: staticResolver(BOXES.filter((b) => b.name !== "w2")) });
  const id = interruptedCases(t, { c: { box: "w2" } });
  await t.drain();
  const state = t.state(id);
  assert.deepEqual(state.captures.filter((c) => c.group === "c").map((c) => c.status), ["failed", "failed"]);
  assert.match(state.captures.find((c) => c.case === "c.good")!.error ?? "", /group c is pinned to w2 by a re-capture/);
  t.done();
});

test("a request of store version 2 is failed, naming the version, by a reader that accepts only version 1, and nothing is captured", async () => {
  const seen = recording();
  const t = harness({ capture: seen.capture });
  const id = caseJob(t, pair("a"));
  const older = new JobStore(t.dir, { accepts: [1] });
  const read = older.readRequest(id);
  assert.ok(read && !read.ok);
  assert.match((read as { reason: string }).reason, /request\.json is store version 2, and this service reads version 1$/);
  const runner = new Runner({ ...t.deps, store: older });
  await runner.tick();
  await runner.settled();
  assert.equal(t.state(id).state, "failed");
  assert.match(t.state(id).reason ?? "", /request\.json is store version 2, and this service reads version 1/);
  assert.deepEqual(seen.asked, [], "its URLs are never captured as plain pages");
  const pageJob = t.submit({ kind: "count", count: 2 });
  assert.ok(older.readRequest(pageJob)?.ok, "a page job is still version 1, and the older reader runs it");
  t.done();
});

test("a case job's status says N cases, counts skipped as done, and a failed case is named by its id", async () => {
  const t = harness({ capture: async (box, body) => ({ status: body.task === "a bad" ? 400 : 200, json: body.task === "a bad" ? { error: "refused" } : {} }),
    health: async () => ({ busy: false, code: "c", environment: { v: "1" }, policy: {} }) });
  const id = caseJob(t, [...pair("a"), ...pair("b")], { b: { skipWhen: { environment: { v: "1" } } } }, { kind: "count", count: 2 });
  await t.drain();
  const dir = mkdtempSync(join(tmpdir(), "fleet-cases-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const out: string[] = [];
  const code = await main(["job", "status", id], { ...realDeps(), transport: localRoute(t.dir), out: (x) => out.push(x), err: (x) => out.push(x) });
  assert.equal(code, 0, out.join(""));
  const text = out.join("");
  assert.match(text, /captures: 4 of 4 done, 1 failed, 2 skipped, 0 left {2}\(4 cases\)/);
  assert.match(text, /case a\.bad \(https:\/\/pages\.test\/a\/bad\.html\) on w\d: refused/);
  t.done();
});

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const REMOTE = new URL("./remote.ts", import.meta.url).pathname;
const ROUTE_DIR = mkdtempSync(join(tmpdir(), "fleet-cases-route-"));
cleanups.push(() => rmSync(ROUTE_DIR, { recursive: true, force: true }));
/** `remote.ts` as the control plane runs it, but with the inventory handed in (the real one is read over ssh), on this machine against the store in `dir`. */
const ROUTE = join(ROUTE_DIR, "route.ts");
writeFileSync(ROUTE, `import { readFileSync } from "node:fs";
import { remote } from ${JSON.stringify(REMOTE)};
import { JobStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
const result = remote(process.argv.slice(2), { store: new JobStore(process.env.DIR!), known: () => process.env.BOXES!.split(","), stdin: () => readFileSync(0, "utf8") });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.code);
`);
const localRoute = (dir: string): Transport => (args) => ({ file: "env", args: [`DIR=${dir}`, `BOXES=${BOXES.map((b) => b.name).join(",")}`, process.execPath, "--import", TSX, ROUTE, ...args] });

type Cli = { code: number; stdout: string; stderr: string };
async function cli(t: Harness, argv: string[], files: Record<string, string> = {}): Promise<Cli> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cases-cli-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  beat(t.store);
  let stdout = "";
  let stderr = "";
  const code = await main(argv.map((a) => a.replace("<dir>", dir)), {
    ...realDeps(), transport: localRoute(t.dir), out: (x) => { stdout += x; }, err: (x) => { stderr += x; }, submitter: () => "t@h" });
  return { code, stdout, stderr };
}

test("fleet capture submit --cases writes a version-2 job of cases, and prints its ID alone", async () => {
  const t = harness();
  const cases = JSON.stringify({ cases: pair("x"), groups: { x: { skipWhen: { environment: { v: "1" } } } } });
  const ran = await cli(t, ["capture", "submit", "--cases", "<dir>/cases.json", "--boxes", "2", "--label", "A11-263"], { "cases.json": cases });
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /^fj-\d{8}T\d{6}Z-[0-9a-f]{6}\n$/);
  assert.match(ran.stderr, /submitted 2 cases as fj-/);
  const request = t.store.readRequest(ran.stdout.trim());
  const value = (request as { value: JobRequest }).value;
  assert.deepEqual([value.version, value.pages, value.passes, value.body, value.boxes], [2, [], 1, {}, { kind: "count", count: 2 }]);
  assert.deepEqual(value.cases!.map((c) => c.id), ["x.good", "x.bad"]);
  assert.deepEqual(value.groups, { x: { skipWhen: { environment: { v: "1" } } } });
  t.done();
});

test("--cases is refused beside --pages, --passes, --steps, --probe and --body-json, and a page URL, naming the conflict, before anything is sent", async () => {
  const t = harness();
  const files = { "cases.json": JSON.stringify({ cases: pair("x") }), "pages.txt": "https://pages.test/a\n" };
  for (const flag of [["--pages", "<dir>/pages.txt"], ["--passes", "2"], ["--steps", "10"], ["--probe", "tables"], ["--body-json", "<dir>/cases.json"]]) {
    const ran = await cli(t, ["capture", "submit", "--cases", "<dir>/cases.json", "--boxes", "2", "--label", "A11-263", ...flag], files);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, new RegExp(`--cases cannot be used with ${flag[0]}: a job's bodies come from one place`), flag[0]);
  }
  const url = await cli(t, ["capture", "submit", "--cases", "<dir>/cases.json", "--boxes", "2", "--label", "A11-263", "https://pages.test/a"], files);
  assert.match(url.stderr, /--cases cannot be used with a page URL/);
  const bad = await cli(t, ["capture", "submit", "--cases", "<dir>/cases.json", "--boxes", "2", "--label", "A11-263"], { "cases.json": JSON.stringify({ cases: [{ id: "x", url: "https://pages.test/", body: { url: "https://o.test/" } }] }) });
  assert.match(bad.stderr, /case x: the capture body sets url/);
  assert.equal(t.store.list().length, 0, "nothing was submitted");
  t.done();
});

test("fleet job recapture prints the new job's ID alone and says what it re-captures; without --cases or --label it asks for them", async () => {
  const t = harness();
  const source = caseJob(t, pair("x"));
  await t.drain();
  const ran = await cli(t, ["job", "recapture", source, "--cases", "x.bad", "--label", "A11-263"]);
  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /^fj-\d{8}T\d{6}Z-[0-9a-f]{6}\n$/);
  assert.ok(ran.stderr.includes(`re-capturing 1 case of ${source} as ${ran.stdout.trim()}`), ran.stderr);
  assert.equal(t.store.list().length, 2);
  assert.match((await cli(t, ["job", "recapture", source, "--label", "A11-263"])).stderr, /needs --cases/);
  assert.match((await cli(t, ["job", "recapture", source, "--cases", "x.bad"])).stderr, /--label is required/);
  assert.match((await cli(t, ["job", "status", source, "--cases", "x.bad"])).stderr, /--cases is for fleet job recapture/);
  const refused = await cli(t, ["job", "recapture", source, "--cases", "x.nope", "--label", "A11-263"]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /has no case x\.nope/);
  t.done();
});
