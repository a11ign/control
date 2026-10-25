/**
 * THE SCHEDULED TAKERS' SHARED VOCABULARY (A11-244, step 2): a `read` taken beside what is compatible, the signals auto-off decides from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseLedger } from "./ledger.ts";
import { bookReads, bookShutdown, signalsOf } from "./booking.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-booking-"));
  const ledger = new LeaseLedger(join(dir, "ledger.json"), { now: () => 1_000_000 });
  return { ledger, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const hold = (ledger: LeaseLedger, id: string, kind: "capture" | "maintain" | "read", boxes: string[]) =>
  ledger.tryTake({ id, holder: `h:${id}`, kind, label: id, boxes, ttlMs: 3_600_000 });
const reading = { id: "drift", holder: "fleet-drift:t", label: "drift" };

test("a read is taken beside a capture and another read, and refused only beside a maintain, which it names and skips", () => {
  const t = setup();
  hold(t.ledger, "job", "capture", ["w1"]);
  hold(t.ledger, "other-read", "read", ["w2"]);
  hold(t.ledger, "freeze-w3", "maintain", ["w3"]);
  hold(t.ledger, "off-w4", "maintain", ["w4"]);
  const booking = bookReads(t.ledger, { ...reading, boxes: ["w1", "w2", "w3", "w4", "w5"] });
  assert.deepEqual(booking.readable, ["w1", "w2", "w5"]);
  assert.deepEqual(booking.skipped, { w3: "under maintenance by h:freeze-w3", w4: "under maintenance by h:off-w4" });
  assert.equal(booking.unbooked, null);
  assert.deepEqual(t.ledger.leaseOf("drift")?.boxes, ["w1", "w2", "w5"]);
  assert.equal(t.ledger.leaseOf("drift")?.kind, "read");
  booking.release();
  assert.equal(t.ledger.leaseOf("drift"), null, "the read lease is let go");
  assert.equal(t.ledger.leaseOf("job")?.kind, "capture", "and nobody else's is touched");
  t.done();
});

test("a read never queues: a queued capture or maintain waiter does not stop it, and it does not join the queue", () => {
  const t = setup();
  t.ledger.enqueue({ id: "job", holder: "h:job", kind: "capture", label: "job", want: { count: 3 }, enqueuedAt: 1 });
  const booking = bookReads(t.ledger, { ...reading, boxes: ["w1", "w2"] });
  assert.deepEqual(booking.readable, ["w1", "w2"]);
  assert.deepEqual(t.ledger.queued().map((w) => w.id), ["job"]);
  t.done();
});

test("a read lease lapses at its own expiry if the check dies before it lets go", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-booking-"));
  const clock = { at: 1_000_000 };
  const ledger = new LeaseLedger(join(dir, "ledger.json"), { now: () => clock.at });
  bookReads(ledger, { ...reading, boxes: ["w1"], ttlMs: 600_000 });
  assert.equal(ledger.leaseOf("drift")?.expiresAt, 1_600_000);
  clock.at = 1_600_000;
  assert.equal(ledger.leaseOf("drift"), null);
  assert.equal(hold(ledger, "freeze", "maintain", ["w1"]).taken, true, "so a freeze is not kept out for ever");
  rmSync(dir, { recursive: true, force: true });
});

test("the signals: a capture or maintain lease or a named waiter books a box; a read does not; a count waiter queues the whole fleet", () => {
  const t = setup();
  hold(t.ledger, "job", "capture", ["w1"]);
  hold(t.ledger, "freeze", "maintain", ["w2"]);
  hold(t.ledger, "drift", "read", ["w3"]);
  t.ledger.enqueue({ id: "named", holder: "h:named", kind: "capture", label: "named", want: { named: ["w4"] }, enqueuedAt: 1 });
  const named = signalsOf(t.ledger);
  assert.deepEqual(["w1", "w2", "w3", "w4", "w5"].map((box) => named.leasePending(box)), [true, true, false, true, false]);
  assert.equal(named.batchQueued, false, "a named waiter may use only the boxes it named");
  t.ledger.enqueue({ id: "any", holder: "h:any", kind: "capture", label: "any", want: { ready: true }, enqueuedAt: 2 });
  assert.equal(signalsOf(t.ledger).batchQueued, true);
  t.done();
});

test("a shutdown lease is exclusive, is not taken ahead of a waiter, and is let go", () => {
  const t = setup();
  const lease = bookShutdown(t.ledger, "w1", { holder: "fleet-auto-off:t", ttlMs: 900_000 });
  assert.equal(lease.held, true);
  assert.equal(t.ledger.leaseOf("fleet-auto-off:t:w1")?.kind, "maintain");
  assert.equal(hold(t.ledger, "job", "capture", ["w1"]).taken, false, "a capture cannot take the box under a shutdown");
  if (lease.held) lease.release();
  assert.deepEqual(t.ledger.held(), {});
  t.ledger.enqueue({ id: "job", holder: "h:job", kind: "capture", label: "job", want: { named: ["w2"] }, enqueuedAt: 1 });
  assert.equal(bookShutdown(t.ledger, "w2", { holder: "fleet-auto-off:t", ttlMs: 900_000 }).held, false, "nor is a box a waiter named");
  assert.equal(bookShutdown(t.ledger, "w3", { holder: "fleet-auto-off:t", ttlMs: 900_000 }).held, true);
  t.done();
});
