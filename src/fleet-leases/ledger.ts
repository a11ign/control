import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { availability, inOrder, liveOf, mayTake, mayTakeNow, placeOf } from "./grant.ts";
import type { Taking } from "./grant.ts";
import { LEASE_GRACE_MS, LEDGER_VERSION, emptyLedger } from "./types.ts";
import type { Lease, LeaseKind, Ledger, Waiter, Want } from "./types.ts";

/**
 * THE LEASE LEDGER ON DISK (A11-244, ADR `A11-244-adr-0001`). One versioned JSON file; every change is ONE read-decide-write under `ledger.lock`.
 *
 * THE MUTEX. The lock file is created with `wx` and holds the pid. Every writer is on the one control-plane host, so a lock whose pid is dead
 * (`process.kill(pid, 0)` gives `ESRCH`), or that is older than any critical section, is broken and the take retried. A lock still held after `lockWaitMs` throws `LedgerBusy`, and every caller reads
 * that as "not now". The new file goes to a temp file and is renamed into place, so a reader sees the old ledger or the new one.
 *
 * A LEDGER NOBODY CAN READ IS NOT PROOF THAT NOBODY HOLDS A BOX (the rule `fleet-lock.ts` states). A file that is not JSON, or of a version this code
 * does not know (the other checkout may be newer), reads as EVERY BOX HELD: nothing is taken, nothing is written over it, and the reason is returned.
 */
export class LedgerBusy extends Error {}

export type LedgerRead = { ok: true; ledger: Ledger } | { ok: false; reason: string };

export type LedgerOptions = {
  now?: () => number;
  log?: (line: string) => void;
  lockWaitMs?: number;
  /** For a test to prove a dead pid's lock is broken. */
  pid?: number;
};

export type Spec = { id: string; holder: string; kind: LeaseKind; label: string };
export type TakeSpec = Spec & { boxes: string[]; ttlMs?: number; expectedEnd?: number | null; respectQueue?: boolean };

export type Took = { taken: true; lease: Lease } | { taken: false; heldBy: Record<string, string[]>; reason: string };

/** No critical section takes anything like this long, so a lock this old is a holder that is gone, whatever its pid says (a pid can be reused). */
const LOCK_MAX_AGE_MS = 30_000;

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

export class LeaseLedger {
  readonly path: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly lockWaitMs: number;
  private readonly pid: number;

  constructor(path: string, { now = Date.now, log = () => {}, lockWaitMs = 5_000, pid = process.pid }: LedgerOptions = {}) {
    this.path = path;
    this.lockPath = `${path.replace(/\.json$/, "")}.lock`;
    this.now = now;
    this.log = log;
    this.lockWaitMs = lockWaitMs;
    this.pid = pid;
  }

  /** The file as it stands: a missing one is a first run and reads as empty. Stale entries are still in it; `live` drops them. */
  read(): LedgerRead {
    if (!existsSync(this.path)) return { ok: true, ledger: emptyLedger() };
    let parsed: Partial<Ledger>;
    try { parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Ledger>; } catch (cause) {
      return { ok: false, reason: `the lease ledger is unreadable, so every box reads as held: ${(cause as Error).message}` };
    }
    if (parsed?.version !== LEDGER_VERSION || !Array.isArray(parsed.leases) || !Array.isArray(parsed.queue)) {
      return { ok: false, reason: `the lease ledger is version ${JSON.stringify(parsed?.version)}, and this code reads version ${LEDGER_VERSION}, so every box reads as held` };
    }
    return { ok: true, ledger: parsed as Ledger };
  }

  /** The ledger at this moment, stale entries dropped. For `fleet lease list` and the status view; takes no lock. */
  live(): LedgerRead {
    const read = this.read();
    return read.ok ? { ok: true, ledger: liveOf(read.ledger, this.now()) } : read;
  }

