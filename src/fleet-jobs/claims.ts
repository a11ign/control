import { LEASE_GRACE_MS } from "../fleet-leases/types.ts";
import type { LeaseLedger } from "../fleet-leases/ledger.ts";
import type { BoxRequest, JobRequest } from "./types.ts";

/**
 * A JOB'S BOXES, BOOKED THROUGH THE LEASE LEDGER (A11-244, ADR `A11-244-adr-0001`). The worker refuses a second capture (`429 a capture is already in
 * progress`), so two jobs must never hold one box; and the drift check, the daily freeze and auto-off act on boxes from the same control plane, so the
 * booking is one ledger they all read, not a claim only this service sees. A job is a `capture` lease; its id is the job ID and its holder is
 * `fleet-jobs:<job ID>`.
 */
export const holderOf = (jobId: string): string => `fleet-jobs:${jobId}`;

const wantOf = (boxes: BoxRequest) =>
  boxes.kind === "named" ? { named: boxes.names } : boxes.kind === "count" ? { count: boxes.count } : { ready: true as const };

export type Standing = { place: number; of: number };

export type Availability = {
  /** Whether the job holds the turn for the boxes it needs. */
  grantable: boolean;
  /** Boxes it cannot have now (held, or reserved by a job ahead of it), and who is in the way. */
  excluded: Record<string, string[]>;
  waitingOn: string[];
  reason: string | null;
};

export interface BoxClaims {
  /** Join the queue at the job's submission time, so a restart keeps every job's place. Asking again changes nothing but the entry's expiry. */
  enqueue(job: Pick<JobRequest, "id" | "label" | "boxes" | "submittedAt">): void;
  availability(jobId: string): Availability;
  /** Take exactly these boxes for a queued job, or none: the answer names who is in the way. */
  take(jobId: string, boxes: string[]): { claimed: true } | { claimed: false; heldBy: Record<string, string[]> };
  /** Take a running job's boxes again after a restart, without queueing. The same holder's lease is replaced. */
  retake(job: Pick<JobRequest, "id" | "label">, boxes: string[]): { claimed: true } | { claimed: false; heldBy: Record<string, string[]> };
  releaseBoxes(jobId: string, boxes: string[]): void;
  /** Let go of the job's lease and queue entry: the job is done, failed or cancelled. */
  release(jobId: string): void;
  /** The job is alive: push its lease or queue entry out by the grace period, and say when it expects to end. */
  renew(jobId: string, expectedEnd: number | null): void;
  place(jobId: string): Standing | null;
  /** Whether the job still holds a live lease. */
  holds(jobId: string): boolean;
}

export function ledgerClaims(ledger: LeaseLedger, { graceMs = LEASE_GRACE_MS }: { graceMs?: number } = {}): BoxClaims {
  return {
    enqueue: (job) => ledger.enqueue({ id: job.id, holder: holderOf(job.id), kind: "capture", label: job.label, want: wantOf(job.boxes),
      enqueuedAt: Date.parse(job.submittedAt), ttlMs: graceMs }),
    availability: (jobId) => ledger.grantable(jobId),
    take(jobId, boxes) {
      const took = ledger.take(jobId, boxes, { ttlMs: graceMs });
      return took.taken ? { claimed: true } : { claimed: false, heldBy: took.heldBy };
    },
    retake(job, boxes) {
      const took = ledger.tryTake({ id: job.id, holder: holderOf(job.id), kind: "capture", label: job.label, boxes, ttlMs: graceMs });
      return took.taken ? { claimed: true } : { claimed: false, heldBy: took.heldBy };
    },
    releaseBoxes: (jobId, boxes) => ledger.releaseBoxes(jobId, boxes),
    release: (jobId) => ledger.releaseAll(jobId),
    renew: (jobId, expectedEnd) => ledger.renew(jobId, { ttlMs: graceMs, expectedEnd }),
    place: (jobId) => ledger.place(jobId),
    holds: (jobId) => ledger.leaseOf(jobId) !== null,
  };
}
