/**
 * `fleet facts submit|show` (A11-283): the remote half's refusals and requests, the local half's parsing, and the whole route through `cli.ts`'s `main` over a real
 * process, with the control plane's inventory (which cannot be read off the control plane) left out by asking for a number of boxes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main, realDeps } from "../fleet-jobs/cli.ts";
import type { Deps, Transport } from "../fleet-jobs/cli.ts";
import { JobStore } from "../fleet-jobs/store.ts";
import { FACTS_STORE_VERSION } from "../fleet-jobs/types.ts";
import { m720qFacts } from "./facts.fixture.ts";
import { factsBoxes, factsCommand } from "./commands.ts";
import { remote } from "./remote.ts";
import type { FactsRemoteDeps } from "./remote.ts";
import type { FactsFile } from "./types.ts";

const NOW = Date.UTC(2026, 9, 25, 9, 0, 0);
const INVENTORY = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4"];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-facts-remote-"));
  const store = new JobStore(join(dir, "jobs"));
  mkdirSync(store.dir);
  const factsFile = join(dir, "fleet-facts.json");
  const beat = (age = 0) => writeFileSync(store.servicePath(), JSON.stringify({ pid: 1, commit: "c", startedAt: new Date(NOW).toISOString(), heartbeatAt: new Date(NOW - age).toISOString() }));
  const deps = (stdin?: unknown, over: Partial<FactsRemoteDeps> = {}): FactsRemoteDeps =>
    ({ store, now: () => NOW, known: () => INVENTORY, factsFile, stdin: () => JSON.stringify(stdin), ...over });
  return { dir, store, factsFile, beat, deps, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const submitted = (t: ReturnType<typeof scratch>, payload: unknown) => remote(["submit"], t.deps(payload));

test("--boxes all is expanded at submit into every box in the inventory, named, and the job is written as a facts job at store version 3", () => {
  const t = scratch();
  t.beat();
  const result = submitted(t, { label: "A11-283", boxes: { kind: "all" }, submittedBy: "t@h" });
  assert.equal(result.code, 0, result.stderr);
  const { id } = JSON.parse(result.stdout) as { id: string };
  const request = t.store.readRequest(id);
  assert.ok(request?.ok);
  assert.equal(request.value.version, FACTS_STORE_VERSION);
  assert.equal(request.value.kind, "facts");
  assert.deepEqual(request.value.boxes, { kind: "named", names: INVENTORY });
  assert.deepEqual([request.value.pages, request.value.passes, request.value.body, request.value.freeze], [[], 1, {}, null]);
  t.done();
});

test("a count stays a count and names are kept as given", () => {
  const t = scratch();
  t.beat();
  const count = JSON.parse(submitted(t, { label: "A11-283", boxes: { kind: "count", count: 2 }, submittedBy: "t@h" }).stdout) as { boxes: unknown };
  assert.deepEqual(count.boxes, { kind: "count", count: 2 });
  const names = JSON.parse(submitted(t, { label: "A11-283", boxes: { kind: "named", names: ["a11y-worker-3"] }, submittedBy: "t@h" }).stdout) as { boxes: unknown };
  assert.deepEqual(names.boxes, { kind: "named", names: ["a11y-worker-3"] });
  t.done();
});

test("a box that is not in the inventory is refused by name, as a capture's is", () => {
  const t = scratch();
  t.beat();
  const result = submitted(t, { label: "A11-283", boxes: { kind: "named", names: ["a11y-worker-3", "a11y-worker-99"] }, submittedBy: "t@h" });
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "not boxes in the inventory: a11y-worker-99\n");
  t.done();
});

test("pages, cases, groups, passes, a body and a freeze are each refused by name", () => {
  const t = scratch();
  t.beat();
  for (const [key, value] of [["pages", ["https://x.test/"]], ["cases", []], ["groups", {}], ["passes", 2], ["body", { steps: 1 }], ["freeze", { commit: "c", namedAt: "x" }]] as const) {
    const result = submitted(t, { label: "A11-283", boxes: { kind: "all" }, submittedBy: "t@h", [key]: value });
    assert.equal(result.code, 2, key);
    assert.equal(result.stderr, `a facts job takes no ${key}: it reads each box's hardware and captures nothing\n`);
  }
  t.done();
});

test("ready is refused, because it would skip the asleep boxes a facts job exists to wake", () => {
  const t = scratch();
  t.beat();
  const result = submitted(t, { label: "A11-283", boxes: { kind: "ready" }, submittedBy: "t@h" });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^--boxes ready is a capture's/);
  t.done();
});

test("a label that is not a ticket key's shape, a missing one, a zero count and a box named twice are refused", () => {
  const t = scratch();
  t.beat();
  assert.match(submitted(t, { label: "no spaces allowed", boxes: { kind: "all" } }).stderr, /--label is required/);
  assert.match(submitted(t, { boxes: { kind: "all" } }).stderr, /--label is required/);
  assert.match(submitted(t, { label: "A11-283", boxes: { kind: "count", count: 0 } }).stderr, /whole number of boxes/);
  assert.match(submitted(t, { label: "A11-283", boxes: { kind: "named", names: ["a11y-worker-2", "a11y-worker-2"] } }).stderr, /names a box twice/);
  assert.match(submitted(t, { label: "A11-283" }).stderr, /--boxes is required/);
  t.done();
});

test("with no heartbeat nothing would run the job, so it is not accepted (exit 5)", () => {
  const t = scratch();
  const result = submitted(t, { label: "A11-283", boxes: { kind: "all" }, submittedBy: "t@h" });
  assert.equal(result.code, 5);
  assert.match(result.stderr, /the fleet job service is not running/);
  assert.deepEqual(t.store.list(), []);
  t.done();
});

test("an inventory that cannot be read refuses `all` and names, saying so", () => {
  const t = scratch();
  t.beat();
  const result = remote(["submit"], t.deps({ label: "A11-283", boxes: { kind: "all" } }, { known: () => { throw new Error("the control plane could not be reached"); } }));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /the inventory could not be read to check the box names: the control plane could not be reached/);
  t.done();
});

test("show with no facts file says that no facts job has run, and exits 2", () => {
  const t = scratch();
  const result = remote(["show"], t.deps());
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^no facts job has run: .*fleet-facts\.json does not exist/);
  t.done();
});

test("show of a file that cannot be read says so and does not guess", () => {
  const t = scratch();
  writeFileSync(t.factsFile, "nope");
  const result = remote(["show"], t.deps());
  assert.equal(result.code, 2);
  assert.match(result.stderr, /is unreadable/);
  t.done();
});

test("show answers the file as it is, with the inventory's order", () => {
  const t = scratch();
  const file: FactsFile = { version: 1, boxes: { "a11y-worker-2": { readAt: "2026-10-25T09:00:00.000Z", stale: false, lastAttemptAt: "2026-10-25T09:00:00.000Z", lastJob: "fj-1", lastError: null, facts: m720qFacts() } } };
  writeFileSync(t.factsFile, JSON.stringify(file));
  const result = remote(["show"], t.deps());
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { file, inventory: INVENTORY, inventoryError: null });
  t.done();
});

test("show says when the inventory could not be read, rather than answering an empty one", () => {
  const t = scratch();
  const file: FactsFile = { version: 1, boxes: { "a11y-worker-2": { readAt: "2026-10-25T09:00:00.000Z", stale: false, lastAttemptAt: "2026-10-25T09:00:00.000Z", lastJob: "fj-1", lastError: null, facts: m720qFacts() } } };
  writeFileSync(t.factsFile, JSON.stringify(file));
  const result = remote(["show"], t.deps(undefined, { known: () => { throw new Error("the control plane could not be reached"); } }));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { file, inventory: [], inventoryError: "the control plane could not be reached" });
  t.done();
});

test("fleet facts show prints what it has, says the inventory was unreadable on stderr, and exits 1; an inventory it read exits 0", () => {
  const file: FactsFile = { version: 1, boxes: { "a11y-worker-2": { readAt: "2026-10-25T09:00:00.000Z", stale: false, lastAttemptAt: "2026-10-25T09:00:00.000Z", lastJob: "fj-1", lastError: null, facts: m720qFacts() } } };
  const run = (inventoryError: string | null, args: string[] = []) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = factsCommand("show", args, {
      call: () => ({ reached: true, code: 0, stdout: JSON.stringify({ file, inventory: inventoryError === null ? ["a11y-worker-2", "a11y-worker-3"] : [], inventoryError }), stderr: "" }),
      out: (text) => { out.push(text); }, err: (text) => { err.push(text); }, submitter: () => "t@h",
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const read = run(null);
  assert.equal(read.code, 0);
  assert.match(read.out, /a11y-worker-3 .*never read/);
  assert.equal(read.err, "");
  for (const args of [[], ["--json"]]) {
    const unread = run("the control plane could not be reached", args);
    assert.equal(unread.code, 1);
    assert.match(unread.out, /a11y-worker-2/);
    assert.doesNotMatch(unread.out, /never read/);
    assert.match(unread.err, /the inventory could not be read \(the control plane could not be reached\): only the boxes the facts file holds are shown, so a box that has never been read is missing/);
  }
});

test("--boxes of the CLI: all, a number, names; ready and zero are refused", () => {
  assert.deepEqual(factsBoxes("all"), { kind: "all" });
  assert.deepEqual(factsBoxes("3"), { kind: "count", count: 3 });
  assert.deepEqual(factsBoxes("a11y-worker-2, a11y-worker-3"), { kind: "named", names: ["a11y-worker-2", "a11y-worker-3"] });
  assert.match((factsBoxes("ready") as { refusal: string }).refusal, /--boxes ready is a capture's/);
  assert.match((factsBoxes("0") as { refusal: string }).refusal, /asks for no box/);
});

// ---- the whole route, through `main` and a real process ----

// The route is given no control plane to read the inventory from, so these tests answer the same on any host; `show` then lists the file's own boxes.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const REMOTE = new URL("./remote.ts", import.meta.url).pathname;

function route(t: ReturnType<typeof scratch>) {
  const factsTransport: Transport = (args) => ({ file: "env", args: ["-u", "A11Y_CONTROL_HOST", "A11Y_CONTROL_HOST_FILE=/nonexistent", `A11Y_FLEET_JOBS_DIR=${t.store.dir}`, `A11Y_FLEET_FACTS_FILE=${t.factsFile}`, process.execPath, "--import", TSX, REMOTE, ...args] });
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = { ...realDeps(), factsTransport, out: (text) => { out.push(text); }, err: (text) => { err.push(text); }, submitter: () => "t@h" };
  return { deps, out, err };
}

test("fleet facts submit prints the job ID at once, and the job is a facts job in the store", async () => {
  const t = scratch();
  writeFileSync(t.store.servicePath(), JSON.stringify({ pid: 1, commit: "c", startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  const r = route(t);
  const code = await main(["facts", "submit", "--boxes", "2", "--label", "A11-283"], r.deps);
  assert.equal(code, 0, r.err.join(""));
  const id = r.out.join("").trim();
  assert.match(id, /^fj-\d{8}T\d{6}Z-[0-9a-f]{6}$/);
  assert.match(r.err.join(""), new RegExp(`fleet job wait ${id}`));
  const request = JSON.parse(readFileSync(join(t.store.jobDir(id), "request.json"), "utf8"));
  assert.equal(request.kind, "facts");
  assert.equal(request.version, 3);
  t.done();
});

test("fleet facts submit needs --label and --boxes, and refuses what a capture takes", async () => {
  const t = scratch();
  const r = route(t);
  assert.equal(await main(["facts", "submit", "--boxes", "all"], r.deps), 2);
  assert.match(r.err.join(""), /--label is required/);
  assert.equal(await main(["facts", "submit", "--label", "A11-283"], r.deps), 2);
  assert.equal(await main(["facts", "submit", "--boxes", "all", "--label", "A11-283", "--pages", "p.json"], r.deps), 2);
  assert.match(r.err.join(""), /Unknown option '--pages'/);
  assert.equal(await main(["facts", "submit", "--boxes", "ready", "--label", "A11-283"], r.deps), 2);
  t.done();
});

test("fleet facts show prints the table, --json the file, and exits 2 when no facts job has run", async () => {
  const t = scratch();
  const missing = route(t);
  assert.equal(await main(["facts", "show"], missing.deps), 2);
  assert.match(missing.err.join(""), /no facts job has run/);
  const file: FactsFile = { version: 1, boxes: {
    "a11y-worker-2": { readAt: "2026-10-25T09:00:00.000Z", stale: false, lastAttemptAt: "2026-10-25T09:00:00.000Z", lastJob: "fj-1", lastError: null, facts: m720qFacts() },
    "a11y-worker-5": { readAt: "2026-10-24T09:00:00.000Z", stale: true, lastAttemptAt: "2026-10-25T09:00:00.000Z", lastJob: "fj-2", lastError: "unreachable", facts: m720qFacts() } } };
  writeFileSync(t.factsFile, JSON.stringify(file));
  const table = route(t);
  // The route reaches no control plane, so the inventory is unreadable: the table is printed from the file, the reason is said, and the exit is 1.
  assert.equal(await main(["facts", "show"], table.deps), 1);
  assert.match(table.err.join(""), /the inventory could not be read \(/);
  const lines = table.out.join("").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /^a11y-worker-2 .*LENOVO ThinkCentre M720q \(10T8\)/);
  assert.match(lines[2]!, /STALE: last read 2026-10-24T09:00:00.000Z; last attempt 2026-10-25T09:00:00.000Z: unreachable$/);
  const json = route(t);
  assert.equal(await main(["facts", "show", "--json", "--boxes", "a11y-worker-5"], json.deps), 1);
  assert.deepEqual(Object.keys(JSON.parse(json.out.join("")).boxes), ["a11y-worker-5"]);
  t.done();
});

test("an unknown fleet facts command prints usage", async () => {
  const t = scratch();
  const r = route(t);
  assert.equal(await main(["facts", "wipe"], r.deps), 2);
  assert.match(r.err.join(""), /usage: fleet facts submit/);
  t.done();
});