  private acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const until = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeFileSync(fd, String(this.pid));
        closeSync(fd);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (this.breakIfStale()) continue;
      if (Date.now() >= until) throw new LedgerBusy(`the lease ledger lock is held (${this.holderOfLock() ?? "unknown pid"}) and did not clear in ${this.lockWaitMs}ms`);
      sleepSync(5);
    }
  }

  private holderOfLock(): number | null {
    try {
      const pid = Number(readFileSync(this.lockPath, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  }

  /** Whether the lock file is one to break: its pid is dead, it has no pid and is old, or it is older than any critical section can be (a reused pid). */
  private lockIsStale(): boolean {
    const pid = this.holderOfLock();
    let ageMs: number;
    try { ageMs = Date.now() - statSync(this.lockPath).mtimeMs; } catch { return false; }
    if (ageMs >= LOCK_MAX_AGE_MS) return true;
    return pid === null ? ageMs >= this.lockWaitMs : !isAlive(pid);
  }

  /**
   * Break a stale lock. Two waiters that both see a dead pid must not both unlink, or the second removes the lock the first has just taken; so the
   * check and the unlink are done under `ledger.lock.break`, a lock of its own that is held for a few microseconds. Only a breaker removes a lock that
   * its owner has not released, and a lock cannot be created while one exists, so within the break lock the stale lock is still the one that was checked.
   */
  private breakIfStale(): boolean {
    if (!this.lockIsStale()) return false;
    const breaking = `${this.lockPath}.break`;
    try {
      closeSync(openSync(breaking, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(breaking).mtimeMs >= LOCK_MAX_AGE_MS) unlinkSync(breaking); } catch { /* gone already */ }
      return false;
    }
    try {
      if (this.lockIsStale()) unlinkSync(this.lockPath);
    } catch { /* the lock went away by itself */ } finally {
      try { unlinkSync(breaking); } catch { /* already gone */ }
    }
    return true;
  }

  private release(): void { try { unlinkSync(this.lockPath); } catch { /* already gone */ } }

  /**
   * One change: read, decide with `decide(ledger, now)`, write. `decide` returns the new ledger (or null to leave the file alone) and the answer.
   * An unreadable ledger is not written over; `onUnreadable` is the answer instead.
   */
  private change<T>(decide: (ledger: Ledger, now: number) => { ledger: Ledger | null; answer: T }, onUnreadable: (reason: string) => T): T {
    this.acquire();
    try {
      const read = this.read();
      if (!read.ok) { this.log(read.reason); return onUnreadable(read.reason); }
      const now = this.now();
      const { ledger, answer } = decide(liveOf(read.ledger, now), now);
      if (ledger) {
        const temp = `${this.path}.${this.pid}.tmp`;
        writeFileSync(temp, `${JSON.stringify(ledger, null, 1)}\n`);
        renameSync(temp, this.path);
      }
      return answer;
    } finally { this.release(); }
  }

  /** Join the queue. Asking again with the same `id` keeps the place it has: the position is the `enqueuedAt` given, so a restart loses none. */
  enqueue(spec: Spec & { want: Want; enqueuedAt: number; ttlMs?: number }): void {
    this.change((ledger, now) => {
      const entry: Waiter = { id: spec.id, holder: spec.holder, kind: spec.kind as Waiter["kind"], want: spec.want, enqueuedAt: spec.enqueuedAt, label: spec.label,
        expiresAt: now + (spec.ttlMs ?? LEASE_GRACE_MS) };
      return { ledger: { ...ledger, queue: [...ledger.queue.filter((w) => w.id !== spec.id), entry] }, answer: undefined };
    }, () => undefined);
  }

  /** What a queued waiter can have now: the boxes it is excluded from, and whether it holds the turn. */
  grantable(waiterId: string): ReturnType<typeof availability> {
    const read = this.live();
    if (!read.ok) return { grantable: false, excluded: {}, waitingOn: [read.reason], reason: read.reason };
    return availability(read.ledger, waiterId);
  }

  /** Take exactly `boxes` for a queued waiter: all of them, or none and who is in the way. The waiter leaves the queue and becomes the holder. */
  take(waiterId: string, boxes: string[], { ttlMs = LEASE_GRACE_MS, expectedEnd = null }: { ttlMs?: number; expectedEnd?: number | null } = {}): Took {
    return this.change((ledger, now): { ledger: Ledger | null; answer: Took } => {
      const waiter = ledger.queue.find((w) => w.id === waiterId);
      const verdict = mayTake(ledger, waiterId, boxes);
      if (!verdict.taken || !waiter) return { ledger: null, answer: refused(verdict) };
      const lease: Lease = { id: waiter.id, holder: waiter.holder, kind: waiter.kind, boxes: [...boxes], label: waiter.label, takenAt: now, renewedAt: now, expiresAt: now + ttlMs, expectedEnd };
      return { ledger: { ...ledger, leases: [...ledger.leases.filter((l) => l.id !== lease.id), lease], queue: ledger.queue.filter((w) => w.id !== waiterId) }, answer: { taken: true, lease } };
    }, (reason) => ({ taken: false, heldBy: {}, reason }));
  }

  /**
   * Take without queueing: the drift check's `read`, auto-off's shutdown, a resumed job's own boxes. The boxes are free of incompatible live leases, or
   * nothing is taken. A lease of the same `id` is replaced, so taking again renews.
   */
  tryTake(spec: TakeSpec): Took {
    return this.change((ledger, now): { ledger: Ledger | null; answer: Took } => {
      const verdict = mayTakeNow(ledger, spec.kind, spec.boxes, { exceptId: spec.id, respectQueue: spec.respectQueue });
      if (!verdict.taken) return { ledger: null, answer: refused(verdict) };
      const lease: Lease = { id: spec.id, holder: spec.holder, kind: spec.kind, boxes: [...spec.boxes], label: spec.label, takenAt: now, renewedAt: now,
        expiresAt: now + (spec.ttlMs ?? LEASE_GRACE_MS), expectedEnd: spec.expectedEnd ?? null };
      return { ledger: { ...ledger, leases: [...ledger.leases.filter((l) => l.id !== lease.id), lease] }, answer: { taken: true, lease } };
    }, (reason) => ({ taken: false, heldBy: {}, reason }));
  }

  /** Let go of the whole lease and of any queue entry with this `id`. */
  releaseAll(id: string): void {
    this.change((ledger) => ({ ledger: { ...ledger, leases: ledger.leases.filter((l) => l.id !== id), queue: ledger.queue.filter((w) => w.id !== id) }, answer: undefined }), () => undefined);
  }

  /** Let go of some of a lease's boxes, so the next waiter can start on them before the holder is done with the rest. */
  releaseBoxes(id: string, boxes: string[]): void {
    this.change((ledger) => {
      const leases = ledger.leases.flatMap((l) => {
        if (l.id !== id) return [l];
        const left = l.boxes.filter((box) => !boxes.includes(box));
        return left.length ? [{ ...l, boxes: left }] : [];
      });
      return { ledger: { ...ledger, leases }, answer: undefined };
    }, () => undefined);
  }

  /** Push the lease and the queue entry `id` out by `ttlMs`, and say when the holder expects to be done. A holder that stops renewing frees its boxes at `expiresAt`. */
  renew(id: string, { ttlMs = LEASE_GRACE_MS, expectedEnd }: { ttlMs?: number; expectedEnd?: number | null } = {}): void {
    this.change((ledger, now) => ({
      ledger: {
        ...ledger,
        leases: ledger.leases.map((l) => l.id === id ? { ...l, renewedAt: now, expiresAt: now + ttlMs, ...(expectedEnd === undefined ? {} : { expectedEnd }) } : l),
        queue: ledger.queue.map((w) => w.id === id ? { ...w, expiresAt: now + ttlMs } : w),
      },
      answer: undefined,
    }), () => undefined);
  }

  /** The lease `id` holds now, if it is live. */
  leaseOf(id: string): Lease | null {
    const read = this.live();
    return read.ok ? read.ledger.leases.find((l) => l.id === id) ?? null : null;
  }

  /** Who holds each box now, for a log line or a refusal. Reads that share a box are listed too. */
  held(): Record<string, string[]> {
    const read = this.live();
    if (!read.ok) return {};
    const held: Record<string, string[]> = {};
    for (const lease of read.ledger.leases) for (const box of lease.boxes) held[box] = [...(held[box] ?? []), lease.holder];
    return held;
  }

  /** A waiter's place in the live queue. */
  place(waiterId: string): { place: number; of: number } | null {
    const read = this.live();
    return read.ok ? placeOf(read.ledger, waiterId) : null;
  }

  /** The queue in the order it is served. */
  queued(): Waiter[] {
    const read = this.live();
    return read.ok ? inOrder(read.ledger.queue) : [];
  }
}

const refused = (verdict: Taking): Took =>
  verdict.taken ? { taken: false, heldBy: {}, reason: "not taken" } : { taken: false, heldBy: verdict.heldBy, reason: verdict.reason };
