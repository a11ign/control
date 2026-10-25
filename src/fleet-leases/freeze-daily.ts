import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inventoryPathFor } from "../control-plane-fleet.ts";
import { inventoryHosts } from "../fleet-discover.ts";
import { ledgerOnThisHost } from "./booking.ts";
import type { LeaseLedger } from "./ledger.ts";
import { LEASE_GRACE_MS, RENEW_EVERY_MS } from "./types.ts";

/**
 * THE DAILY FREEZE, BOOKED (A11-244, under A11-205's docs/adr/0001). `a11y-fleet-freeze-daily.service` used to run `ansible-playbook freeze.yml` on every
 * box at once. This is its `ExecStart` now: it takes an exclusive `maintain` lease on each box first, so the freeze never lands in the middle of a capture,
 * and it never holds a box a job is waiting for longer than its own work.
 *
 * It queues one `maintain` waiter per inventory box, all at the run's start time, so a job queued before the run is served first and a job queued after it
 * waits behind the freeze's turn on that box. Then, every 30 s, it takes the boxes it can have, runs `freeze.yml --limit <those>` on them as one batch, lets
 * each box go as the batch ends, and renews whatever is still waiting. A box held by a capture is frozen in a LATER batch, when its lease is let go.
 *
 * EVERY WAIT HAS AN END. At 6 hours it stops waiting: a box it never got is named in the record's `leased` (box -> who held it), is NOT frozen today, and the
 * run exits non-zero so `systemctl --failed` shows it. The next daily run, or `pnpm run fleet:freeze`, freezes it.
 *
 * It runs only `ansible-playbook freeze.yml`, with `--limit` and one extra var (where the batch writes its record), so everything `freeze.yml` does and
 * refuses is unchanged. `no-scheduled-install.test.ts` reads this file and holds that no other program or playbook is named in it.
 */
export const DEADLINE_MS = 6 * 60 * 60_000;
export const POLL_MS = 30_000;
/** A batch the play wrote no record for is tried again this long after, until the deadline. */
export const RETRY_AFTER_MS = 10 * 60_000;
/** One `ansible-playbook freeze.yml` batch is killed after this, so a hung play cannot outlast the deadline and be cut by systemd with no record. */
export const BATCH_TIMEOUT_MS = 90 * 60_000;
/** What a batch is expected to take per run, for the estimated start of a job that waits behind it. */
export const BATCH_ESTIMATE_MS = 10 * 60_000;

/** The record `freeze.yml` writes (`runs/fleet-freeze-last-run.json`), plus `leased`: the boxes still leased at the deadline, so not frozen today. */
export type FreezeRecord = {
  checkedAt: string;
  scope: string;
  frozen: string[];
  putBack: Record<string, string[]>;
  unreachable: string[];
  failed: string[];
  leased: Record<string, string>;
};

type BatchRecord = Pick<FreezeRecord, "frozen" | "putBack" | "unreachable" | "failed">;
export type Batch = { boxes: string[]; status: number | null; record: BatchRecord | null };

export type FreezeDeps = {
  ledger: LeaseLedger;
  /** The inventory's workers: every one of them is frozen, or named in `leased`. */
  boxes: string[];
  /** Runs `freeze.yml` on these boxes and says how it ended. The batch writes its own record to `recordPath`. */
  runPlaybook: (boxes: string[], recordPath: string) => Promise<number | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Calls `renew` on a clock until the returned function is called; a test supplies its own. */
  heartbeat?: (renew: () => void) => () => void;
  deadlineMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
};

export type FreezeOutcome = { record: FreezeRecord; batches: Batch[]; exitCode: number };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

