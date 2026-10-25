import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READABLE_VERSIONS, STORE_VERSION } from "./types.ts";
import type { FactsRecord } from "../fleet-facts/types.ts";
import type { CaptureRecord, JobRequest, JobStateFile } from "./types.ts";

/**
 * `fj-<UTC yyyymmddThhmmssZ>-<6 hex>`: sorts by time, is unique without a lock, and is safe in a path. The first three hex digits are the
 * millisecond, so two jobs submitted in one second still sort in the order they were submitted, which is the order the service starts them; the last
 * three are random.
 */
export const JOB_ID = /^fj-\d{8}T\d{6}Z-[0-9a-f]{6}$/;

export function newJobId(at: Date = new Date(), random: () => string = () => randomBytes(2).toString("hex").slice(0, 3)): string {
  const millisecond = at.getUTCMilliseconds().toString(16).padStart(3, "0");
  return `fj-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${millisecond}${random()}`;
}

/** Temp file, then rename: a reader sees the old file or the new one, never half of either. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(temp, path);
}

export type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

function readVersioned<T extends { version: unknown }>(path: string, what: string, accepts: readonly number[]): Read<T> | null {
  if (!existsSync(path)) return null;
  let parsed: T;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as T; } catch (cause) { return { ok: false, reason: `${what} is unreadable: ${(cause as Error).message}` }; }
  if (typeof parsed?.version !== "number" || !accepts.includes(parsed.version)) {
    return { ok: false, reason: `${what} is store version ${JSON.stringify(parsed?.version)}, and this service reads version ${accepts.join(" and ")}` };
  }
  return { ok: true, value: parsed };
}

/**
 * The job store: one directory per job under `dir`. EACH FILE HAS ONE WRITER, so no lock is needed between the CLI and the service: `request.json`
 * is written once by `submit`, `state.json` and `results/` only by the service, and `cancel` is a marker that only `cancel` writes.
 */
export class JobStore {
  readonly dir: string;
  private readonly accepts: readonly number[];

  /** `accepts` is every store version this code reads; only a test narrows it, to stand in for an older service. */
  constructor(dir: string, { accepts = READABLE_VERSIONS }: { accepts?: readonly number[] } = {}) { this.dir = dir; this.accepts = accepts; }

  jobDir = (id: string): string => join(this.dir, id);
  resultsDir = (id: string): string => join(this.jobDir(id), "results");
  private requestPath = (id: string): string => join(this.jobDir(id), "request.json");
  private statePath = (id: string): string => join(this.jobDir(id), "state.json");
  private cancelPath = (id: string): string => join(this.jobDir(id), "cancel");
  servicePath = (): string => join(this.dir, "service.json");

  /** Every job id with a directory, oldest first. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => JOB_ID.test(name)).sort();
  }

  has = (id: string): boolean => existsSync(this.requestPath(id)) || existsSync(this.statePath(id));

  /** The request lands whole or not at all, so a directory with no `request.json` is a submit still in flight and is not a job yet. */
  writeRequest(request: JobRequest): void {
    mkdirSync(this.jobDir(request.id), { recursive: true });
    writeJsonAtomic(this.requestPath(request.id), request);
  }

  readRequest = (id: string): Read<JobRequest> | null => readVersioned<JobRequest>(this.requestPath(id), "request.json", this.accepts);
  readState = (id: string): Read<JobStateFile> | null => readVersioned<JobStateFile>(this.statePath(id), "state.json", this.accepts);

  writeState(id: string, state: JobStateFile): void {
    mkdirSync(this.jobDir(id), { recursive: true });
    writeJsonAtomic(this.statePath(id), state);
  }

  /**
   * A job whose files this service cannot read is FAILED WITH THE REASON, never skipped. An unreadable `state.json` is moved aside first, since a
   * file of a version this code does not know may be a newer service's, and the failure is written as the new `state.json`.
   */
  failUnreadable(id: string, reason: string, at: string): JobStateFile {
    if (existsSync(this.statePath(id))) renameSync(this.statePath(id), join(this.jobDir(id), "state.unreadable.json"));
    const state: JobStateFile = { version: STORE_VERSION, state: "failed", reason, boxes: [], readings: {}, dropped: [], captures: [], notes: [], startedAt: null, finishedAt: at };
    this.writeState(id, state);
    return state;
  }

  markCancelled(id: string, at: string): void { writeFileSync(this.cancelPath(id), `${at}\n`); }
  isCancelled = (id: string): boolean => existsSync(this.cancelPath(id));

  writeRecord(id: string, file: string, record: CaptureRecord | FactsRecord): void {
    mkdirSync(this.resultsDir(id), { recursive: true });
    writeJsonAtomic(join(this.resultsDir(id), file), record);
  }

  writeManifest(id: string, manifest: unknown): void {
    mkdirSync(this.resultsDir(id), { recursive: true });
    writeJsonAtomic(join(this.resultsDir(id), "manifest.json"), manifest);
  }
}
