/** What a fleet job is on disk. Every file carries `version`; a version this code does not know fails the job and is never guessed at. */
export const STORE_VERSION = 1;
/** A job of cases, or a re-capture, is written as version 2: a service that reads only version 1 fails it by name and never captures its URLs as plain pages. */
export const CASE_STORE_VERSION = 2;
export type StoreVersion = typeof STORE_VERSION | typeof CASE_STORE_VERSION;
export const READABLE_VERSIONS: readonly number[] = [STORE_VERSION, CASE_STORE_VERSION];

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export const TERMINAL_STATES: readonly JobState[] = ["done", "failed", "cancelled"];
export const isTerminal = (state: JobState): boolean => TERMINAL_STATES.includes(state);

/** The boxes a job asked for: a number of them, every ready one, or these by name. */
export type BoxRequest = { kind: "count"; count: number } | { kind: "ready" } | { kind: "named"; names: string[] };

/** A freeze reference as `make_freeze.py` writes it; only the two fields the manifest names are required. */
export type Freeze = { commit: string; namedAt: string; [field: string]: unknown };

/**
 * One capture of a case job: its own URL, the worker's `/capture` body sent exactly (nothing is merged in), and the group that holds it to one box.
 * `attempt` is 1 unless the case was re-captured from an earlier job.
 */
export type CaseSpec = { id: string; url: string; body: Record<string, unknown>; group?: string; attempt?: number };

/** What a group asks of the service. `box` is set only by a re-capture, which pins the group to the box it was captured on. */
export type GroupSpec = {
  /** Skip the group when every named `/health` environment field reads as given on its box (an absent field reads as null). */
  skipWhen?: { environment: Record<string, unknown> };
  box?: string;
};

/** `request.json`: written once by `submit`, never again. A job of `cases` has no pages, one pass and an empty body. */
export type JobRequest = {
  version: StoreVersion;
  id: string;
  label: string;
  pages: string[];
  boxes: BoxRequest;
  passes: number;
  /** The worker's own `/capture` body, minus `url` and `captureId`, which are the service's. */
  body: Record<string, unknown>;
  freeze: Freeze | null;
  submittedBy: string;
  submittedAt: string;
  cases?: CaseSpec[];
  groups?: Record<string, GroupSpec>;
  /** The job whose cases this one captures again. */
  recaptureOf?: string;
};

/** How many captures a job asks for: its cases, or its pages on every pass. */
export const captureCount = (request: Pick<JobRequest, "pages" | "passes" | "cases">): number =>
  request.cases ? request.cases.length : request.pages.length * request.passes;

export type CaptureStatus = "pending" | "dispatched" | "done" | "failed" | "skipped";

/** One page on one pass (or one case), and where it is. `file` is its record under `results/`. For a case, `page` is its URL. */
export type CaptureEntry = {
  page: string;
  pass: number;
  case?: string;
  group?: string;
  attempt?: number;
  file: string;
  box: string;
  status: CaptureStatus;
  startedAt?: string;
  finishedAt?: string;
  /** The HTTP status the worker answered, or 0 for a connection that failed. */
  httpStatus?: number;
  error?: string;
  note?: string;
};

/** What a box's `/health` said when the job started, kept for the manifest. */
export type BoxReading = { code: unknown; environment: Record<string, unknown> | null; policy: Record<string, unknown> | null };

/** `state.json`: written only by the service. A job with a `request.json` and no `state.json` is `queued`. */
export type JobStateFile = {
  version: StoreVersion;
  state: Exclude<JobState, "queued">;
  /** Why a job failed or was cancelled. */
  reason?: string;
  boxes: string[];
  readings: Record<string, BoxReading | null>;
  dropped: { box: string; reason: string }[];
  captures: CaptureEntry[];
  notes: string[];
  startedAt: string | null;
  finishedAt?: string;
};

/** A capture's record under `results/`: the shape `q3/fleet_capture.mjs` writes, naming the worker and never its address. */
export type CaptureRecord = { capturedAt: string; worker: string; status: number; capture: unknown; note?: string };

export type Box = { name: string; url: string };
