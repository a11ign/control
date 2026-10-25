import { estimateStart } from "../fleet-leases/eta.ts";
import { availability, placeOf } from "../fleet-leases/grant.ts";
import type { Estimate } from "../fleet-leases/eta.ts";
import type { LeaseLedger } from "../fleet-leases/ledger.ts";
import type { Waiter } from "../fleet-leases/types.ts";
import { holderOf } from "./claims.ts";
import type { JobStore } from "./store.ts";
import type { QueueView } from "./view.ts";

/**
 * WHERE A QUEUED JOB STANDS AND WHEN IT SHOULD START (A11-244), for `fleet job status` and `fleet lease list`. The ledger says who holds what and in
 * what order; the job store says how long a job is likely to hold its boxes. An estimate with an input missing is `unknown` and says which.
 */

/** How many of the most recent completed captures the mean is taken over. */
export const MEAN_OVER = 20;

/** A scheduled unit that waits for a box (the freeze, a shutdown) is assumed to hold it this long: it has no history of its own. */
export const MAINTAIN_ASSUMED_MS = 10 * 60_000;

/** The mean duration of the service's last `MEAN_OVER` completed captures, or null when it has completed none. */
export function meanCaptureMs(store: JobStore): number | null {
  const durations: number[] = [];
  for (const id of store.list().reverse()) {
    const state = store.readState(id);
    if (!state?.ok) continue;
    for (const c of [...state.value.captures].reverse()) {
      const took = c.status === "done" && c.startedAt && c.finishedAt ? Date.parse(c.finishedAt) - Date.parse(c.startedAt) : NaN;
      if (Number.isFinite(took) && took >= 0) durations.push(took);
    }
    if (durations.length >= MEAN_OVER) break;
  }
  const last = durations.slice(0, MEAN_OVER);
  return last.length ? last.reduce((a, b) => a + b, 0) / last.length : null;
}

/** How long a waiter will hold its boxes: ⌈pages × passes ÷ boxes⌉ × the mean capture, or why that is not known. */
export function durationOf(store: JobStore, mean: number | null): (waiter: Waiter) => number | string {
  return (waiter) => {
    if (waiter.kind === "maintain") return MAINTAIN_ASSUMED_MS;
    const request = store.readRequest(waiter.id);
    if (!request?.ok || waiter.holder !== holderOf(waiter.id)) return `${waiter.holder}'s length is not known`;
    if (mean === null) return "no capture has completed yet, so how long a job holds its boxes is not known";
    const { pages, passes } = request.value;
    const boxes = "named" in waiter.want ? waiter.want.named.length : "count" in waiter.want ? waiter.want.count : null;
    return boxes === null ? `${waiter.holder} asks for every ready box, so how long it holds them is not known` : Math.ceil(pages.length * passes / boxes) * mean;
  };
}

export type QueueDeps = { ledger: LeaseLedger; store: JobStore; now: number; fleet: string[] };

/** The estimate for a waiter, from the live ledger. */
export function estimateFor(deps: QueueDeps, waiterId: string): Estimate {
  const read = deps.ledger.live();
  if (!read.ok) return { estimatedStart: null, reason: read.reason };
  return estimateStart({ ledger: read.ledger, now: deps.now, waiterId, fleet: deps.fleet, durationOf: durationOf(deps.store, meanCaptureMs(deps.store)) });
}

/** A queued job's standing: its place, the estimated start, and who it waits on. `null` when the job is not in the queue. */
export function queueViewOf(deps: QueueDeps, jobId: string): QueueView | null {
  const read = deps.ledger.live();
  if (!read.ok) return { place: null, of: 0, estimatedStart: null, estimateReason: read.reason, waitingOn: [] };
  const place = placeOf(read.ledger, jobId);
  if (!place) return null;
  const estimate = estimateFor(deps, jobId);
  return {
    ...place, estimatedStart: estimate.estimatedStart === null ? null : new Date(estimate.estimatedStart).toISOString(), estimateReason: estimate.reason,
    waitingOn: availability(read.ledger, jobId).waitingOn,
  };
}
