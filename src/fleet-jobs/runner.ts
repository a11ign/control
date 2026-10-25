import { buildManifest } from "./manifest.ts";
import type { PinsReading } from "./manifest.ts";
import { SKIPPED, reassignGroups, skipMatchingGroups } from "./cases.ts";
import { passesRefusal, planCaptures, planCases, planFacts, reassign } from "./plan.ts";
import type { Availability, BoxClaims } from "./claims.ts";
import type { BoxResolver, Choose } from "./boxes.ts";
import type { DriftReader } from "./drift.ts";
import type { JobStore } from "./store.ts";
import type { Box, BoxReading, CaptureEntry, CaptureRecord, JobRequest, JobStateFile } from "./types.ts";
import { isFactsJob, isTerminal } from "./types.ts";
import { factsFilePath, recordAttempt } from "../fleet-facts/facts-file.ts";
import type { Attempt } from "../fleet-facts/facts-file.ts";
import { parseFacts } from "../fleet-facts/parse.ts";
import type { PlayRead } from "../fleet-facts/play-result.ts";
import type { BoxFacts, FactsRecord } from "../fleet-facts/types.ts";
import { estimateFinish } from "./view.ts";
import { RENEW_EVERY_MS } from "../fleet-leases/types.ts";

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
  /** Consecutive failed captures after which a box leaves its job (the fleet's eviction count). */
  evictAfter?: number;
  /** The boxes the hourly drift check says are off the manifest, with what differs. A box in it leaves every running job and is not offered to a new one. */
  drift?: DriftReader;
  /** How often a running job renews its lease and a queued job its place. A holder that stops renewing frees its boxes at the lease's grace. */
  renewEveryMs?: number;
  /** One facts read of one box (A11-283): wake it, run the read-only play, and return what the play said. Rejects with the reason when the box cannot be read. */
  readFacts?: (box: Box) => Promise<PlayRead>;
  /** The facts file a facts job writes: the job service is its only writer. */
  factsFile?: string;
};

export const RE_CAPTURED = "re-captured after a service restart";
export { SKIPPED };

/** A box fault is the box's, not the page's: no answer, `429` (busy with something else) or a `5xx`. A page that errors is a record and a box streak of zero. */
const isBoxFault = (status: number): boolean => status === 0 || status === 429 || status >= 500;

type Run = { id: string; request: JobRequest; state: JobStateFile; boxes: Map<string, Box>; streak: Map<string, number>; released: Set<string> };

const leftTheFleet = (box: string, why: string): string => `${box} left the fleet: ${why}`;

