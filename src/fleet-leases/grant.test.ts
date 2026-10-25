/**
 * THE RULES OF BOOKING (A11-244): compatibility in both directions, expiry, and the order a queue is served in. All pure, so no clock and no file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { availability, compatible, liveOf, mayTake, mayTakeNow, placeOf } from "./grant.ts";
import { LEDGER_VERSION } from "./types.ts";
import type { Lease, LeaseKind, Ledger, Waiter, Want } from "./types.ts";

const T = 1_000_000;
const lease = (id: string, kind: LeaseKind, boxes: string[], expiresAt = T + 60_000): Lease =>
  ({ id, holder: `h:${id}`, kind, boxes, label: id, takenAt: T, renewedAt: T, expiresAt, expectedEnd: null });
const waiter = (id: string, want: Want, enqueuedAt: number, over: Partial<Waiter> = {}): Waiter =>
  ({ id, holder: `h:${id}`, kind: "capture", want, enqueuedAt, expiresAt: T + 60_000, label: id, ...over });
const ledger = (leases: Lease[] = [], queue: Waiter[] = []): Ledger => ({ version: LEDGER_VERSION, leases, queue });

test("capture and maintain are exclusive with everything but a read beside a capture", () => {
  const kinds: LeaseKind[] = ["capture", "maintain", "read"];
  const shared = kinds.flatMap((a) => kinds.filter((b) => compatible(a, b)).map((b) => `${a}+${b}`)).sort();
  assert.deepEqual(shared, ["capture+read", "read+capture", "read+read"], "and nothing else is shared, in either direction");
});

test("a read is taken beside a capture and beside another read, and refused beside a maintain", () => {
  assert.equal(mayTakeNow(ledger([lease("c", "capture", ["w1"])]), "read", ["w1"]).taken, true);
  assert.equal(mayTakeNow(ledger([lease("r", "read", ["w1"])]), "read", ["w1"]).taken, true);
  const refused = mayTakeNow(ledger([lease("m", "maintain", ["w1"])]), "read", ["w1"]);
  assert.equal(refused.taken, false);
  assert.deepEqual(!refused.taken && refused.heldBy, { w1: ["h:m"] }, "it names who is in the way");
});

test("a capture or a maintain is refused beside any live lease on the box, and a read does not block a capture", () => {
  for (const kind of ["capture", "maintain"] as const) {
    assert.equal(mayTakeNow(ledger([lease("c", "capture", ["w1"])]), kind, ["w1"]).taken, false);
    assert.equal(mayTakeNow(ledger([lease("m", "maintain", ["w1"])]), kind, ["w1"]).taken, false);
  }
  assert.equal(mayTakeNow(ledger([lease("r", "read", ["w1"])]), "capture", ["w1"]).taken, true);
  assert.equal(mayTakeNow(ledger([lease("r", "read", ["w1"])]), "maintain", ["w1"]).taken, false, "a maintain does not land in the middle of a read");
});

test("a take is all the boxes or none, and names the holders of the ones that are in the way", () => {
  const taken = mayTakeNow(ledger([lease("c", "capture", ["w2"])]), "capture", ["w1", "w2", "w3"]);
  assert.equal(taken.taken, false);
  assert.deepEqual(!taken.taken && taken.heldBy, { w2: ["h:c"] });
});

test("the lease a holder already has does not block it taking again, which is how a holder renews or resumes", () => {
  assert.equal(mayTakeNow(ledger([lease("c", "capture", ["w1"])]), "capture", ["w1"], { exceptId: "c" }).taken, true);
});

test("a lease and a queue entry past their expiry are stale and ignored", () => {
  const stale = ledger([lease("old", "capture", ["w1"], T - 1), lease("edge", "capture", ["w2"], T)], [waiter("q", { named: ["w3"] }, 1, { expiresAt: T })]);
  const live = liveOf(stale, T);
  assert.deepEqual(live.leases, [], "expiresAt <= now is stale");
  assert.deepEqual(live.queue, []);
  assert.equal(mayTakeNow(live, "capture", ["w1", "w2"]).taken, true);
});

test("named waiters are served in the order they queued, and a later one cannot take a box an earlier one named", () => {
  const l = ledger([lease("c", "capture", ["w1"])], [waiter("a", { named: ["w1", "w2"] }, 1), waiter("b", { named: ["w2", "w3"] }, 2)]);
  assert.equal(availability(l, "a").grantable, false, "a waits for w1");
  const b = availability(l, "b");
  assert.equal(b.grantable, false, "b waits although w3 is free and w2 is not held: a reserved w2 first");
  assert.deepEqual(b.excluded, { w1: ["h:c", "h:a"], w2: ["h:a"] }, "w1 is held by c and reserved by a");
  assert.deepEqual(b.waitingOn, ["h:a"]);
});

test("a named waiter whose boxes nobody wants ahead of it is served at once, even while another waits", () => {
  const l = ledger([lease("c", "capture", ["w1"])], [waiter("a", { named: ["w1"] }, 1), waiter("b", { named: ["w3"] }, 2)]);
  assert.equal(availability(l, "b").grantable, true);
});

test("ties in enqueuedAt are broken by id", () => {
  const l = ledger([], [waiter("b", { named: ["w1"] }, 5), waiter("a", { named: ["w1"] }, 5)]);
  assert.equal(availability(l, "a").grantable, true);
  assert.equal(availability(l, "b").grantable, false);
  assert.deepEqual(placeOf(l, "b"), { place: 2, of: 2 });
});

test("a waiter for any N boxes holds the head of the line: nobody behind it is served while it waits", () => {
  const l = ledger([lease("c", "capture", ["w1"])], [waiter("big", { count: 3 }, 1), waiter("small", { named: ["w2"] }, 2), waiter("small2", { count: 1 }, 3)]);
  assert.equal(availability(l, "big").grantable, true, "it holds the turn; the caller finds it cannot choose 3 boxes yet");
  for (const id of ["small", "small2"]) {
    const a = availability(l, id);
    assert.equal(a.grantable, false, id);
    assert.match(a.reason ?? "", /h:big is ahead of it in the queue, waiting for 3 boxes/);
  }
});

test("a waiter for every ready box also holds the head of the line", () => {
  const l = ledger([], [waiter("all", { ready: true }, 1), waiter("one", { named: ["w1"] }, 2)]);
  assert.equal(availability(l, "one").grantable, false);
});

test("once the count waiter has taken its boxes the next waiter is served", () => {
  const l = ledger([lease("big", "capture", ["w1", "w2", "w3"])], [waiter("small", { named: ["w4"] }, 2)]);
  assert.equal(availability(l, "small").grantable, true);
});

test("a maintain waiter queues behind a capture waiter for the same box, and waits for a read too", () => {
  const l = ledger([lease("r", "read", ["w1"])], [waiter("job", { named: ["w1"] }, 1), waiter("freeze", { named: ["w1"] }, 2, { kind: "maintain" })]);
  assert.equal(availability(l, "job").grantable, true, "a capture is not blocked by a read");
  assert.equal(availability(l, "freeze").grantable, false);
});

test("mayTake refuses a named waiter other boxes than it named, and a box a lease holds", () => {
  const l = ledger([lease("c", "capture", ["w2"])], [waiter("n", { named: ["w1", "w2"] }, 1), waiter("any", { count: 2 }, 2)]);
  assert.match((mayTake(l, "n", ["w1"]) as { reason: string }).reason, /asked for w1, w2, not w1/);
  assert.equal(mayTake(l, "n", ["w1", "w2"]).taken, false);
  const l2 = ledger([lease("c", "capture", ["w2"])], [waiter("any", { count: 2 }, 1)]);
  assert.equal(mayTake(l2, "any", ["w2", "w3"]).taken, false, "a count waiter may take any boxes but a held one");
  assert.equal(mayTake(l2, "any", ["w3", "w4"]).taken, true);
});

test("respectQueue leaves alone a box a named waiter wants, and every box while a count waiter queues", () => {
  const named = ledger([], [waiter("n", { named: ["w1"] }, 1)]);
  assert.equal(mayTakeNow(named, "maintain", ["w1"], { respectQueue: true }).taken, false);
  assert.equal(mayTakeNow(named, "maintain", ["w2"], { respectQueue: true }).taken, true);
  const count = ledger([], [waiter("c", { count: 1 }, 1)]);
  assert.equal(mayTakeNow(count, "maintain", ["w2"], { respectQueue: true }).taken, false);
  assert.equal(mayTakeNow(count, "maintain", ["w2"]).taken, true, "a take that does not respect the queue ignores it (a resume)");
});
