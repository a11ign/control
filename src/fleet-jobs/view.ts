import { SERVICE_CHECKOUT, STORE_DIR } from "./paths.ts";
import { formatDuration } from "./duration.ts";
import { captureCount, isFactsJob, isTerminal } from "./types.ts";
import type { CaptureEntry, JobRequest, JobState, JobStateFile } from "./types.ts";

export type ServiceBeat = { pid: number; commit: string; startedAt: string; heartbeatAt: string };

/** A beat older than this is a service that is not running. The service writes one every 5 s. */
export const HEARTBEAT_STALE_MS = 30_000;

export type BoxProgress = { box: string; done: number; failed: number; total: number };

/** A queued job's standing in the lease queue. `estimatedStart` is null, with `estimateReason`, when an input to the estimate is missing. */
export type QueueView = { place: number | null; of: number; estimatedStart: string | null; estimateReason: string | null; waitingOn: string[] };

export type JobView = {
  id: string;
  label: string;
  state: JobState;
  reason: string | null;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  pages: number;
  passes: number;
  /** The number of cases of a case job, or null for a page job. */
  cases: number | null;
  /** `"facts"` for a job that reads boxes' hardware: its entries are reads, not captures. */
  kind: "facts" | null;
  recaptureOf: string | null;
  total: number;
  done: number;
  failed: number;
  /** Captures skipped because their group's `skipWhen` matched; they count as done. */
  skipped: number;
  remaining: number;
  boxes: BoxProgress[];
  failedCaptures: { page: string; pass: number; case: string | null; box: string; httpStatus: number | null; error: string | null }[];
  dropped: { box: string; reason: string }[];
  estimatedFinish: string | null;
  estimate: string;
  /** Where the job stands in the queue for its boxes, or null when it is not waiting for any. */
  queue: QueueView | null;
  results: { location: string; fetch: string };
  service: (ServiceBeat & { alive: boolean }) | null;
};

const finished = (c: CaptureEntry): boolean => c.status === "done" || c.status === "failed" || c.status === "skipped";
const duration = (c: CaptureEntry): number | null =>
  c.startedAt && c.finishedAt ? Date.parse(c.finishedAt) - Date.parse(c.startedAt) : null;
const mean = (values: number[]): number | null => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/**
 * When the job should end: for each box, its unfinished captures times the mean duration of the captures that box has finished in THIS job (the
 * job's overall mean for a box that has finished none), and the latest box decides. `null` until a first capture has ended, because a guess
 * from nothing would read as a promise. PURE.
 */
export function estimateFinish(captures: CaptureEntry[], now: number): number | null {
  const jobMean = mean(captures.map(duration).filter((ms): ms is number => ms !== null));
  if (jobMean === null) return null;
  const boxes = [...new Set(captures.map((c) => c.box))];
  const eta = boxes.map((box) => {
    const mine = captures.filter((c) => c.box === box);
    const own = mean(mine.map(duration).filter((ms): ms is number => ms !== null));
    return mine.filter((c) => !finished(c)).length * (own ?? jobMean);
  });
  return now + Math.max(0, ...eta);
}

export const resultsLocation = (id: string, storeDir: string = STORE_DIR): string => `control:${storeDir}/${id}/results`;

const boxProgress = (captures: CaptureEntry[]): BoxProgress[] => [...new Set(captures.map((c) => c.box))].map((box) => {
  const mine = captures.filter((c) => c.box === box);
  return { box, done: mine.filter(finished).length, failed: mine.filter((c) => c.status === "failed").length, total: mine.length };
});

/** The estimate as `status` states it: nothing once the job has ended, "unknown" before a first capture has, otherwise a time. */
const estimateText = (ended: boolean, eta: number | null): string =>
  ended ? "ended" : eta === null ? "unknown until the first capture ends" : new Date(eta).toISOString();

const failedCapturesOf = (captures: CaptureEntry[]): JobView["failedCaptures"] => captures.filter((c) => c.status === "failed").map((c) => ({
  page: c.page, pass: c.pass, case: c.case ?? null, box: c.box, httpStatus: c.httpStatus ?? null, error: c.error ?? null }));

const serviceOf = (beat: ServiceBeat | null, now: number): JobView["service"] =>
  beat ? { ...beat, alive: now - Date.parse(beat.heartbeatAt) < HEARTBEAT_STALE_MS } : null;

/** What a job with no `state.json` has: nothing done, nothing started. */
const NOT_STARTED = { state: "queued" as const, reason: null, captures: [] as CaptureEntry[], dropped: [] as { box: string; reason: string }[], startedAt: null, finishedAt: null };

const reasonOf = (reason: string | null | undefined, jobState: JobState, cancelled: boolean): string | null =>
  reason ?? (jobState === "queued" && cancelled ? "cancel requested" : null);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** One job as `status` shows it. PURE given what the store held. */