/** A batch's record as `freeze.yml` wrote it, or `null` when it is missing or is not that shape (the play stopped before it wrote one). */
export function batchRecordOf(text: string | null): BatchRecord | null {
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!isObject(parsed) || typeof parsed.checkedAt !== "string") return null;
  const putBack = isObject(parsed.putBack) ? Object.fromEntries(Object.entries(parsed.putBack).map(([box, levers]) => [box, strings(levers)])) : {};
  return { frozen: strings(parsed.frozen), putBack, unreachable: strings(parsed.unreachable), failed: strings(parsed.failed) };
}

const byName = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const sorted = (boxes: Iterable<string>): string[] => [...new Set(boxes)].sort(byName);

/**
 * The day's record, in the shape `freeze.yml` writes. A batch that wrote no record leaves its boxes `failed`: they were reached by nobody, and "not frozen"
 * must never read as frozen. The record of a run that was cut short by the deadline says so in `leased`.
 */
export function mergeRecords({ batches, leased, checkedAt }: { batches: Batch[]; leased: Record<string, string>; checkedAt: string }): FreezeRecord {
  const parts = batches.map((batch) => batch.record ?? { frozen: [], putBack: {}, unreachable: [], failed: batch.boxes });
  return {
    checkedAt, scope: "the fleet",
    frozen: sorted(parts.flatMap((part) => part.frozen)),
    putBack: Object.fromEntries(parts.flatMap((part) => Object.entries(part.putBack)).sort(([a], [b]) => byName(a, b))),
    unreachable: sorted(parts.flatMap((part) => part.unreachable)),
    failed: sorted(parts.flatMap((part) => part.failed)),
    leased: Object.fromEntries(Object.entries(leased).sort(([a], [b]) => byName(a, b))),
  };
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const everyRenewal = (renew: () => void): (() => void) => { const timer = setInterval(renew, RENEW_EVERY_MS); return () => clearInterval(timer); };

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** One box's place in the freeze's run: its waiter id, and what the last take said about who is in the way. */
class Booking {
  private readonly waiting = new Map<string, string>();
  /** Box -> why the ledger refused to queue it, while it does: a better answer than "not in the queue". */
  private readonly faults = new Map<string, string>();
  private readonly ledger: LeaseLedger;
  private readonly holder: string;
  private readonly startedAt: number;

  private readonly log: (line: string) => void;

  constructor(ledger: LeaseLedger, holder: string, startedAt: number, log: (line: string) => void) {
    this.ledger = ledger;
    this.holder = holder;
    this.startedAt = startedAt;
    this.log = log;
  }

  /**
   * A ledger call that a locked or unreadable ledger refuses is "not now": the next poll asks again. It is never silent, because a ledger that fails for
   * good (no permission on its directory) would otherwise read as a long wait for a lease nobody holds.
   */
  private tried(what: string, call: () => void): string | null {
    try { call(); return null; } catch (cause) { this.log(`freeze: ${what}: ${messageOf(cause)}`); return messageOf(cause); }
  }

  idOf(box: string): string { return `${this.holder}:${box}`; }

  /**
   * Every poll puts every waiting box in the queue again. Asking twice keeps the place (the position is `enqueuedAt`, the run's start), and it refreshes the
   * entry, so a waiter the ledger dropped as stale, or that a locked ledger never took, is back in its place on the next poll.
   */
  enqueue(boxes: string[]): void {
    for (const box of boxes) {
      const fault = this.tried(`could not queue ${box}`, () => this.ledger.enqueue({ id: this.idOf(box), holder: this.holder, kind: "maintain", label: "fleet-freeze-daily",
        want: { named: [box] }, enqueuedAt: this.startedAt, ttlMs: LEASE_GRACE_MS }));
      if (fault === null) this.faults.delete(box); else this.faults.set(box, fault);
    }
  }

  /** The boxes of `pending` the freeze holds after this call: each taken whole, or not at all, with who is in the way noted. */
  takeFree(pending: string[], now: number): string[] {
    return pending.filter((box) => {
      try {
        const took = this.ledger.take(this.idOf(box), [box], { ttlMs: LEASE_GRACE_MS, expectedEnd: now + BATCH_ESTIMATE_MS });
        if (!took.taken) this.waiting.set(box, took.heldBy[box]?.join(", ") ?? took.reason);
        return took.taken;
      } catch (cause) {
        this.waiting.set(box, messageOf(cause));
        return false;
      }
    });
  }

  renew(boxes: string[]): void {
    for (const box of boxes) this.tried(`could not renew ${box}`, () => this.ledger.renew(this.idOf(box), { ttlMs: LEASE_GRACE_MS }));
  }

  release(boxes: string[]): void {
    for (const box of boxes) this.tried(`could not release ${box}`, () => this.ledger.releaseAll(this.idOf(box)));
  }

  /** Box -> who it was waiting on when the run stopped waiting. */
  blockedBy(boxes: string[]): Record<string, string> {
    return Object.fromEntries(boxes.map((box) => [box, this.faults.get(box) ?? this.waiting.get(box) ?? "it was never offered a turn"]));
  }
}

/** What the run needs once its defaults are filled in. */
type Run = {
  booking: Booking; runPlaybook: FreezeDeps["runPlaybook"]; now: () => number; sleep: (ms: number) => Promise<void>; pollMs: number; log: (line: string) => void;
};

/** Where the run stands: the boxes still to freeze, the ones on a batch now, and the ones a play gave no record for (box -> how the play ended). */
type Progress = { pending: Set<string>; running: Set<string>; unrecorded: Map<string, number | null>; retryAt: Map<string, number>; batches: Batch[] };

/**
 * One round: queue the boxes that are due, take the free ones and freeze them as a batch, or wait one poll if none is free. A batch the play wrote a
 * record for is kept. The play wrote NO record when it refused before it froze anything (its `patch`-running guard, say) or died: nothing is known about
 * those boxes, so they are not frozen and not failed yet, and are tried again later until the deadline, where a box that never got a record is `failed`.
 */
async function freezeRound(run: Run, progress: Progress): Promise<void> {
  const { booking, now } = run;
  const eligible = [...progress.pending].filter((box) => (progress.retryAt.get(box) ?? 0) <= now());
  booking.enqueue(eligible);
  const taken = booking.takeFree(eligible, now());
  if (taken.length === 0) { await run.sleep(run.pollMs); return; }
  for (const box of taken) { progress.pending.delete(box); progress.running.add(box); }
  run.log(`freeze: ${taken.join(", ")} leased, freezing`);
  const batch = await runBatch(taken, run.runPlaybook).finally(() => {
    booking.release(taken);
    for (const box of taken) progress.running.delete(box);
  });
  settle(batch, taken, progress, run);
}

function settle(batch: Batch, taken: string[], progress: Progress, run: Run): void {
  if (batch.record !== null) {
    progress.batches.push(batch);
    for (const box of taken) progress.unrecorded.delete(box);
    return;
  }
  run.log(`freeze: the play wrote no record for ${taken.join(", ")} (exit ${batch.status}); trying again in ${RETRY_AFTER_MS / 60_000} minutes`);
  for (const box of taken) {
    progress.pending.add(box);
    progress.unrecorded.set(box, batch.status);
    progress.retryAt.set(box, run.now() + RETRY_AFTER_MS);
  }
}

/** The day's outcome once the deadline has passed or every box is done: what never froze is `failed` (the play gave no record) or `leased` (it never got a lease). */
function closeOut(run: Run, progress: Progress): FreezeOutcome {
  const left = [...progress.pending];
  const refused = left.filter((box) => progress.unrecorded.has(box));
  const leased = run.booking.blockedBy(left.filter((box) => !progress.unrecorded.has(box)));
  run.booking.release(left);
  if (left.length > 0) run.log(`freeze: ${left.length} box(es) were not frozen today at the deadline: ${left.map((box) => `${box} (${leased[box] ?? "the play wrote no record"})`).join(", ")}`);
  const unfrozen = refused.map((box): Batch => ({ boxes: [box], status: progress.unrecorded.get(box) ?? null, record: null }));
  const record = mergeRecords({ batches: [...progress.batches, ...unfrozen], leased, checkedAt: new Date(run.now()).toISOString() });
  const playFailed = progress.batches.some((batch) => batch.status !== 0);
  return { record, batches: progress.batches, exitCode: playFailed || left.length > 0 ? 1 : 0 };
}

/**
 * The whole run. Every dependency is injected, so a test drives it with a fake `ansible-playbook`, a clock and a ledger in a temp directory.
 */
export async function runDailyFreeze(deps: FreezeDeps): Promise<FreezeOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const log = deps.log ?? (() => {});
  const booking = new Booking(deps.ledger, `fleet-freeze:${new Date(startedAt).toISOString()}`, startedAt, log);
  const run: Run = { booking, runPlaybook: deps.runPlaybook, now, sleep: deps.sleep ?? sleepFor, pollMs: deps.pollMs ?? POLL_MS, log };
  const progress: Progress = { pending: new Set(deps.boxes), running: new Set(), unrecorded: new Map(), retryAt: new Map(), batches: [] };
  const deadline = startedAt + (deps.deadlineMs ?? DEADLINE_MS);
  const stopRenewing = (deps.heartbeat ?? everyRenewal)(() => booking.renew([...progress.pending, ...progress.running]));
  try {
    while (progress.pending.size > 0 && now() < deadline) await freezeRound(run, progress);
  } finally {
    stopRenewing();
  }
  return closeOut(run, progress);
}

