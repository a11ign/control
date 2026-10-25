import { buildManifest } from "./manifest.ts";
import type { PinsReading } from "./manifest.ts";
import { passesRefusal, planCaptures, reassign } from "./plan.ts";
import type { BoxClaims } from "./claims.ts";
import type { BoxResolver } from "./boxes.ts";
import type { JobStore } from "./store.ts";
import type { Box, BoxReading, CaptureEntry, CaptureRecord, JobRequest, JobStateFile } from "./types.ts";
import { STORE_VERSION } from "./types.ts";

export type CaptureResult = { status: number; json?: unknown; text?: string };
export type Health = { busy?: boolean; code?: unknown; environment?: Record<string, unknown> | null; policy?: Record<string, unknown> | null };

export type RunnerDeps = {
  store: JobStore;
  claims: BoxClaims;
  boxes: BoxResolver;
  /** One capture on one box: the worker's own `/capture`, with `url` set. Rejects on a transport failure. */
  capture: (box: Box, body: Record<string, unknown>) => Promise<CaptureResult>;
  health: (box: Box) => Promise<Health | null>;
  pins: () => PinsReading;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** How long a job that could not start waits before it asks again. Every ask can wake boxes, so it is not every tick. */
  retryQueuedMs?: number;
  /** After a restart, how long to wait for a box still finishing the capture the dead service sent it. */
  busyWaitMs?: number;
  busyPollMs?: number;
  /** Consecutive failed captures after which a box is dropped from its job (the fleet's eviction count). */
  evictAfter?: number;
};

export const RE_CAPTURED = "re-captured after a service restart";

/** A box fault is the box's, not the page's: no answer, `429` (busy with something else) or a `5xx`. A page that errors is a record and a box streak of zero. */
const isBoxFault = (status: number): boolean => status === 0 || status === 429 || status >= 500;

type Run = { id: string; request: JobRequest; state: JobStateFile; boxes: Map<string, Box>; streak: Map<string, number> };

