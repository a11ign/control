/**
 * THE LEDGER ON DISK (A11-244): the file, the mutex, the clock and the rule that a ledger nobody can read holds every box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseLedger, LedgerBusy } from "./ledger.ts";

function setup(options: { now?: () => number; lockWaitMs?: number; pid?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-leases-"));
  const path = join(dir, "state", "ledger.json");
  const clock = { at: 1_000_000 };
  const ledger = new LeaseLedger(path, { now: () => clock.at, ...options });
  return { dir, path, clock, ledger, lock: join(dir, "state", "ledger.lock"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const spec = (id: string, boxes: string[], kind: "capture" | "maintain" | "read" = "capture") => ({ id, holder: `h:${id}`, kind, label: id, boxes });

test("a missing ledger reads as empty, and the first write creates its directory", () => {
  const t = setup();
  assert.deepEqual(t.ledger.live(), { ok: true, ledger: { version: 1, leases: [], queue: [] } });
  assert.equal(t.ledger.tryTake(spec("a", ["w1"])).taken, true);
  assert.ok(existsSync(t.path));
  assert.ok(!existsSync(t.lock), "the lock is let go");
  t.done();
});

test("a stale lease expires: it blocks before expiresAt, and after it the next taker gets the box and the stale entry is dropped from the file", () => {
  const t = setup();
  t.ledger.tryTake({ ...spec("gone", ["w1"]), ttlMs: 60_000 });
  t.clock.at += 59_999;
  const early = t.ledger.tryTake(spec("next", ["w1"]));
  assert.equal(early.taken, false, "still blocked one millisecond before it lapses");
  assert.deepEqual(!early.taken && early.heldBy, { w1: ["h:gone"] });
  t.clock.at += 1;
  assert.equal(t.ledger.tryTake(spec("next", ["w1"])).taken, true);
  const file = JSON.parse(readFileSync(t.path, "utf8"));
  assert.deepEqual(file.leases.map((l: { id: string }) => l.id), ["next"], "the stale entry is gone from the file");
  t.done();
});

test("a stale queue entry stops blocking the waiters behind it", () => {
  const t = setup();
  t.ledger.enqueue({ ...spec("front", ["w1"]), want: { named: ["w1"] }, enqueuedAt: 1, ttlMs: 10_000 });
  t.ledger.enqueue({ ...spec("back", ["w1"]), want: { named: ["w1"] }, enqueuedAt: 2, ttlMs: 60_000 });
  assert.equal(t.ledger.grantable("back").grantable, false);
  t.clock.at += 10_000;
  assert.equal(t.ledger.grantable("back").grantable, true);
  assert.equal(t.ledger.take("back", ["w1"]).taken, true);
  assert.deepEqual(JSON.parse(readFileSync(t.path, "utf8")).queue, []);
  t.done();
});

test("renewing pushes the lease out, so a live holder keeps its boxes past the first expiry and a silent one loses them", () => {
  const t = setup();
  t.ledger.tryTake({ ...spec("live", ["w1"]), ttlMs: 60_000 });
  t.ledger.tryTake({ ...spec("silent", ["w2"]), ttlMs: 60_000 });
  t.clock.at += 30_000;
  t.ledger.renew("live", { ttlMs: 60_000, expectedEnd: 5 });
  t.clock.at += 30_000;
  assert.equal(t.ledger.leaseOf("live")?.expectedEnd, 5);
  assert.equal(t.ledger.leaseOf("live")?.takenAt, 1_000_000, "a renewal does not move when it was taken");
  assert.equal(t.ledger.leaseOf("silent"), null);
  t.done();
});

test("a queued waiter takes its boxes in its turn, becomes the holder, and leaves the queue", () => {
  const t = setup();
  t.ledger.enqueue({ ...spec("a", []), want: { named: ["w1", "w2"] }, enqueuedAt: 1 });
  const took = t.ledger.take("a", ["w1", "w2"], { ttlMs: 1000, expectedEnd: 99 });
  assert.equal(took.taken, true);
  assert.deepEqual(t.ledger.queued(), []);
  assert.deepEqual(t.ledger.held(), { w1: ["h:a"], w2: ["h:a"] });
  assert.equal(t.ledger.leaseOf("a")?.expectedEnd, 99);
  t.done();
});

test("enqueueing again with the same id keeps one entry, at the time given", () => {
  const t = setup();
  t.ledger.enqueue({ ...spec("a", []), want: { count: 2 }, enqueuedAt: 5 });
  t.ledger.enqueue({ ...spec("a", []), want: { count: 2 }, enqueuedAt: 5 });
  assert.deepEqual(t.ledger.queued().map((w) => [w.id, w.enqueuedAt]), [["a", 5]]);
  t.done();
});

test("releaseBoxes frees some of a lease's boxes and keeps the rest; releaseAll frees the lease and any queue entry", () => {
  const t = setup();
  t.ledger.tryTake(spec("a", ["w1", "w2", "w3"]));
  t.ledger.releaseBoxes("a", ["w1", "w3"]);
  assert.deepEqual(t.ledger.leaseOf("a")?.boxes, ["w2"]);
  assert.equal(t.ledger.tryTake(spec("b", ["w1", "w3"])).taken, true, "the freed boxes are taken at once");
  t.ledger.releaseBoxes("a", ["w2"]);
  assert.equal(t.ledger.leaseOf("a"), null, "a lease with no box left is gone");
  t.ledger.enqueue({ ...spec("b", []), want: { count: 1 }, enqueuedAt: 1 });
  t.ledger.releaseAll("b");
  assert.deepEqual([t.ledger.held(), t.ledger.queued()], [{}, []]);
  t.done();
});

test("a ledger that is not JSON reads as every box held: nothing is taken, the file is not written over, and the reason is given", () => {
  const t = setup();
  t.ledger.tryTake(spec("a", ["w1"]));
  writeFileSync(t.path, "{ not json");
  const took = t.ledger.tryTake(spec("b", ["w2"]));
  assert.equal(took.taken, false);
  assert.match(!took.taken ? took.reason : "", /unreadable, so every box reads as held/);
  assert.equal(readFileSync(t.path, "utf8"), "{ not json", "not written over");
  assert.equal(t.ledger.grantable("anyone").grantable, false);
  t.done();
});

test("a ledger of a version this code does not know reads as every box held, and is left as it is", () => {
  const t = setup();
  t.ledger.tryTake(spec("a", ["w1"]));
  const newer = JSON.stringify({ version: 2, leases: [], queue: [], somethingNew: true });
  writeFileSync(t.path, newer);
  const took = t.ledger.tryTake(spec("b", ["w2"]));
  assert.equal(took.taken, false);
  assert.match(!took.taken ? took.reason : "", /version 2, and this code reads version 1, so every box reads as held/);
  t.ledger.releaseAll("a");
  t.ledger.renew("a");
  assert.equal(readFileSync(t.path, "utf8"), newer, "no write of this code touches a newer ledger");
  t.done();
});

test("a lock whose pid is dead is broken and the take goes through", () => {
  const t = setup();
  t.ledger.tryTake(spec("seed", ["w9"]));
  // a pid that cannot be alive: far above the kernel's pid_max
  writeFileSync(t.lock, "4194999");
  assert.equal(t.ledger.tryTake(spec("a", ["w1"])).taken, true);
  assert.ok(!existsSync(t.lock));
  t.done();
});

test("a lock held by a live process is waited for, and a lock still held after the wait throws LedgerBusy", () => {
  const t = setup({ lockWaitMs: 60 });
  t.ledger.tryTake(spec("seed", ["w9"]));
  writeFileSync(t.lock, String(process.ppid));
  assert.throws(() => t.ledger.tryTake(spec("a", ["w1"])), LedgerBusy);
  assert.ok(existsSync(t.lock), "a live holder's lock is not broken");
  t.done();
});

test("concurrent takes from separate processes never grant one box twice", async () => {
  const t = setup();
  const fixture = new URL("./take.fixture.ts", import.meta.url).pathname;
  const runs = Array.from({ length: 12 }, (_, i) => new Promise<{ id: string; taken: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, t.path, `p${i}`, "w1", "w2"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(out) as { id: string; taken: boolean }) : reject(new Error(`exit ${code}`)));
  }));
  const answers = await Promise.all(runs);
  assert.equal(answers.filter((a) => a.taken).length, 1, JSON.stringify(answers));
  const file = JSON.parse(readFileSync(t.path, "utf8"));
  assert.equal(file.leases.length, 1);
  assert.ok(!existsSync(t.lock));
  t.done();
});