export function viewJob({ request, state, cancelled, beat, now, storeDir = STORE_DIR, queue = null }: {
  request: JobRequest; state: JobStateFile | null; cancelled: boolean; beat: ServiceBeat | null; now: number; storeDir?: string; queue?: QueueView | null;
}): JobView {
  const { state: jobState, reason, captures, dropped, startedAt, finishedAt } = state ?? NOT_STARTED;
  const total = captures.length || captureCount(request);
  const ended = captures.filter(finished).length;
  const eta = isTerminal(jobState) ? null : estimateFinish(captures, now);
  return {
    id: request.id, label: request.label, state: jobState, reason: reasonOf(reason, jobState, cancelled),
    submittedAt: request.submittedAt, startedAt, finishedAt: finishedAt ?? null,
    pages: request.pages.length, passes: request.passes, cases: request.cases?.length ?? null, kind: isFactsJob(request) ? "facts" : null, recaptureOf: request.recaptureOf ?? null,
    total, done: ended, failed: captures.filter((c) => c.status === "failed").length, skipped: captures.filter((c) => c.status === "skipped").length, remaining: total - ended,
    boxes: boxProgress(captures),
    failedCaptures: failedCapturesOf(captures),
    dropped,
    estimatedFinish: isoOrNull(eta),
    estimate: estimateText(isTerminal(jobState), eta),
    queue: jobState === "queued" && !cancelled ? queue : null,
    results: { location: resultsLocation(request.id, storeDir), fetch: `fleet job fetch ${request.id} --to <dir>` },
    service: serviceOf(beat, now),
  };
}

/** What a queued job shows: its place, when it should start, and who it waits on. */
export function queueLines(queue: QueueView | null): string[] {
  if (!queue) return [];
  const start = queue.estimatedStart ?? `unknown (${queue.estimateReason ?? "no reason given"})`;
  return [
    `place: ${queue.place ?? "?"} of ${queue.of}`,
    `estimated start: ${start}`,
    ...(queue.waitingOn.length ? [`waiting on: ${queue.waitingOn.join(", ")}`] : []),
  ];
}

/** What a job's entries are called: a facts job reads boxes, the others capture pages. */
export const entryNoun = (view: Pick<JobView, "kind">): string => view.kind === "facts" ? "reads" : "captures";

const shapeOf = (view: JobView): string =>
  view.kind === "facts" ? `${view.total} ${view.total === 1 ? "box" : "boxes"}` : view.cases !== null ? `${view.cases} ${view.cases === 1 ? "case" : "cases"}` : `${view.pages} pages x ${view.passes} ${view.passes === 1 ? "pass" : "passes"}`;

const failedWhat = (view: JobView, f: JobView["failedCaptures"][number]): string =>
  view.kind === "facts" ? "the read" : f.case !== null ? `case ${f.case} (${f.page})` : `${f.page} pass ${f.pass}`;

/** The lines `fleet job status` prints (and `wait` prints on a timeout). */
export function renderView(view: JobView): string[] {
  const lines = [
    `${view.id}  ${view.state}${view.reason ? ` (${view.reason})` : ""}  label ${view.label}`,
    ...queueLines(view.queue),
    `${entryNoun(view)}: ${view.done} of ${view.total} done${view.failed ? `, ${view.failed} failed` : ""}${view.skipped ? `, ${view.skipped} skipped` : ""}, ${view.remaining} left  (${shapeOf(view)})`,
    ...(view.recaptureOf ? [`re-capture of: ${view.recaptureOf}`] : []),
    ...view.boxes.map((b) => `  ${b.box}: ${b.done}/${b.total}${b.failed ? ` (${b.failed} failed)` : ""}`),
    ...view.dropped.map((d) => `  dropped ${d.box}: ${d.reason}`),
    `estimated finish: ${view.estimate}`,
    `results: ${view.results.location}  (${view.results.fetch})`,
  ];
  if (view.failedCaptures.length) {
    lines.push("failed captures:", ...view.failedCaptures.slice(0, 20).map((f) =>
      `  ${failedWhat(view, f)} on ${f.box}: ${f.error ?? `HTTP ${f.httpStatus}`}`));
    if (view.failedCaptures.length > 20) lines.push(`  ... and ${view.failedCaptures.length - 20} more (status --json lists all)`);
  }
  lines.push(view.service
    ? `service: ${view.service.alive ? "running" : "NOT RUNNING"}, commit ${view.service.commit.slice(0, 10)}, last beat ${view.service.heartbeatAt}`
    : `service: no heartbeat found (${SERVICE_CHECKOUT})`);
  return lines;
}

/** `what is left` for a timeout: the unfinished pages, per box, and how long the estimate says. */
export function leftLines(view: JobView, now: number): string[] {
  const left = view.boxes.filter((b) => b.done < b.total).map((b) => `${b.box} has ${b.total - b.done} of ${b.total} left`);
  const eta = view.estimatedFinish ? `, estimated to end in ${formatDuration(Date.parse(view.estimatedFinish) - now)}` : "";
  return [`${view.remaining} of ${view.total} ${entryNoun(view)} are left${eta}`, ...left];
}
