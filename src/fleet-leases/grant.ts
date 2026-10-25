import type { Lease, LeaseKind, Ledger, Waiter } from "./types.ts";

/**
 * THE RULES OF BOOKING, PURE (A11-244). Every rule is here and every one is tested here; the ledger only reads the file, calls these under its mutex,
 * and writes the answer.
 *
 * COMPATIBILITY. `capture` and `maintain` are exclusive. `read` is shared with `read` and with `capture`, and refused beside `maintain`.
 * EXPIRY. A lease or a queue entry whose `expiresAt` has passed is STALE: it is ignored when deciding and dropped at the next write.
 * FAIRNESS. The queue is served in `enqueuedAt` order. A waiter for named boxes reserves only those boxes against the waiters behind it. A waiter for
 * "any N" or "every ready" box holds up everything behind it while it waits (head of line), so a large job is never starved by a stream of small ones.
 */

export function compatible(a: LeaseKind, b: LeaseKind): boolean {
  if (a === "read") return b !== "maintain";
  return a === "capture" && b === "read";
}

export const isLive = (entry: { expiresAt: number }, now: number): boolean => entry.expiresAt > now;

/** The ledger as it stands at `now`: stale leases and stale queue entries are not in it. */
export function liveOf(ledger: Ledger, now: number): Ledger {
  return { ...ledger, leases: ledger.leases.filter((l) => isLive(l, now)), queue: ledger.queue.filter((w) => isLive(w, now)) };
}

const byTurn = (a: Waiter, b: Waiter): number => a.enqueuedAt - b.enqueuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The waiters in the order they are served. */
export const inOrder = (queue: Waiter[]): Waiter[] => [...queue].sort(byTurn);

const isNamed = (w: Waiter): w is Waiter & { want: { named: string[] } } => "named" in w.want;

/** The live leases on `box` that a lease of `kind` cannot share it with, other than the one `exceptId` holds. */
export function blockers(ledger: Ledger, box: string, kind: LeaseKind, exceptId?: string): Lease[] {
  return ledger.leases.filter((l) => l.id !== exceptId && l.boxes.includes(box) && !compatible(l.kind, kind));
}

export type Availability = {
  /** Whether the waiter may take boxes now: for named boxes, all of them are free; for a count or `ready`, it has the head of the line. */
  grantable: boolean;
  /** Boxes it cannot have now, and the holders in the way (a lease's holder, or the earlier waiter that reserved the box). */
  excluded: Record<string, string[]>;
  /** Every holder the waiter is waiting on, in the order it would meet them. */
  waitingOn: string[];
  /** Why it is not grantable, in words. */
  reason: string | null;
};

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * What a queued waiter can have right now. `ledger` must already be live (`liveOf`). The waiter is looked up by `id`; one that is not queued is a
 * caller's mistake and reads as not grantable.
 */
export function availability(ledger: Ledger, waiterId: string): Availability {
  const queue = inOrder(ledger.queue);
  const at = queue.findIndex((w) => w.id === waiterId);
  if (at < 0) return { grantable: false, excluded: {}, waitingOn: [], reason: `${waiterId} is not in the queue` };
  const waiter = queue[at]!;
  const earlier = queue.slice(0, at);

  const excluded: Record<string, string[]> = {};
  const exclude = (box: string, holder: string): void => { excluded[box] = unique([...(excluded[box] ?? []), holder]); };
  for (const lease of ledger.leases) {
    if (lease.id !== waiter.id && !compatible(lease.kind, waiter.kind)) for (const box of lease.boxes) exclude(box, lease.holder);
  }
  for (const before of earlier) if (isNamed(before)) for (const box of before.want.named) exclude(box, before.holder);

  const head = earlier.find((w) => !isNamed(w));
  if (head) {
    return { grantable: false, excluded, waitingOn: unique([head.holder, ...Object.values(excluded).flat()]),
      reason: `${head.holder} is ahead of it in the queue, waiting for ${"count" in head.want ? `${head.want.count} boxes` : "every ready box"}` };
  }
  if (isNamed(waiter)) {
    const stuck = waiter.want.named.filter((box) => excluded[box]);
    if (stuck.length) {
      return { grantable: false, excluded, waitingOn: unique(stuck.flatMap((box) => excluded[box]!)),
        reason: stuck.map((box) => `${box} is held by ${excluded[box]!.join(", ")}`).join("; ") };
    }
  }
  return { grantable: true, excluded, waitingOn: [], reason: null };
}

/** A waiter's place, counting from 1, and how many wait. `null` for one that is not in the live queue. */
export function placeOf(ledger: Ledger, waiterId: string): { place: number; of: number } | null {
  const queue = inOrder(ledger.queue);
  const at = queue.findIndex((w) => w.id === waiterId);
  return at < 0 ? null : { place: at + 1, of: queue.length };
}

export type Taking = { taken: true } | { taken: false; heldBy: Record<string, string[]>; reason: string };

/**
 * Whether `waiterId` may take exactly `boxes` now. All of them or none: when none, the answer names who is in the way. A named waiter must take the
 * boxes it named, and a count or `ready` waiter any boxes it is not excluded from.
 */
export function mayTake(ledger: Ledger, waiterId: string, boxes: string[]): Taking {
  const waiter = ledger.queue.find((w) => w.id === waiterId);
  const a = availability(ledger, waiterId);
  if (!waiter) return { taken: false, heldBy: {}, reason: a.reason ?? "not queued" };
  if (isNamed(waiter) && (boxes.length !== waiter.want.named.length || !waiter.want.named.every((box) => boxes.includes(box)))) {
    return { taken: false, heldBy: {}, reason: `${waiter.holder} asked for ${waiter.want.named.join(", ")}, not ${boxes.join(", ")}` };
  }
  const stuck = boxes.filter((box) => a.excluded[box]);
  if (!a.grantable) return { taken: false, heldBy: Object.fromEntries(stuck.map((box) => [box, a.excluded[box]!])), reason: a.reason ?? "not grantable" };
  if (stuck.length) {
    return { taken: false, heldBy: Object.fromEntries(stuck.map((box) => [box, a.excluded[box]!])), reason: stuck.map((box) => `${box} is held by ${a.excluded[box]!.join(", ")}`).join("; ") };
  }
  return { taken: true };
}

/** The holders of the waiters that may use `box`: those that named it, and every count or `ready` waiter. */
const queuedFor = (ledger: Ledger, box: string, exceptId?: string): string[] =>
  ledger.queue.filter((w) => w.id !== exceptId && (!isNamed(w) || w.want.named.includes(box))).map((w) => w.holder);

/**
 * A take that does not queue: the box is free of incompatible live leases now, or it is not taken. `respectQueue` also leaves alone a box an
 * earlier waiter named, and every box while a count or `ready` waiter is queued, because that waiter may use any of them. The lease `exceptId` holds
 * already does not count, so taking again renews.
 */
export function mayTakeNow(ledger: Ledger, kind: LeaseKind, boxes: string[], { exceptId, respectQueue = false }: { exceptId?: string; respectQueue?: boolean } = {}): Taking {
  const heldBy: Record<string, string[]> = {};
  for (const box of boxes) {
    const holders = [...blockers(ledger, box, kind, exceptId).map((l) => l.holder), ...(respectQueue ? queuedFor(ledger, box, exceptId) : [])];
    if (holders.length) heldBy[box] = unique(holders);
  }
  const stuck = Object.keys(heldBy);
  return stuck.length ? { taken: false, heldBy, reason: stuck.map((box) => `${box} is held by ${heldBy[box]!.join(", ")}`).join("; ") } : { taken: true };
}
