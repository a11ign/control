/**
 * THE FLEET JOB SERVICE ACROSS REAL PROCESSES (A11-243). The service is a child process (`service.fixture.ts`: the real service over fake workers), and
 * so is every `fleet` call (`cli.fixture.ts`: the real command with a local route in place of ssh). The fake workers answer `/capture` as the real one
 * does and live in this process, so a service that is killed leaves them standing, as a real fleet is.
 *
 * Each test below names the acceptance line it proves: submit, status, wait done, wait timeout, cancel, a restart mid-job, a caller that exits while its
 * job runs on, and the results readable from the agents host.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeWorker } from "./fake-fleet.ts";
import type { FakeWorker, FakeWorkerOptions } from "./fake-fleet.ts";
import { JobStore } from "./store.ts";
import type { JobStateFile } from "./types.ts";
import type { JobView } from "./view.ts";

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const HERE = new URL(".", import.meta.url).pathname;
const children = new Set<ChildProcess>();
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const child of children) child.kill("SIGKILL");
  for (const cleanup of cleanups) await cleanup();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (await check()) return; await sleep(50); }
  throw new Error(`gave up after ${ms} ms waiting for ${what}`);
}

async function fleetOf(count: number, options: FakeWorkerOptions = {}): Promise<FakeWorker[]> {
  const workers = await Promise.all(Array.from({ length: count }, (_, i) => fakeWorker(`a11y-worker-${i + 2}`, options)));
  cleanups.push(() => Promise.all(workers.map((w) => w.close())).then(() => undefined));
  return workers;
}

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-jobs-e2e-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Service = { child: ChildProcess; exited: Promise<number | null>; log: () => string };

async function startServiceProcess(dir: string, workers: FakeWorker[]): Promise<Service> {
  const child = spawn(process.execPath, ["--import", TSX, join(HERE, "service.fixture.ts")], {
    env: { ...process.env, A11Y_FLEET_JOBS_DIR: dir, FAKE_FLEET: JSON.stringify(workers.map(({ name, url }) => ({ name, url }))) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let out = "";
  child.stdout!.on("data", (chunk) => { out += chunk; });
  child.stderr!.on("data", (chunk) => { out += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  await until("the service's first heartbeat", () => existsSync(join(dir, "service.json")) && out.includes("started"));
  return { child, exited, log: () => out };
}

type Ran = { code: number | null; stdout: string; stderr: string };

function fleetCommand(dir: string, args: string[], { pollMs = 300 }: { pollMs?: number } = {}): { done: Promise<Ran>; child: ChildProcess } {
  const child = spawn(process.execPath, ["--import", TSX, join(HERE, "cli.fixture.ts"), ...args], {
    env: { ...process.env, A11Y_FLEET_JOBS_DIR: dir, FLEET_WAIT_POLL_MS: String(pollMs) }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk; });
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  return { child, done: new Promise<Ran>((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr }))) };
}
const fleet = (dir: string, args: string[], options?: { pollMs?: number }): Promise<Ran> => fleetCommand(dir, args, options).done;

function pagesFile(dir: string, names: string[]): string {
  const path = join(dir, "pages.json");
  writeFileSync(path, JSON.stringify({ sample: names.map((name) => ({ url: `https://pages.test/${name}` })) }));
  return path;
}

const store = (dir: string) => new JobStore(dir);
const stateOf = (dir: string, id: string): JobStateFile => {
  const read = store(dir).readState(id);
  assert.ok(read?.ok, `no state for ${id}`);
  return (read as { value: JobStateFile }).value;
};
const statusJson = async (dir: string, id: string): Promise<JobView> => JSON.parse((await fleet(dir, ["job", "status", id, "--json"])).stdout) as JobView;
const JOB = /^fj-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

test("submit returns a job ID at once; status shows the state and progress per box; wait ends 0 when the job is done; the results are in a fixed place with a manifest", async () => {
  const workers = await fleetOf(2, { durationMs: 100 });
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const pages = pagesFile(dir, ["a", "b", "c"]);

  const started = Date.now();
  const submitted = await fleet(dir, ["capture", "submit", "--pages", pages, "--boxes", "2", "--passes", "2", "--label", "A11-243", "--probe", "tables,typing"]);
  assert.equal(submitted.code, 0, submitted.stderr);
  const id = submitted.stdout.trim();
  assert.match(id, JOB, "stdout is the job ID and nothing else");
  assert.ok(Date.now() - started < 8_000, "the ID came back without waiting for the captures (six pages of two seconds each, on two boxes)");

  const early = await statusJson(dir, id);
  assert.ok(["queued", "running"].includes(early.state), early.state);
  assert.equal(early.total, 6 );
  assert.equal(early.results.location, `control:${dir}/${id}/results`);

  await until("the job to be running with progress", async () => (await statusJson(dir, id)).boxes.length === 2);
  const text = await fleet(dir, ["job", "status", id]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /a11y-worker-2: \d\/3/);
  assert.match(text.stdout, /estimated finish: /);
  assert.match(text.stdout, new RegExp(`results: control:${dir}/${id}/results`));

  const waited = await fleet(dir, ["job", "wait", id, "--timeout", "2m"]);
  assert.equal(waited.code, 0, waited.stderr);
  assert.match(waited.stdout, new RegExp(`${id} done: 6 captures, 0 failed`));

  const view = await statusJson(dir, id);
  assert.deepEqual([view.state, view.done, view.total, view.remaining], ["done", 6, 6, 0]);
  assert.deepEqual(view.boxes.map((b) => [b.done, b.total]), [[3, 3], [3, 3]]);

  const results = join(dir, id, "results");
  assert.equal(readdirSync(results).length, 7, "six records and the manifest");
  const manifest = JSON.parse(readFileSync(join(results, "manifest.json"), "utf8"));
  assert.equal(manifest.label, "A11-243");
  assert.deepEqual(manifest.pages, ["a", "b", "c"].map((n) => `https://pages.test/${n}`));
  assert.deepEqual(manifest.boxes.map((b: { name: string; workerCode: string; windowsBuild: string }) => [b.name, b.workerCode, b.windowsBuild]),
    [["a11y-worker-2", "code-a11y-worker-2", "26300.1"], ["a11y-worker-3", "code-a11y-worker-3", "26300.1"]]);
  assert.ok(manifest.startedAt && manifest.finishedAt && manifest.startedAt <= manifest.finishedAt);
  assert.deepEqual(manifest.pins, { pins: { fixture: true } });
  assert.equal(manifest.body.probeTables, true);
  assert.equal(manifest.body.probeTyping, true);
  assert.equal(manifest.body.probeDialog, undefined, "only the probes asked for");
  assert.ok(!JSON.stringify(manifest).includes("127.0.0.1"), "boxes are named, never addressed");
  assert.equal(workers.every((w) => w.peak === 1), true, "one capture at a time on a box");
  // the passes of a page were on different boxes: each worker saw each of its pages once
  for (const w of workers) assert.equal(new Set(w.asked).size, w.asked.length);
});

test("fleet job fetch brings a job's results to the agents host, and list is filtered by label", async () => {
  const workers = await fleetOf(1);
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const mine = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a"]), "--boxes", "1", "--label", "A11-243"])).stdout.trim();
  const other = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a"]), "--boxes", "1", "--label", "A11-999"])).stdout.trim();
  assert.equal((await fleet(dir, ["job", "wait", mine, "--timeout", "2m"])).code, 0);
  assert.equal((await fleet(dir, ["job", "wait", other, "--timeout", "2m"])).code, 0);

  const listed = JSON.parse((await fleet(dir, ["job", "list", "--label", "A11-243", "--json"])).stdout);
  assert.deepEqual(listed.map((j: { id: string }) => j.id), [mine]);
  const all = JSON.parse((await fleet(dir, ["job", "list", "--json"])).stdout);
  assert.deepEqual(all.map((j: { id: string }) => j.id), [other, mine], "newest first");
  assert.deepEqual(JSON.parse((await fleet(dir, ["job", "list", "--state", "running", "--json"])).stdout), []);
  assert.match((await fleet(dir, ["job", "list", "--label", "A11-243"])).stdout, new RegExp(`${mine}  done`));

  const to = mkdtempSync(join(tmpdir(), "fleet-fetch-"));
  cleanups.push(() => rmSync(to, { recursive: true, force: true }));
  const fetched = await fleet(dir, ["job", "fetch", mine, "--to", to]);
  assert.equal(fetched.code, 0, fetched.stderr);
  const copied = readdirSync(join(to, mine)).sort();
  assert.equal(copied.length, 2, copied.join(","));
  assert.ok(copied.includes("manifest.json"));
  const record = JSON.parse(readFileSync(join(to, mine, copied.find((f) => f !== "manifest.json")!), "utf8"));
  assert.equal(record.worker, "a11y-worker-2");
  assert.equal(record.status, 200);
});

test("wait ends with a distinct code on timeout, printing the progress and what is left, and the job goes on", async () => {
  const workers = await fleetOf(1, { durationMs: 2500 });
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b", "c"]), "--boxes", "1", "--label", "A11-243"])).stdout.trim();

  const started = Date.now();
  const waited = await fleet(dir, ["job", "wait", id, "--timeout", "4s"]);
  assert.equal(waited.code, 124, waited.stderr);
  assert.ok(Date.now() - started < 4_000 + 8_000, `a wait of 4 s ended after ${Date.now() - started} ms`);
  assert.match(waited.stderr, /TIMED OUT after 4s waiting for fj-/);
  assert.match(waited.stderr, /a11y-worker-2: \d\/3/, "the progress per box");
  assert.match(waited.stderr, /\d of 3 captures are left/, "what is left");
  assert.match(waited.stderr, /the service was last reached at 20/);

  const after = await fleet(dir, ["job", "wait", id, "--timeout", "2m"]);
  assert.equal(after.code, 0, "the timeout did not stop the job");
});

test("cancel ends the job cancelled, wait then exits 3, and the capture on the box when it was cancelled is kept", async () => {
  const workers = await fleetOf(1, { durationMs: 1500 });
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b", "c", "d"]), "--boxes", "1", "--label", "A11-243"])).stdout.trim();
  await until("a capture on the box", () => workers[0]!.asked.length === 1);

  const cancelled = await fleet(dir, ["job", "cancel", id]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const waited = await fleet(dir, ["job", "wait", id, "--timeout", "1m"]);
  assert.equal(waited.code, 3, waited.stderr);
  assert.match(waited.stderr, /was cancelled/);
  const view = await statusJson(dir, id);
  assert.equal(view.state, "cancelled");
  assert.equal(view.done, 1, "the capture that was on the box ended and is kept");
  assert.equal(workers[0]!.asked.length, 1, "nothing else was sent after the cancel");
  const again = await fleet(dir, ["job", "cancel", id]);
  assert.notEqual(again.code, 0);
  assert.match(again.stderr, /has already ended \(cancelled\)/);
});

test("a job that fails makes wait exit 1 and print why", async () => {
  const workers = await fleetOf(2);
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a"]), "--boxes", "ready", "--passes", "3", "--label", "A11-243"])).stdout.trim();
  const waited = await fleet(dir, ["job", "wait", id, "--timeout", "1m"]);
  assert.equal(waited.code, 1, waited.stderr);
  assert.match(waited.stderr, /FAILED: 3 passes need 3 different boxes and only 2 are given/);
});

test("wait has no unbounded form, and an unknown job or a bad request is a usage error, not a hang", async () => {
  const dir = storeDir();
  const missing = await fleet(dir, ["job", "wait", "fj-20261025T085815Z-aaaaaa"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--timeout/);
  for (const bad of ["0", "forever", "30", "99h", "-1m", "inf"]) {
    const ran = await fleet(dir, ["job", "wait", "fj-20261025T085815Z-aaaaaa", "--timeout", bad]);
    assert.equal(ran.code, 2, `--timeout ${bad}: ${ran.stderr}`);
  }
  const unknown = await fleet(dir, ["job", "wait", "fj-20261025T085815Z-aaaaaa", "--timeout", "5s"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /no job fj-20261025T085815Z-aaaaaa/);
  assert.equal((await fleet(dir, ["job", "status", "../../etc"])).code, 2);
  assert.equal((await fleet(dir, ["capture", "submit", "--boxes", "1", "--label", "A11-243"])).code, 2, "no pages");
  assert.equal((await fleet(dir, ["capture", "submit", "--pages", "https://pages.test/a", "--boxes", "1"])).code, 2, "no label");
});

test("submit is refused, with exit 2, when the service is not running: no job is accepted that nothing would run", async () => {
  const dir = storeDir();
  const none = await fleet(dir, ["capture", "submit", "--pages", "https://pages.test/a", "--boxes", "1", "--label", "A11-243"]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /the fleet job service is not running \(no heartbeat\)/);
  writeFileSync(join(dir, "service.json"), JSON.stringify({ pid: 1, commit: "x", startedAt: "2026-10-25T00:00:00Z", heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
  const stale = await fleet(dir, ["capture", "submit", "--pages", "https://pages.test/a", "--boxes", "1", "--label", "A11-243"]);
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /last heartbeat 1\d\ds ago/);
  assert.deepEqual(store(dir).list(), [], "nothing was written");
});

test("a caller that exits, or is killed, while its job runs does not stop the job", async () => {
  const workers = await fleetOf(2, { durationMs: 1500 });
  const dir = storeDir();
  await startServiceProcess(dir, workers);
  const submit = fleetCommand(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b", "c", "d"]), "--boxes", "2", "--label", "A11-243"]);
  const submitted = await submit.done;
  assert.equal(submitted.code, 0, submitted.stderr);
  assert.ok(submit.child.exitCode === 0 && submit.child.pid, "the caller has exited");
  const id = submitted.stdout.trim();
  assert.notEqual((await statusJson(dir, id)).state, "done", "it was still not done when its caller was gone");

  // a second caller waits, and is killed with no chance to clean up
  const waiter = fleetCommand(dir, ["job", "wait", id, "--timeout", "10m"]);
  await until("the job to be running", async () => (await statusJson(dir, id)).state === "running");
  waiter.child.kill("SIGKILL");
  await waiter.done;
  assert.ok(!["done", "failed", "cancelled"].includes((await statusJson(dir, id)).state), "the job outlived the caller that was killed");

  // a third process, which never saw the job's caller, sees it run to done
  const third = await fleet(dir, ["job", "wait", id, "--timeout", "2m"]);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(stateOf(dir, id).captures.filter((c) => c.status === "done").length, 4);
  assert.equal(workers[0]!.asked.length + workers[1]!.asked.length, 4, "each page was captured once");
});

test("a restart mid-job: the service is killed with a capture on a box, and the next one finishes the job with one record per page and pass", async () => {
  const workers = await fleetOf(2, { durationMs: 3500 });
  const dir = storeDir();
  const first = await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b", "c"]), "--boxes", "2", "--passes", "2", "--label", "A11-243"])).stdout.trim();
  await until("both boxes capturing", () => workers.every((w) => w.asked.length === 1));
  await sleep(500);
  first.child.kill("SIGKILL");
  await first.exited;
  const killed = stateOf(dir, id);
  assert.equal(killed.state, "running");
  assert.equal(killed.captures.filter((c) => c.status === "dispatched").length, 2, "two captures were sent and not recorded when the service died");
  assert.equal(readdirSync(join(dir, id, "results")).filter((f) => f !== "manifest.json").length, 0);

  const second = await startServiceProcess(dir, workers);
  const waited = await fleet(dir, ["job", "wait", id, "--timeout", "3m"]);
  assert.equal(waited.code, 0, `${waited.stderr}\n${second.log()}`);

  const state = stateOf(dir, id);
  assert.equal(state.state, "done");
  assert.equal(state.captures.length, 6);
  const records = readdirSync(join(dir, id, "results")).filter((f) => f !== "manifest.json").sort();
  assert.deepEqual(records, state.captures.map((c) => c.file).sort(), "every page and pass has exactly one record");
  const retaken = state.captures.filter((c) => c.note?.startsWith("re-captured after a service restart"));
  assert.equal(retaken.length, 2, "the two interrupted captures say they were taken again");
  for (const c of retaken) assert.equal(JSON.parse(readFileSync(join(dir, id, "results", c.file), "utf8")).note, c.note);
  assert.ok(workers.every((w) => w.peak === 1), "the new service waited for each box to finish the old capture: no box ever held two");
  assert.match(state.notes.join("\n"), /resumed after a service restart/);
});

test("a graceful stop drains: the capture in flight ends and is recorded, the service exits 0, and the next start re-captures nothing", async () => {
  const workers = await fleetOf(1, { durationMs: 2500 });
  const dir = storeDir();
  const first = await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b", "c"]), "--boxes", "1", "--label", "A11-243"])).stdout.trim();
  await until("a capture on the box", () => workers[0]!.asked.length === 1);
  first.child.kill("SIGTERM");
  assert.equal(await first.exited, 0, first.log());
  const drained = stateOf(dir, id);
  assert.equal(drained.state, "running", "the job is left to be resumed");
  assert.deepEqual(drained.captures.map((c) => c.status), ["done", "pending", "pending"], "the capture in flight was recorded; none is left dispatched");

  await startServiceProcess(dir, workers);
  assert.equal((await fleet(dir, ["job", "wait", id, "--timeout", "3m"])).code, 0);
  assert.ok(stateOf(dir, id).captures.every((c) => c.note === undefined), "nothing was taken again");
  assert.deepEqual([...workers[0]!.asked].sort(), ["a", "b", "c"].map((n) => `https://pages.test/${n}`), "each page was asked of the worker exactly once");
});

test("a service killed and restarted twice still ends the job done, and a restart leaves a finished job alone", async () => {
  const workers = await fleetOf(1, { durationMs: 2200 });
  const dir = storeDir();
  let service = await startServiceProcess(dir, workers);
  const id = (await fleet(dir, ["capture", "submit", "--pages", pagesFile(dir, ["a", "b"]), "--boxes", "1", "--label", "A11-243"])).stdout.trim();
  for (let i = 0; i < 2; i++) {
    await until("a capture on the box", () => workers[0]!.asked.length === i + 1);
    service.child.kill("SIGKILL");
    await service.exited;
    service = await startServiceProcess(dir, workers);
  }
  assert.equal((await fleet(dir, ["job", "wait", id, "--timeout", "3m"])).code, 0);
  const finished = readFileSync(join(dir, id, "state.json"), "utf8");
  service.child.kill("SIGKILL");
  await service.exited;
  await startServiceProcess(dir, workers);
  await sleep(1000);
  assert.equal(readFileSync(join(dir, id, "state.json"), "utf8"), finished, "a finished job is not touched by a restart");
});
