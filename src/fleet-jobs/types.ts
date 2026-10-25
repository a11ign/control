/** What a fleet job is on disk. Every file carries `version`; a version this code does not know fails the job and is never guessed at. */
export const STORE_VERSION = 1;

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export const TERMINAL_STATES: readonly JobState[] = ["done", "failed", "cancelled"];
export const isTerminal = (state: JobState): boolean => TERMINAL_STATES.includes(state);

/** The boxes a job asked for: a number of them, every ready one, or these by name. */
export type BoxRequest = { kind: "count"; count: number } | { kind: "ready" } | { kind: "named"; names: string[] };

/** A freeze reference as `make_freeze.py` writes it; only the two fields the manifest names are required. */
export type Freeze = { commit: string; namedAt: string; [field: string]: unknown };

/** `request.json`: written once by `submit`, never again. */
export type JobRequest = {
  version: typeof STORE_VERSION;
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
};

export type CaptureStatus = "pending" | "dispatched" | "done" | "failed";

/** One page on one pass, and where it is. `file` is its record under `results/`. */
export type CaptureEntry = {
  page: string;
  pass: number;
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
  version: typeof STORE_VERSION;
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
