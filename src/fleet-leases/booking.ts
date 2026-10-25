import { LeaseLedger } from "./ledger.ts";
import { ledgerDirFromEnv, ledgerPathIn } from "./paths.ts";
import type { Lease, Ledger } from "./types.ts";

/**
 * HOW THE SCHEDULED WORK BOOKS BOXES (A11-244, step 2). The hourly drift check, the daily freeze and the idle power-off each run on a timer, on the control
 * plane, and each takes the same ledger the job service does. The rules live in `grant.ts`; this is the three takers' shared vocabulary over them.
 */
export const ledgerOnThisHost = (log: (line: string) => void = () => {}): LeaseLedger =>
  new LeaseLedger(ledgerPathIn(ledgerDirFromEnv()), { log });

/** How long the drift check's `read` lease lasts if the check dies before it lets go. A reading of fifteen boxes takes seconds. */
export const READ_LEASE_MS = 10 * 60_000;

export type ReadBooking = {
  /** The boxes the check may ask: every box no `maintain` lease holds. */
  readable: string[];
  /** Box -> why it is not read this time: `under maintenance by <holder>`. */
  skipped: Record<string, string>;
  /**
   * Set when the ledger could not be read or locked. A read grants nothing exclusive and conflicts with a capture never, so a check that goes blind
   * because its bookkeeping is broken is the worse failure: every box is then read, and the caller says why.
   */
  unbooked: string | null;
  release: () => void;
};

/**
 * Take a shared `read` lease on every box that no `maintain` lease holds. It never queues and never waits: a box under maintenance is named and skipped,
 * and the rest are taken in the same call. The lease is all-or-none per call, so a box that a `maintain` took in between is dropped and the take retried.
 */
export function bookReads(ledger: LeaseLedger, { id, holder, label, boxes, ttlMs = READ_LEASE_MS }: { id: string; holder: string; label: string; boxes: string[]; ttlMs?: number }): ReadBooking {
  const skipped: Record<string, string> = {};
  let wanted = [...boxes];
  while (wanted.length > 0) {
    const attempt = tryTake(ledger, { id, holder, label, boxes: wanted, ttlMs, kind: "read" });
    if (attempt.taken) return { readable: wanted, skipped, unbooked: null, release: () => ledger.releaseAll(id) };
    const blocked = Object.keys(attempt.heldBy).filter((box) => wanted.includes(box));
    if (blocked.length === 0) return { readable: boxes.filter((box) => !(box in skipped)), skipped, unbooked: attempt.reason, release: () => {} };
    for (const box of blocked) skipped[box] = `under maintenance by ${attempt.heldBy[box]!.join(", ")}`;
    wanted = wanted.filter((box) => !blocked.includes(box));
  }
  return { readable: [], skipped, unbooked: null, release: () => {} };
}

/** A take that a locked or unreadable ledger refuses instead of throwing: every caller here reads "not now" the same way. */
export function tryTake(ledger: LeaseLedger, spec: Parameters<LeaseLedger["tryTake"]>[0]): ReturnType<LeaseLedger["tryTake"]> {
  try {
    return ledger.tryTake(spec);
  } catch (cause) {
    return { taken: false, heldBy: {}, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

const booksBox = (lease: Lease, box: string): boolean => lease.boxes.includes(box) && (lease.kind === "capture" || lease.kind === "maintain");

export type Signals = {
  /** True while a waiter asked for "any N" or every ready box: it may wake and use any box, so no box may be powered off under it. */
  batchQueued: boolean;
  /** Whether `box` is under a live `capture` or `maintain` lease, or a queued waiter named it. */
  leasePending: (box: string) => boolean;
  /** Set when the ledger could not be read: then every box reads as booked. */
  unreadable: string | null;
};

/** The booking signals auto-off decides from, out of one reading of the ledger. An unreadable ledger books every box (a file nobody can read proves nothing). */
export function signalsOf(ledger: LeaseLedger): Signals {
  const read = ledger.live();
  if (!read.ok) return { batchQueued: true, leasePending: () => true, unreadable: read.reason };
  return signalsFrom(read.ledger);
}

export function signalsFrom(ledger: Ledger): Signals {
  const named = new Set(ledger.queue.flatMap((waiter) => ("named" in waiter.want ? waiter.want.named : [])));
  return {
    batchQueued: ledger.queue.some((waiter) => !("named" in waiter.want)),
    leasePending: (box) => named.has(box) || ledger.leases.some((lease) => booksBox(lease, box)),
    unreadable: null,
  };
}

export type ShutdownLease = { held: true; release: () => void } | { held: false; why: string };

/**
 * The lease auto-off holds across one `sleep.yml` dispatch: an exclusive `maintain` on the box, taken without queueing, leaving alone a box a waiter named
 * and every box while a count waiter is queued. It closes the gap between the decision (read a moment ago) and the shutdown. Not taken: the box is kept.
 */
export function bookShutdown(ledger: LeaseLedger, box: string, { holder, ttlMs }: { holder: string; ttlMs: number }): ShutdownLease {
  const id = `${holder}:${box}`;
  const took = tryTake(ledger, { id, holder, kind: "maintain", label: "fleet-auto-off", boxes: [box], ttlMs, respectQueue: true });
  return took.taken ? { held: true, release: () => ledger.releaseAll(id) } : { held: false, why: took.reason };
}
