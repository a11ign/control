/**
 * WHAT THE LEASE LEDGER HOLDS (A11-244, ADR `A11-244-adr-0001`). One JSON file on the control plane that every taker of a box reads and writes: the
 * fleet job service, the hourly drift check, the daily freeze and auto-off. Do not confuse a LEASE with screenreader-fleet's `leaseWorker`, which starts
 * a local VM and puts it back.
 */
export const LEDGER_VERSION = 1;

/** `capture` (a job) and `maintain` (the freeze, a shutdown) are exclusive; `read` (the drift check) is shared with `capture` and refused by `maintain`. */
export type LeaseKind = "capture" | "maintain" | "read";

/** The boxes a waiter asked for: these by name, any N, or every ready one. */
export type Want = { named: string[] } | { count: number } | { ready: true };

/** A holder's booking of boxes. It ends when it is released, or at `expiresAt`, which a live holder pushes out by renewing. Times are epoch milliseconds. */
export type Lease = {
  id: string;
  /** Who holds it, for example `fleet-jobs:<jobId>`, `fleet-freeze:<run>` or `fleet-drift:<run>`. */
  holder: string;
  kind: LeaseKind;
  boxes: string[];
  /** The job's label or the unit's name. */
  label: string;
  takenAt: number;
  renewedAt: number;
  expiresAt: number;
  /** When the holder expects to let go, or null when it cannot say. */
  expectedEnd: number | null;
};

/** A holder waiting for boxes. The queue is served in `enqueuedAt` order, with `id` breaking a tie. Only `capture` and `maintain` wait. */
export type Waiter = {
  id: string;
  holder: string;
  kind: Exclude<LeaseKind, "read">;
  want: Want;
  enqueuedAt: number;
  expiresAt: number;
  label: string;
};

export type Ledger = { version: typeof LEDGER_VERSION; leases: Lease[]; queue: Waiter[] };

export const emptyLedger = (): Ledger => ({ version: LEDGER_VERSION, leases: [], queue: [] });

/** How long a holder that has stopped renewing keeps its boxes: a restart of the job service (`RestartSec=5`) is back long before. */
export const LEASE_GRACE_MS = 5 * 60_000;
/** The job runner renews its lease and its queue entries this often. */
export const RENEW_EVERY_MS = 30_000;
