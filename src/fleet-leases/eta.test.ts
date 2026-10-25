/**
 * THE ESTIMATED START OF A WAITER (A11-244): walked through the queue in order, and "unknown, and why" whenever an input is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateStart } from "./eta.ts";
import { LEDGER_VERSION } from "./types.ts";
import type { Lease, Ledger, Waiter, Want } from "./types.ts";

const NOW = 1_000_000;
const MIN = 60_000;
const lease = (id: string, boxes: string[], expectedEnd: number | null): Lease =>
  ({ id, holder: `h:${id}`, kind: "capture", boxes, label: id, takenAt: NOW, renewedAt: NOW, expiresAt: NOW + 5 * MIN, expectedEnd });
const waiter = (id: string, want: Want, enqueuedAt: number): Waiter =>
  ({ id, holder: `h:${id}`, kind: "capture", want, enqueuedAt, expiresAt: NOW + 5 * MIN, label: id });
const ledger = (leases: Lease[], queue: Waiter[]): Ledger => ({ version: LEDGER_VERSION, leases, queue });
const FLEET = ["w1", "w2", "w3", "w4"];
const estimate = (l: Ledger, waiterId: string, durationOf: (w: Waiter) => number | string = () => 10 * MIN) =>
  estimateStart({ ledger: l, now: NOW, waiterId, fleet: FLEET, durationOf });

test("a named waiter starts when the last of its boxes is expected free", () => {
  const l = ledger([lease("a", ["w1"], NOW + 3 * MIN), lease("b", ["w2"], NOW + 8 * MIN)], [waiter("q", { named: ["w1", "w2"] }, 1)]);
  assert.deepEqual(estimate(l, "q"), { estimatedStart: NOW + 8 * MIN, reason: null });
});

test("a box nobody holds is free now", () => {
  assert.deepEqual(estimate(ledger([], [waiter("q", { named: ["w1"] }, 1)]), "q"), { estimatedStart: NOW, reason: null });
});

test("a lease with no expected end makes the answer unknown, and names its holder", () => {
  const l = ledger([lease("a", ["w1"], null)], [waiter("q", { named: ["w1"] }, 1)]);
  assert.deepEqual(estimate(l, "q"), { estimatedStart: null, reason: "h:a has no expected end" });
});

test("a lease already past its expected end counts as free now, not in the past", () => {
  const l = ledger([lease("a", ["w1"], NOW - MIN)], [waiter("q", { named: ["w1"] }, 1)]);
  assert.equal(estimate(l, "q").estimatedStart, NOW);
});

test("an earlier waiter holds its boxes for its estimated length before the next can start on them", () => {
  const l = ledger([lease("a", ["w1"], NOW + 2 * MIN)], [waiter("first", { named: ["w1"] }, 1), waiter("second", { named: ["w1", "w2"] }, 2)]);
  assert.equal(estimate(l, "first").estimatedStart, NOW + 2 * MIN);
  assert.equal(estimate(l, "second", () => 10 * MIN).estimatedStart, NOW + 12 * MIN);
});

test("a waiter for any N boxes starts when the N-th box is free", () => {
  const l = ledger([lease("a", ["w1"], NOW + 5 * MIN), lease("b", ["w2"], NOW + 9 * MIN), lease("c", ["w3"], NOW + 20 * MIN)], [waiter("q", { count: 3 }, 1)]);
  assert.equal(estimate(l, "q").estimatedStart, NOW + 9 * MIN, "w4 is free now, w1 at 5, w2 at 9: the third is w2");
  assert.equal(estimate(ledger(l.leases, [waiter("q", { count: 2 }, 1)]), "q").estimatedStart, NOW + 5 * MIN, "w4 is free now, and w1 is the second to be free, at 5");
});

test("a count waiter's second box is the next to be free", () => {
  const l = ledger([lease("a", ["w1"], NOW + 5 * MIN), lease("b", ["w2"], NOW + 9 * MIN), lease("c", ["w3"], NOW + 20 * MIN), lease("d", ["w4"], NOW + 30 * MIN)], [waiter("q", { count: 2 }, 1)]);
  assert.equal(estimate(l, "q").estimatedStart, NOW + 9 * MIN);
});

test("a waiter behind a count waiter starts after the boxes the count waiter will hold", () => {
  const l = ledger([lease("a", ["w1"], NOW + 20 * MIN), lease("b", ["w2"], NOW + 20 * MIN), lease("c", ["w3"], NOW + 20 * MIN)], [waiter("big", { count: 4 }, 1), waiter("small", { named: ["w4"] }, 2)]);
  assert.equal(estimate(l, "big").estimatedStart, NOW + 20 * MIN);
  assert.equal(estimate(l, "small").estimatedStart, NOW + 30 * MIN, "w4 is free now, but the count waiter ahead takes it at 20 and holds it for 10");
});

test("an earlier waiter whose length is unknown makes the later estimate unknown, with its reason", () => {
  const l = ledger([], [waiter("first", { named: ["w1"] }, 1), waiter("second", { named: ["w1"] }, 2)]);
  const result = estimate(l, "second", (w) => w.id === "first" ? "h:first's length is not known" : 1);
  assert.deepEqual(result, { estimatedStart: null, reason: "h:first's length is not known" });
  assert.equal(estimate(l, "first", () => "unused").estimatedStart, NOW, "its own start does not depend on its own length");
});

test("a count with no inventory to choose from is unknown, and says so", () => {
  const result = estimateStart({ ledger: ledger([], [waiter("q", { count: 2 }, 1)]), now: NOW, waiterId: "q", fleet: [], durationOf: () => 1 });
  assert.equal(result.estimatedStart, null);
  assert.match(result.reason ?? "", /inventory could not be read/);
});

test("a read lease does not delay anyone's estimate, and a stale entry is not in the walk", () => {
  const read: Lease = { ...lease("r", ["w1"], null), kind: "read" };
  const stale: Waiter = { ...waiter("old", { named: ["w1"] }, 0), expiresAt: NOW };
  const l = ledger([read], [stale, waiter("q", { named: ["w1"] }, 1)]);
  assert.equal(estimate(l, "q").estimatedStart, NOW);
});

test("a waiter that is not queued has no estimate", () => {
  assert.equal(estimate(ledger([], []), "nobody").estimatedStart, null);
});