const planOf = (request: JobRequest, names: string[]): CaptureEntry[] =>
  isFactsJob(request) ? planFacts(names) : request.cases ? planCases(request.cases, request.groups ?? {}, names) : planCaptures(request.pages, names, request.passes);

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
  private readonly running = new Map<string, Run>();
  private lastRenewAt = Number.NEGATIVE_INFINITY;
  private renewDue = false;
  private readonly retryAt = new Map<string, number>();
  private stopping = false;
  private ticking = false;
  private readonly d: Required<RunnerDeps>;

  constructor(deps: RunnerDeps) {
    this.d = {
      now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log: () => {},
      retryQueuedMs: 15_000, busyWaitMs: 600_000, busyPollMs: 5_000, evictAfter: 3, drift: () => ({}), renewEveryMs: RENEW_EVERY_MS,
      readFacts: async () => { throw new Error("this service has no facts reader"); }, factsFile: factsFilePath(), ...deps,
    };
  }

  private iso = (): string => new Date(this.d.now()).toISOString();

  /** One pass over the store. Jobs are looked at oldest first, and a pass never overlaps the one before it. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      this.renewDue = this.d.now() - this.lastRenewAt >= this.d.renewEveryMs;
      if (this.renewDue) { this.lastRenewAt = this.d.now(); this.renewRunning(); }
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

  /**
   * A queued job joins the ledger's queue at its submission time, and starts only when the ledger says it holds the turn for boxes it can have. A job
   * that is not at the head of its boxes costs one read of the ledger, and wakes nothing.
   */
  private async startQueued(request: JobRequest): Promise<void> {
    const id = request.id;
    if (this.d.store.isCancelled(id)) return this.endUnstarted(request, "cancelled", "cancelled before it started");
    this.keepQueued(request);
    const standing = this.d.claims.availability(id);
    if (!standing.grantable) return;
    if ((this.retryAt.get(id) ?? 0) > this.d.now()) return;
    const outcome = await this.boxesFor(request, standing);
    if ("wait" in outcome) return this.later(id);
    if ("fail" in outcome) return this.endUnstarted(request, "failed", outcome.fail);
    const { boxes, notes } = outcome;
    const names = boxes.map((b) => b.name);
    // A facts job's boxes are asleep until each read wakes it, so there is no `/health` to read at the start.
    const readings: Record<string, BoxReading | null> = isFactsJob(request) ? {} : Object.fromEntries(await Promise.all(boxes.map(async (box) => [box.name, await this.read(box)] as const)));
    const state: JobStateFile = {
      version: request.version, state: "running", boxes: names, readings, dropped: [], notes,
      captures: planOf(request, names), startedAt: this.iso(),
    };
    this.d.store.writeState(id, state);
    this.launch({ id, request, state, boxes: new Map(boxes.map((b) => [b.name, b])), streak: new Map(), released: new Set() });
  }

  /** In the queue, and not out of it by a wipe or a lapse: a job with no place joins again, keeping its time. Every `renewEveryMs` the place is renewed. */
  private keepQueued(request: JobRequest): void {
    const { claims } = this.d;
    if (claims.place(request.id) === null) {
      // A lease with no waiter and no state is a take the service died after: it is this job's own, so it is let go and the job queues again.
      if (claims.holds(request.id)) claims.release(request.id);
      claims.enqueue(request);
    } else if (this.renewDue) claims.renew(request.id, null);
  }

  /**
   * The boxes a queued job that holds the turn may start on, now, and they are TAKEN in the ledger: or `wait` (a take lost to a race, or the boxes
   * cannot be had yet), or `fail` with the reason (nothing holds a box that would free one, so waiting would be for ever).
   */
  private async boxesFor(request: JobRequest, standing: Availability): Promise<{ boxes: Box[]; notes: string[] } | { wait: true } | { fail: string }> {
    // A facts job is not held to the manifest: hardware does not depend on it, so the drift record neither drops nor refuses a box.
    const facts = isFactsJob(request);
    let drifting: Record<string, string> = {};
    if (!facts) {
      try { drifting = this.d.drift(); } catch (error) {
        // A record that cannot be read is not proof that no box differs, so a job that has not started does not start on it.
        this.d.log(`${request.id}: the job stays queued: ${(error as Error).message}`);
        return { wait: true };
      }
    }
    const held = Object.keys(standing.excluded);
    const named = request.boxes.kind === "named" ? request.boxes.names.filter((name) => drifting[name]) : [];
    if (named.length) return { fail: `${named.map((name) => `${name} is ${drifting[name]}`).join("; ")}: a box that differs from the manifest is out of capture` };
    const waitOr = (reason: string) => held.length ? { wait: true as const } : { fail: reason };

    let choice;
    try {
      // `choose` wakes the boxes it names and refuses the whole job when one does not come up; a facts job wakes each box as it reads it, so a box that does not answer is its own entry.
      choice = facts && request.boxes.kind === "named" ? await this.locateNamed(request.boxes.names) : await this.d.boxes.choose(request.boxes, new Set([...held, ...Object.keys(drifting)]));
    } catch (error) {
      this.d.log(`${request.id}: the fleet could not be read, so the job stays queued: ${(error as Error).message}`);
      return { wait: true };
    }
    if ("refusal" in choice) return waitOr(choice.refusal);
    const { boxes, short, notes } = choice.chosen;
    if (short && held.length) return { wait: true };
    const refusal = passesRefusal(boxes.length, request.passes);
    if (refusal) return { fail: refusal };
    if (!this.d.claims.take(request.id, boxes.map((b) => b.name)).claimed) return { wait: true };
    return { boxes, notes };
  }

  private async locateNamed(names: string[]): Promise<Choose> {
    const { found, missing } = await this.d.boxes.locate(names);
    if (missing.length) return { refusal: `not in the inventory: ${missing.join(", ")}` };
    return { chosen: { boxes: names.map((name) => found.find((box) => box.name === name)!), short: false, notes: [] } };
  }

  private async read(box: Box): Promise<BoxReading | null> {
    const health = await this.d.health(box).catch(() => null);
    return health ? { code: health.code ?? null, environment: health.environment ?? null, policy: health.policy ?? null } : null;
  }

  /** A job that never started ends here, with a state that says why: it is never dropped from the list. */
  private endUnstarted(request: JobRequest, state: "failed" | "cancelled", reason: string): void {
    const ended: JobStateFile = {
      version: request.version, state, reason, boxes: [], readings: {}, dropped: [], captures: [], notes: [],
      startedAt: null, finishedAt: this.iso(),
    };
    this.d.store.writeState(request.id, ended);
    this.d.store.writeManifest(request.id, buildManifest({ request, state: ended, pins: this.d.pins() }));
    this.letGo(request.id);
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
    for (const box of missing) this.moveOff(request, state, box, stillLive);
    state.notes.push(`resumed after a service restart at ${this.iso()}`);
    // Only the boxes with pages left are taken again: a box the dead service had already let go of may be another job's by now, and is not this job's to resume.
    const released = new Set(stillLive.filter((name) => !this.hasWork(state, name)));
    const needed = stillLive.filter((name) => !released.has(name));
    const claim = needed.length ? this.d.claims.retake(request, needed) : { claimed: true as const };
    if (!claim.claimed) {
      this.failRun({ id, request, state, boxes: new Map(), streak: new Map(), released },
        `could not resume: ${Object.entries(claim.heldBy).map(([box, holders]) => `${box} is held by ${holders.join(", ")}`).join(", ")}`);
      this.letGo(id);
      return;
    }
    this.d.store.writeState(id, state);
    this.launch({ id, request, state, boxes: new Map(found.map((b) => [b.name, b])), streak: new Map(), released });
  }

  /**
   * What a box gone from the inventory leaves behind. A page job's pages go to the boxes that are left. A case job's groups go only whole, and only when
   * untouched (`reassignGroups`); the rest of its cases fail with the reason.
   */
  private moveOff(request: JobRequest, state: JobStateFile, box: string, live: string[]): void {
    // A box's hardware is read on that box: its read is never moved to another.
    if (isFactsJob(request)) {
      for (const entry of state.captures.filter((c) => c.box === box && c.status === "pending")) this.failFactsUnsent(request.id, entry, leftTheFleet(box, "it is no longer in the inventory"));
      return;
    }
    if (!request.cases) { reassign(state.captures, box, live); return; }
    this.skipMatching(request.id, request, state, box);
    for (const { entry, error } of reassignGroups(state.captures, request.groups ?? {}, box, live).failed) this.failUnsent(request.id, entry, error);
  }

  /** Whether the job still has a page to send, or one in flight, on the box. */
  private hasWork(state: JobStateFile, name: string): boolean {
    return state.captures.some((c) => c.box === name && (c.status === "pending" || c.status === "dispatched"));
  }

  private launch(run: Run): void {
    this.d.log(`${run.id}: running on ${run.state.boxes.join(", ")}`);
    this.d.store.writeManifest(run.id, buildManifest({ request: run.request, state: run.state, pins: this.d.pins() }));
    this.running.set(run.id, run);
    const finished = this.execute(run)
      .catch((error) => this.failRun(run, `internal error: ${(error as Error).stack ?? error}`))
      .finally(() => {
        // A job that ends lets go of its lease. A job the service stopped under is still running: its lease is renewed by the next start, and lapses at its grace if none comes.
        if (isTerminal(run.state.state)) this.letGo(run.id);
        this.runs.delete(run.id);
        this.running.delete(run.id);
      });
    this.runs.set(run.id, finished);
  }

  /** Every running job pushes its lease out, and says when it expects to end. A lease that is gone is said: the boxes may have been given to another job. */
  private renewRunning(): void {
    for (const run of this.running.values()) {
      try {
        this.retakeIfLapsed(run);
        this.d.claims.renew(run.id, estimateFinish(run.state.captures, this.d.now()));
      } catch (error) { this.d.log(`${run.id}: the lease was not renewed, and will be tried again: ${(error as Error).message}`); }
    }
  }

  /**
   * A lease that has lapsed under a job still capturing (a tick blocked past the grace, or a ledger that could not be read) is taken again for the boxes
   * the job still needs, so the next job is not given a box with a capture on it. If another holder has the box by now, that is said: the worker's own
   * `429` is then the only thing between two captures, and it is not this job's to hide.
   */
  private retakeIfLapsed(run: Run): void {
    const needed = run.state.boxes.filter((name) => !run.released.has(name) && this.hasWork(run.state, name));
    if (!needed.length || this.d.claims.holds(run.id)) return;
    const claim = this.d.claims.retake(run.request, needed);
    this.d.log(claim.claimed ? `${run.id}: its lease had lapsed and was taken again` : `${run.id}: its lease lapsed and ${Object.entries(claim.heldBy).map(([box, holders]) => `${box} is now held by ${holders.join(", ")}`).join(", ")}`);
  }

  /**
   * Let go of a finished job's lease. A ledger that is busy or unreadable at this moment must not fail a job that has already ended, nor leave the
   * service with a rejection nobody handles: the lease then lapses at its grace, which is what a lease is for.
   */
  private letGo(id: string): void {
    try { this.d.claims.release(id); } catch (error) { this.d.log(`${id}: its lease was not released and will lapse at its grace: ${(error as Error).message}`); }
  }

  private persist(run: Run): void { this.d.store.writeState(run.id, run.state); }

  private liveBoxes(run: Run): string[] {
    return run.state.boxes.filter((name) => run.boxes.has(name) && !run.state.dropped.some((d) => d.box === name));
  }

  private async execute(run: Run): Promise<void> {
    const inflight = new Map<string, Promise<void>>();
    try {
      while (!this.stopping && !this.d.store.isCancelled(run.id)) {
        this.releaseFinished(run, inflight);
        // A finished box is let go first, so a drift record cannot take it out of a job it has no more work in; a box that leaves now is let go at once.
        this.dropDrifting(run);
        this.releaseFinished(run, inflight);
        this.dispatchIdleBoxes(run, inflight);
        // A box whose last groups were just skipped has no work left: it is let go now, not when another box's capture ends.
        this.releaseFinished(run, inflight);
        if (!inflight.size) break;
        await Promise.race(inflight.values());
      }
    } finally {
      // Whatever ended the loop, no capture is left running unrecorded behind a job that has let go of its boxes.
      await Promise.allSettled(inflight.values());
    }
    this.conclude(run);
  }

  /** A box the drift record names leaves the job; its capture in flight, if any, ends and is kept. */
  private dropDrifting(run: Run): void {
    if (isFactsJob(run.request)) return;
    let drifting: Record<string, string>;
    try { drifting = this.d.drift(); } catch (error) {
      // Nothing is known, so nothing is dropped: a box leaves a running job on a difference that was read, never on one guessed.
      this.d.log(`${run.id}: no box is dropped on a drift record that cannot be read: ${(error as Error).message}`);
      return;
    }
    for (const name of this.liveBoxes(run)) if (drifting[name] && !run.released.has(name)) this.leave(run, name, drifting[name]!);
  }

  /** A box with no capture left to send or to wait for is let go at once, so the next job in the queue can start on it. */
  private releaseFinished(run: Run, inflight: Map<string, Promise<void>>): void {
    const finished = run.state.boxes.filter((name) => !run.released.has(name) && !inflight.has(name) && !this.hasWork(run.state, name));
    if (!finished.length) return;
    try { this.d.claims.releaseBoxes(run.id, finished); } catch (error) {
      // Not marked as released, so the next pass asks again; a job does not fail because the ledger was busy for a moment.
      this.d.log(`${run.id}: boxes not released yet, will try again: ${(error as Error).message}`);
      return;
    }
    for (const name of finished) run.released.add(name);
  }

  /** Send each live box that is idle its next pending capture, marking it `dispatched` in `state.json` BEFORE it is sent. */
  private dispatchIdleBoxes(run: Run, inflight: Map<string, Promise<void>>): void {
    for (const name of this.liveBoxes(run)) {
      if (inflight.has(name)) continue;
      const next = this.nextCapture(run, name);
      if (!next) continue;
      next.status = "dispatched";
      next.startedAt = this.iso();
      this.persist(run);
      inflight.set(name, this.captureOne(run, name, next).finally(() => inflight.delete(name)));
    }
  }

  /**
   * The box's next pending capture. A group that has not begun and whose `skipWhen` matches the box's environment is skipped whole, first: no capture is
   * sent and no record is written, so what the box already holds stands.
   */
  private nextCapture(run: Run, name: string): CaptureEntry | undefined {
    if (this.skipMatching(run.id, run.request, run.state, name)) this.persist(run);
    return run.state.captures.find((c) => c.box === name && c.status === "pending");
  }

  /** Skip the groups of a case job that its box's environment says need no capture. True when any were. */
  private skipMatching(id: string, request: JobRequest, state: JobStateFile, name: string): boolean {
    if (!request.cases) return false;
    const skipped = skipMatchingGroups(state.captures, request.groups ?? {}, name, state.readings[name]);
    for (const group of new Set(skipped.map((c) => c.group))) this.d.log(`${id}: group ${group} skipped on ${name}: ${SKIPPED}`);
    return skipped.length > 0;
  }

  /** The body sent for an entry: a case's own body exactly, else the job's body, with the URL. Nothing else is merged in. */
  private bodyFor(run: Run, entry: CaptureEntry): Record<string, unknown> {
    const own = entry.case === undefined ? undefined : run.request.cases?.find((c) => c.id === entry.case);
    return { ...(own ? own.body : run.request.body), url: entry.page };
  }

  private async captureOne(run: Run, name: string, entry: CaptureEntry): Promise<void> {
    if (isFactsJob(run.request)) return this.readOne(run, name, entry);
    const box = run.boxes.get(name)!;
    if (entry.note === RE_CAPTURED) await this.waitIdle(box, entry);
    const hostname = new URL(box.url).hostname;
    let status = 0;
    let capture: unknown;
    try {
      const result = await this.d.capture(box, this.bodyFor(run, entry));
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

  /**
   * One facts read (A11-283): the play's result for the box, refused if it changed anything or is not whole, then the record under `results/` and the box's
   * entry in the facts file. A read that fails is a failed entry with the reason and the job goes on with the other boxes; the box keeps its last facts, stale.
   */
  private async readOne(run: Run, name: string, entry: CaptureEntry): Promise<void> {
    const box = run.boxes.get(name)!;
    const outcome = await this.factsOutcome(box);
    const at = this.iso();
    const attempt: Attempt = { box: name, job: run.id, at, ...("facts" in outcome ? { facts: outcome.facts } : { error: outcome.error }) };
    const filed = this.fileFacts(attempt);
    const error = "facts" in outcome ? (filed === null ? null : `${name} was read but ${filed}`) : (filed === null ? outcome.error : `${outcome.error}; ${filed}`);
    const record: FactsRecord = { readAt: at, worker: name, status: error === null ? "done" : "failed", changed: outcome.changed,
      ...("facts" in outcome ? { facts: outcome.facts } : {}), ...(error === null ? {} : { error }) };
    this.d.store.writeRecord(run.id, entry.file, record);
    entry.finishedAt = at;
    entry.status = error === null ? "done" : "failed";
    if (error !== null) {
      entry.error = error;
      run.state.dropped.push({ box: name, reason: error });
    }
    this.persist(run);
  }

  private async factsOutcome(box: Box): Promise<{ facts: BoxFacts; changed: number } | { error: string; changed: number | null }> {
    let read: PlayRead;
    try { read = await this.d.readFacts(box); } catch (error) { return { error: String((error as Error).message), changed: null }; }
    if (read.changed !== 0) return { error: `the facts play changed ${read.changed} ${read.changed === 1 ? "thing" : "things"} on ${box.name}; it must change nothing`, changed: read.changed };
    const parsed = parseFacts(read.output);
    return "refusal" in parsed ? { error: `the facts of ${box.name} could not be read: ${parsed.refusal}`, changed: read.changed } : { facts: parsed.facts, changed: read.changed };
  }

  /** Put an attempt in the facts file. Null when it landed, else why not: a file that cannot be read is left alone, and the entry says so. */
  private fileFacts(attempt: Attempt): string | null {
    try {
      const filed = recordAttempt(this.d.factsFile, attempt);
      return filed.ok ? null : `${filed.reason}, so it was left alone`;
    } catch (error) { return `${this.d.factsFile} was not written: ${(error as Error).message}`; }
  }

  /** A read that was never made, as a failed entry that says why. The facts file is not touched: the box was not asked. */
  private failFactsUnsent(id: string, entry: CaptureEntry, error: string): void {
    entry.status = "failed";
    entry.error = error;
    entry.finishedAt = this.iso();
    this.d.store.writeRecord(id, entry.file, { readAt: entry.finishedAt, worker: entry.box, status: "failed", changed: null, error } satisfies FactsRecord);
  }

  /** Three box faults in a row take the box out of its job. */
  private settleBox(run: Run, name: string, status: number, entry: CaptureEntry): void {
    const streak = isBoxFault(status) ? (run.streak.get(name) ?? 0) + 1 : 0;
    run.streak.set(name, streak);
    if (streak < this.d.evictAfter || run.state.dropped.some((d) => d.box === name)) return;
    this.leave(run, name, `${streak} captures in a row failed on it; the last: ${entry.error ?? `HTTP ${status}`}`);
  }

  /**
   * A BOX LEAVING THE FLEET MID-JOB (unreachable, or off the manifest) fails only its own part of the job, and names it: each capture it had not yet sent
   * is a failed record that says `<box> left the fleet: <why>`, and the box is dropped. The other boxes carry on, and nothing is moved onto them. Its
   * lease is let go (`releaseFinished`) once the capture it may still have in flight ends, never while a capture is running on it.
   */
  private leave(run: Run, name: string, why: string): void {
    run.state.dropped.push({ box: name, reason: why });
    const error = leftTheFleet(name, why);
    this.skipMatching(run.id, run.request, run.state, name);
    for (const entry of run.state.captures.filter((c) => c.box === name && c.status === "pending")) this.failUnsent(run.id, entry, error);
    this.persist(run);
    this.d.log(`${run.id}: ${error}`);
  }

  /** A capture that was never sent, as a failed record that says why. */
  private failUnsent(id: string, entry: CaptureEntry, error: string): void {
    entry.status = "failed";
    entry.error = error;
    entry.httpStatus = 0;
    entry.finishedAt = this.iso();
    this.d.store.writeRecord(id, entry.file, { capturedAt: entry.finishedAt, worker: entry.box, status: 0, capture: { error } });
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
    // A facts job fails only when no box could be read; a box that did not answer is its own failed entry and stale in the file.
    if (isFactsJob(run.request)) {
      const failed = run.state.captures.filter((c) => c.status === "failed");
      if (failed.length === run.state.captures.length) return this.finish(run, "failed", `no box could be read: ${failed.map((c) => `${c.box}: ${c.error}`).join("; ")}`);
      return this.finish(run, "done");
    }
    // pending, or failed without ever being sent: the pages of a box that left
    const unserved = run.state.captures.filter((c) => c.status === "pending" || (c.status === "failed" && !c.startedAt));
    if (unserved.length && !this.liveBoxes(run).length) {
      const why = run.state.dropped.map((d) => `${d.box}: ${d.reason}`).join("; ");
      return this.finish(run, "failed", `no box was left to capture ${unserved.length} ${run.request.cases ? "cases" : "pages"}${why ? ` (${why})` : ""}`);
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