async function runBatch(boxes: string[], runPlaybook: FreezeDeps["runPlaybook"]): Promise<Batch> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-freeze-"));
  const recordPath = join(dir, "record.json");
  try {
    const status = await runPlaybook(boxes, recordPath);
    return { boxes, status, record: batchRecordOf(readOrNull(recordPath)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readOrNull(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RECORD_PATH = join(ROOT, "runs", "fleet-freeze-last-run.json");

/**
 * The real `runPlaybook`: `freeze.yml` on `boxes`, from `ansible/` (the unit's `ANSIBLE_CONFIG=ansible.cfg` is relative to it), its output going to the journal.
 * It resolves with the play's exit status, or `null` when the play could not start or was killed (a signal, or `timeoutMs` passing). The program, the
 * directory and the timeout are arguments only so a test can run a stand-in; `main` uses the defaults.
 */
export function playbookRunner({ program = "ansible-playbook", cwd = join(ROOT, "ansible"), timeoutMs = BATCH_TIMEOUT_MS }: { program?: string; cwd?: string; timeoutMs?: number } = {}): FreezeDeps["runPlaybook"] {
  return (boxes, recordPath) => new Promise((resolve) => {
    const child = spawn(program, ["freeze.yml", "--limit", boxes.join(","), "-e", `freeze_record_path=${recordPath}`], { cwd, stdio: "inherit" });
    const hung = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", () => { clearTimeout(hung); resolve(null); });
    child.on("close", (status) => { clearTimeout(hung); resolve(status); });
  });
}

function writeRecord(path: string, record: FreezeRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(partial, path);
}

async function main(): Promise<void> {
  const boxes = inventoryHosts(readFileSync(inventoryPathFor(), "utf8")).map(({ name }) => name);
  if (boxes.length === 0) {
    // `ansible-playbook` exits 0 on zero hosts, so a daily run could "pass" having frozen nothing.
    process.stderr.write("freeze: no workers in inventory.yml, nothing was frozen\n");
    process.exitCode = 2;
    return;
  }
  const log = (line: string): void => { process.stdout.write(`${line}\n`); };
  const { record, exitCode } = await runDailyFreeze({ ledger: ledgerOnThisHost(log), boxes, runPlaybook: playbookRunner(), log });
  writeRecord(RECORD_PATH, record);
  process.exitCode = exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
