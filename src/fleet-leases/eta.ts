import { inOrder, isLive } from "./grant.ts";
import type { Ledger, Waiter } from "./types.ts";

/**
 * WHEN A WAITER SHOULD START, PURE (A11-244). The queue is walked in order: each earlier waiter starts when its boxes are free, and then holds them for
 * its estimated duration. A time is a number of milliseconds; a string is an UNKNOWN and says why, so an input that is missing reads as "unknown
 * (reason)" and never as a guess that looks like a promise.
 */
export type When = number | string;

export type Estimate = { estimatedStart: number | null; reason: string | null };

const known = (when: When): when is number => typeof when === "number";

/** The latest of the times, or the first unknown among them. */
function latest(whens: When[]): When {
  const unknown = whens.find((w) => !known(w));
  return unknown ?? Math.max(...(whens as number[]));
}

/** The `n`-th earliest of the times (an unknown sorts last), or the unknown that stands in the way. */
function nthEarliest(whens: [string, When][], n: number): { when: When; boxes: string[] } {
  const sorted = [...whens].sort(([, a], [, b]) => (known(a) ? a : Infinity) - (known(b) ? b : Infinity));
  const chosen = sorted.slice(0, n);
  return { when: latest(chosen.map(([, when]) => when)), boxes: chosen.map(([box]) => box) };
}

export type EtaInput = {
  ledger: Ledger;
  now: number;
  waiterId: string;
  /** Every box in the inventory, for a count to be chosen from. Empty when it could not be read. */
  fleet: string[];
  /** How long a waiter will hold its boxes, or why that is not known. */
  durationOf: (waiter: Waiter) => number | string;
};

function freeTimes(ledger: Ledger, now: number, fleet: string[]): Map<string, When> {
  const free = new Map<string, When>(fleet.map((box) => [box, now]));
  for (const lease of ledger.leases) {
    if (lease.kind === "read") continue;
    for (const box of lease.boxes) {
      const end: When = lease.expectedEnd === null ? `${lease.holder} has no expected end` : Math.max(now, lease.expectedEnd);
      const before = free.get(box);
      free.set(box, before === undefined ? end : latest([before, end]));
    }
  }
  return free;
}

const sizeOf = (waiter: Waiter): number | null => "named" in waiter.want ? waiter.want.named.length : "count" in waiter.want ? waiter.want.count : null;

/** The estimated start of `waiterId`, from the live leases' `expectedEnd` and the earlier waiters' estimated durations. */
export function estimateStart({ ledger, now, waiterId, fleet, durationOf }: EtaInput): Estimate {
  const live = { ...ledger, leases: ledger.leases.filter((l) => isLive(l, now)), queue: ledger.queue.filter((w) => isLive(w, now)) };
  const free = freeTimes(live, now, fleet);
  for (const waiter of inOrder(live.queue)) {
    const start = startOf(waiter, free, now);
    if (waiter.id === waiterId) return known(start) ? { estimatedStart: start, reason: null } : { estimatedStart: null, reason: start };
    hold(waiter, start, durationOf(waiter), free);
  }
  return { estimatedStart: null, reason: `${waiterId} is not queued` };
}

function startOf(waiter: Waiter, free: Map<string, When>, now: number): When {
  const want = waiter.want;
  let start: When;
  if ("named" in want) start = latest(want.named.map((box) => free.get(box) ?? now));
  else if (free.size === 0) start = "the inventory could not be read, so the boxes a count can use are not known";
  else start = nthEarliest([...free], "count" in want ? want.count : 1).when;
  return start;
}

/** After a waiter starts, its boxes are busy until it ends, or unknown when its start or its length is. */
function hold(waiter: Waiter, start: When, duration: number | string, free: Map<string, When>): void {
  const want = waiter.want;
  const boxes = "named" in want ? want.named : nthEarliest([...free], sizeOf(waiter) ?? 1).boxes;
  const end: When = !known(start) ? start : typeof duration === "string" ? duration : start + duration;
  for (const box of boxes) free.set(box, end);
}