const errorOf = (capture: unknown, status: number): string => {
  const error = (capture as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error.slice(0, 300) : `HTTP ${status}`;
};

/**
 * THE SERVICE LOOP. It scans the store for jobs, starts the queued ones when their boxes are free, and runs each started job's captures, one at a
 * time per box. Every change a job goes through is written to `state.json` BEFORE the next thing is done, so a kill at any point leaves a store
 * the next start can read: a capture marked `dispatched` is one the dead service had sent, and `tick` takes it again.
 */
export class Runner {
  private readonly runs = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private stopping = false;
  private ticking = false;
  private readonly d: Required<RunnerDeps>;

  constructor(deps: RunnerDeps) {
    this.d = {
      now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: () => {},
      retryQueuedMs: 15_000, busyWaitMs: 600_000, busyPollMs: 5_000, evictAfter: 3, ...deps,
    };
  }

  private iso = (): string => new Date(this.d.now()).toISOString();

  /** One pass over the store. Jobs are looked at oldest first, and a pass never overlaps the one before it. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const id of this.d.store.list()) {
        if (this.stopping) break;
        if (this.runs.has(id)) continue;
        try { await this.consider(id); } catch (error) { this.d.log(`${id}: ${(error as Error).message}`); }
      }
    } finally { this.ticking = false; }
  }

  /** Stop dispatching, let every capture in flight end and be recorded, and return. What is still pending is resumed by the next start. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.runs.values());
  }

  /** Resolves when every job started so far has ended (or been stopped). For tests and for `stop`. */
  async settled(): Promise<void> { await Promise.all(this.runs.values()); }

  private async consider(id: string): Promise<void> {
    const { store } = this.d;
    const request = store.readRequest(id);
    const state = store.readState(id);
    if (state && !state.ok) { store.failUnreadable(id, state.reason, this.iso()); this.d.log(`${id}: failed, ${state.reason}`); return; }
    if (request && !request.ok) {
      if (!state) { store.failUnreadable(id, request.reason, this.iso()); this.d.log(`${id}: failed, ${request.reason}`); }
      return;
    }
    if (!request) return;
    if (!state) return this.startQueued(request.value);
    if (state.value.state === "running") return this.resumeRunning(request.value, state.value);
  }

  private later(id: string): void { this.retryAt.set(id, this.d.now() + this.d.retryQueuedMs); }

  private async startQueued(request: JobRequest): Promise<void> {
    const id = request.id;
    if (this.d.store.isCancelled(id)) return this.endUnstarted(request, "cancelled", "cancelled before it started");
    if ((this.retryAt.get(id) ?? 0) > this.d.now()) return;
    const outcome = await this.boxesFor(request);
    if ("wait" in outcome) return this.later(id);
    if ("fail" in outcome) return this.endUnstarted(request, "failed", outcome.fail);
    const { boxes, notes } = outcome;
    const names = boxes.map((b) => b.name);
    const readings = Object.fromEntries(await Promise.all(boxes.map(async (box) => [box.name, await this.read(box)] as const)));
    const state: JobStateFile = {
      version: STORE_VERSION, state: "running", boxes: names, readings, dropped: [], notes,
      captures: planCaptures(request.pages, names, request.passes), startedAt: this.iso(),
    };
    this.d.store.writeState(id, state);
    this.launch({ id, request, state, boxes: new Map(boxes.map((b) => [b.name, b])), streak: new Map() });
  }

  /**
   * The boxes a queued job may start on, now, and they are CLAIMED: or `wait` (other jobs hold boxes it needs, so ask again later), or `fail` with
   * the reason (nothing else is running that would free a box, so waiting would be for ever).
   */
  private async boxesFor(request: JobRequest): Promise<{ boxes: Box[]; notes: string[] } | { wait: true } | { fail: string }> {
    const { claims } = this.d;
    const claimed = new Set(Object.keys(claims.held()));
    if (request.boxes.kind === "named" && request.boxes.names.some((name) => claimed.has(name))) return { wait: true };
    const othersRun = claimed.size > 0;
    const waitOr = (reason: string) => othersRun ? { wait: true as const } : { fail: reason };

    let choice;
    try { choice = await this.d.boxes.choose(request.boxes, claimed); } catch (error) {
      this.d.log(`${request.id}: the fleet could not be read, so the job stays queued: ${(error as Error).message}`);
      return { wait: true };
    }
    if ("refusal" in choice) return waitOr(choice.refusal);
    const { boxes, short, notes } = choice.chosen;
    if (short && othersRun) return { wait: true };
    const refusal = passesRefusal(boxes.length, request.passes);
    if (refusal) return { fail: refusal };
    if (!claims.tryClaim(request.id, boxes.map((b) => b.name)).claimed) return { wait: true };
    return { boxes, notes };
  }

  private async read(box: Box): Promise<BoxReading | null> {
    const health = await this.d.health(box).catch(() => null);
    return health ? { code: health.code ?? null, environment: health.environment ?? null, policy: health.policy ?? null } : null;
  }

  /** A job that never started ends here, with a state that says why: it is never dropped from the list. */
  private endUnstarted(request: JobRequest, state: "failed" | "cancelled", reason: string): void {
    const ended: JobStateFile = {
      version: STORE_VERSION, state, reason, boxes: [], readings: {}, dropped: [], captures: [], notes: [],
      startedAt: null, finishedAt: this.iso(),
    };
    this.d.store.writeState(request.id, ended);
    this.d.store.writeManifest(request.id, buildManifest({ request, state: ended, pins: this.d.pins() }));
    this.d.log(`${request.id}: ${state}, ${reason}`);
  }

  /** A job the dead service was running: keep every record it wrote, take the captures it had sent again, and carry on. */
  private async resumeRunning(request: JobRequest, state: JobStateFile): Promise<void> {
    const id = request.id;
    const live = state.boxes.filter((name) => !state.dropped.some((d) => d.box === name));
    const { found, missing } = await this.d.boxes.locate(live);
    for (const box of missing) state.dropped.push({ box, reason: "no longer in the inventory when the service restarted" });
    const stillLive = found.map((b) => b.name);
    for (const entry of state.captures) {
      if (entry.status !== "dispatched") continue;
      entry.status = "pending";
      entry.note = RE_CAPTURED;
      delete entry.startedAt;
    }
    for (const box of missing) reassign(state.captures, box, stillLive);
    state.notes.push(`resumed after a service restart at ${this.iso()}`);
    const claim = this.d.claims.tryClaim(id, stillLive);
    if (!claim.claimed) {
      return this.failRun({ id, request, state, boxes: new Map(), streak: new Map() },
        `could not resume: ${Object.entries(claim.heldBy).map(([box, job]) => `${box} is held by ${job}`).join(", ")}`);
    }
    this.d.store.writeState(id, state);
    this.launch({ id, request, state, boxes: new Map(found.map((b) => [b.name, b])), streak: new Map() });
  }

  private launch(run: Run): void {
    this.d.log(`${run.id}: running on ${run.state.boxes.join(", ")}`);
    this.d.store.writeManifest(run.id, buildManifest({ request: run.request, state: run.state, pins: this.d.pins() }));
    const finished = this.execute(run)
      .catch((error) => this.failRun(run, `internal error: ${(error as Error).stack ?? error}`))
      .finally(() => { this.d.claims.release(run.id); this.runs.delete(run.id); });
    this.runs.set(run.id, finished);
  }

  private persist(run: Run): void { this.d.store.writeState(run.id, run.state); }

  private liveBoxes(run: Run): string[] {
    return run.state.boxes.filter((name) => run.boxes.has(name) && !run.state.dropped.some((d) => d.box === name));
  }

  private async execute(run: Run): Promise<void> {
    const inflight = new Map<string, Promise<void>>();
    try {
      while (!this.stopping && !this.d.store.isCancelled(run.id)) {
        this.dispatchIdleBoxes(run, inflight);
        if (!inflight.size) break;
        await Promise.race(inflight.values());
      }
    } finally {
      // Whatever ended the loop, no capture is left running unrecorded behind a job that has let go of its boxes.
      await Promise.allSettled(inflight.values());
    }
    this.conclude(run);
  }

  /** Send each live box that is idle its next pending capture, marking it `dispatched` in `state.json` BEFORE it is sent. */
  private dispatchIdleBoxes(run: Run, inflight: Map<string, Promise<void>>): void {
    for (const name of this.liveBoxes(run)) {
      if (inflight.has(name)) continue;
      const next = run.state.captures.find((c) => c.box === name && c.status === "pending");
      if (!next) continue;
      next.status = "dispatched";
      next.startedAt = this.iso();
      this.persist(run);
      inflight.set(name, this.captureOne(run, name, next).finally(() => inflight.delete(name)));
    }
  }

  private async captureOne(run: Run, name: string, entry: CaptureEntry): Promise<void> {
    const box = run.boxes.get(name)!;
    if (entry.note === RE_CAPTURED) await this.waitIdle(box, entry);
    const hostname = new URL(box.url).hostname;
    let status = 0;
    let capture: unknown;
    try {
      const result = await this.d.capture(box, { ...run.request.body, url: entry.page });
      status = result.status;
      capture = result.json ?? { error: (result.text ?? "").slice(0, 300) };
    } catch (error) {
      // A connection that fails is a record too, and it names the worker, never its address.
      capture = { error: `${name}: ${String((error as Error).message).replaceAll(hostname, name)}` };
    }
    const record: CaptureRecord = { capturedAt: this.iso(), worker: name, status, capture, ...(entry.note ? { note: entry.note } : {}) };
    this.d.store.writeRecord(run.id, entry.file, record);
    entry.finishedAt = record.capturedAt;
    entry.httpStatus = status;
    entry.status = status >= 200 && status < 300 ? "done" : "failed";
    if (entry.status === "failed") entry.error = errorOf(capture, status);
    this.settleBox(run, name, status, entry);
    this.persist(run);
  }

  /** Three box faults in a row drop the box from the job, and its unfinished captures move to the boxes that are left. */
  private settleBox(run: Run, name: string, status: number, entry: CaptureEntry): void {
    const streak = isBoxFault(status) ? (run.streak.get(name) ?? 0) + 1 : 0;
    run.streak.set(name, streak);
    if (streak < this.d.evictAfter) return;
    run.state.dropped.push({ box: name, reason: `${streak} captures in a row failed on it; the last: ${entry.error ?? `HTTP ${status}`}` });
    reassign(run.state.captures, name, this.liveBoxes(run));
    this.d.log(`${run.id}: dropped ${name}`);
  }

  private async waitIdle(box: Box, entry: CaptureEntry): Promise<void> {
    const until = this.d.now() + this.d.busyWaitMs;
    for (;;) {
      const health = await this.d.health(box).catch(() => null);
      if (health && health.busy === false) return;
      if (this.d.now() >= until) break;
      await this.d.sleep(this.d.busyPollMs);
    }
    entry.note = `${RE_CAPTURED}; the box still reported busy after ${Math.round(this.d.busyWaitMs / 1000)}s, so the capture was sent anyway`;
  }

  private conclude(run: Run): void {
    if (this.d.store.isCancelled(run.id)) return this.finish(run, "cancelled", "cancelled by request");
    if (this.stopping) return;
    if (run.state.captures.some((c) => c.status === "pending")) {
      const why = run.state.dropped.map((d) => `${d.box}: ${d.reason}`).join("; ");
      return this.finish(run, "failed", `no box was left to capture ${run.state.captures.filter((c) => c.status === "pending").length} pages${why ? ` (${why})` : ""}`);
    }
    this.finish(run, "done");
  }

  private failRun(run: Run, reason: string): void { this.finish(run, "failed", reason); }

  private finish(run: Run, state: "done" | "failed" | "cancelled", reason?: string): void {
    run.state.state = state;
    run.state.finishedAt = this.iso();
    if (reason) run.state.reason = reason;
    this.persist(run);
    this.d.store.writeManifest(run.id, buildManifest({ request: run.request, state: run.state, pins: this.d.pins() }));
    this.d.log(`${run.id}: ${state}${reason ? `, ${reason}` : ""}`);
  }
}
