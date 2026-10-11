/**
 * THE FLEET LOCK (a11ign#5014, #4405 item 2): a fleet operation says "the boxes are mine" in a file, and
 * `fleet-auto-off.ts` reads it. One file on the control plane, `runs/fleet-lock.json`, written by the operation
 * itself -- which is why auto-off may read it where it may not read `Fleet-hold-until:` (#2737: a hold is a
 * sentence anyone can write, and this is a fact the operation wrote about itself).
 *
 * WHY THE UNIT IS NOT ENOUGH (#3543). `a11y-fleet-<playbook>` keeps every box while it RUNS, and a run that FAILS is
 * `finished` to that reading, so five idle minutes later the boxes are powered off before the next attempt of the
 * same operation: the chairman's "runs 2 onward: UNREACHABLE". The lock has to outlive the unit.
 *
 * ```
 * take        -> { operation, holder, takenAt, expiresAt = takenAt + the operation's longest run }
 * unit ends   -> { ..., expiresAt = now + LOCK_GRACE_MS, endedAt = now }       (shortened, NOT cleared)
 * expiresAt   -> `stale`: ignored by auto-off, and replaced by the next take
 * ```
 *
 * A LOCK NOBODY ENDED stops counting at `expiresAt`, so a crashed run cannot keep the fleet awake for ever (ceo).
 * `unreadable` is its own answer and reads as held, as `play-unreadable` does: a file nobody can read is not
 * evidence that nobody holds it, and the other reading powers a box off mid-operation.
 *
 * THE FILE IS THE CONTROL PLANE'S, reached through `sshToControlPlane` wherever this runs, exactly as the wake-proof
 * ledger is (#3269): the operator's laptop writes it, the timer on the control plane reads it. Every write is ONE
 * remote step under `flock` that reads, decides and writes, so two operations starting together cannot both take
 * it. The step is INLINE `node -e` and not an import from the control plane's checkout, for the reason
 * `fleet-wake.ts`'s `REMOTE_ADVANCE` records (#3271): that checkout has not necessarily moved when this writer runs.
 * Clocks are the caller's `now`: the writer and the timer disagree by seconds at most, against windows of 30 minutes
 * and up.
 *
 * AN ENDED LOCK DOES NOT REFUSE A DIFFERENT OPERATION (judgment, recorded on the row). It still keeps auto-off off
 * for the grace, because the next attempt is the thing it exists for; but `fleet:deploy` straight after a finished
 * `fleet:provision` is the ordinary sequence and must not wait half an hour. What refuses is a lock whose own
 * operation has not ended.
 */
import { hostname } from "node:os";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { sshToControlPlane } from "./control-plane-fleet.ts";

/** The one address, absolute, because `fleet:auto-off`'s timer reads it ON the control plane (`DEFAULT_PROOF_PATH`'s reason). */
export const FLEET_LOCK_PATH = `${CONTROL_PLANE_CHECKOUT_PATH}/runs/fleet-lock.json`;

/**
 * The plays that take the lock: the three that walk the whole fleet and are re-run in sequence when one box fails.
 * `sleep.yml` never (it is what auto-off dispatches: a lock it took would hold off its own successor), and
 * `recover.yml` and the rest act on one named box and are not a sequence.
 */
export const FLEET_LOCK_PLAYBOOKS = ["deploy.yml", "provision-role.yml", "patch.yml"];

/**
 * HOW LONG AN ENDED OPERATION'S LOCK KEEPS THE FLEET AWAKE. A JUDGMENT, NOT A MEASUREMENT (the row names 30 minutes):
 * it has to cover reading a failed recap, fixing the cause and typing the same command again, which is the gap the
 * eight hand-run provision attempts of a11ign#4948 lost boxes in, and is six times auto-off's own five-minute idle
 * threshold. Longer buys nothing the next attempt needs and keeps 15 boxes powered after a sequence is finished;
 * shorter is the failure being fixed.
 */
export const LOCK_GRACE_MINUTES = 30;
const MS_PER_MINUTE = 60_000;
export const LOCK_GRACE_MS = LOCK_GRACE_MINUTES * MS_PER_MINUTE;

export type FleetLock = { operation: string; holder: string; takenAt: number; expiresAt: number; endedAt?: number };
export type FleetLockReading =
  | { state: "none" }
  | { state: "held" | "stale"; lock: FleetLock }
  | { state: "unreadable"; detail: string };
export type FleetLockState = FleetLockReading["state"];
export type LockTransport = (command: string, options?: { capture?: boolean }) => string;

export type TakeOutcome = { taken: true; lock: FleetLock; replacedUnreadable: boolean } | { taken: false; held: FleetLock };

type LockFiles = { path?: string; transport?: LockTransport };

/** Who is asking, as a lock records it: this process on this machine, which is what one attempt of a sequence is. */
export const lockHolder = (): string => `${hostname()}:${process.pid}`;

const PATH_SHAPE = /^\/[\w./-]+$/;

// The path goes into a remote shell, so it is refused unless it is a plain absolute path (`fleet-wake.ts` does the same).
function shellPath(path: string): string {
  if (!PATH_SHAPE.test(path)) throw new Error(`the fleet lock path is not a plain absolute path: ${path}`);
  return `'${path}'`;
}

/** A MISSING file prints nothing and succeeds, so it reads as no lock; a transport that fails throws. The two must not share a value. */
export const lockReadCommand = (path: string): string => `if [ -f ${shellPath(path)} ]; then cat ${shellPath(path)}; fi`;

/** What the remote steps share: the file read as a valid lock, or null for none, or `unreadable` -- as `parseFleetLock` reads it. */
const REMOTE_READ = [
  'const fs = require("fs");',
  'const [path, encoded] = process.argv.slice(1);',
  'const want = JSON.parse(Buffer.from(encoded, "base64").toString());',
  'let held = null; let unreadable = false;',
  'try { held = JSON.parse(fs.readFileSync(path, "utf8"));',
  '  const ok = held && typeof held.operation === "string" && typeof held.holder === "string"',
  '    && Number.isFinite(held.takenAt) && Number.isFinite(held.expiresAt);',
  '  if (!ok) { held = null; unreadable = true; }',
  '} catch (e) { held = null; unreadable = e.code !== "ENOENT"; }',
  'const write = (lock) => { fs.writeFileSync(path + ".tmp", JSON.stringify(lock, null, 2) + "\\n"); fs.renameSync(path + ".tmp", path); };',
].join(" ");

/**
 * Take: refused only by a lock that is FRESH, NOT ENDED, and a DIFFERENT operation's. The same operation always takes
 * (a sequence's next attempt, or a re-run from another session after a crash that never ended its lock). A file that
 * cannot be read is REPLACED and says so: it names no operation to protect, and a refusal only an operator with a
 * shell could lift is worse than the overwrite.
 */
const REMOTE_TAKE = REMOTE_READ + [
  ' if (held && held.expiresAt > want.now && held.endedAt === undefined && held.operation !== want.operation) {',
  '  console.log(JSON.stringify({ taken: false, held })); process.exit(0); }',
  'const lock = { operation: want.operation, holder: want.holder, takenAt: want.now, expiresAt: want.now + want.longestRunMs };',
  'write(lock);',
  'console.log(JSON.stringify({ taken: true, lock, replacedUnreadable: unreadable }));',
].join(" ");

/** End: only the holder that took it shortens it, so a wrapper that outlived its lock never shortens a successor's. */
const REMOTE_END = REMOTE_READ + [
  ' if (!held || held.operation !== want.operation || held.holder !== want.holder) {',
  '  console.log(JSON.stringify({ ended: false })); process.exit(0); }',
  'const lock = { ...held, expiresAt: want.now + want.graceMs, endedAt: want.now };',
  'write(lock);',
  'console.log(JSON.stringify({ ended: true, lock }));',
].join(" ");

/** One remote step: read, decide and write under `flock`, so two operations starting together cannot both win. */
export function lockWriteCommand(path: string, script: string, request: object): string {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
  const file = shellPath(path);
  return `mkdir -p "$(dirname ${file})" && flock ${shellPath(`${path}.lock`)} node -e '${script}' ${file} ${encoded}`;
}

const isLock = (value: unknown): value is FleetLock => {
  const lock = value as Partial<FleetLock> | null;
  return typeof lock?.operation === "string" && typeof lock.holder === "string"
    && Number.isFinite(lock.takenAt) && Number.isFinite(lock.expiresAt)
    && (lock.endedAt === undefined || Number.isFinite(lock.endedAt));
};

/** The file's text as a reading at `now`. Empty is `none`; anything that is not a whole lock is `unreadable`, never `none`. */
export function parseFleetLock(text: string, now: number): FleetLockReading {
  if (text.trim() === "") return { state: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { state: "unreadable", detail: `not JSON (${(cause as Error).message})` };
  }
  if (!isLock(parsed)) return { state: "unreadable", detail: "JSON without operation, holder, takenAt and expiresAt" };
  return { state: parsed.expiresAt > now ? "held" : "stale", lock: parsed };
}

/**
 * Is the fleet held at `now`? A transport that FAILS is `unreadable` (and `log` says so), never `none`: an
 * unreachable control plane is not an answer that nobody holds the fleet.
 */
export function readFleetLock(now: number, { path = FLEET_LOCK_PATH, transport = sshToControlPlane, log = () => {} }: LockFiles & { log?: (line: string) => void } = {}): FleetLockReading {
  let text: string;
  try {
    text = transport(lockReadCommand(path), { capture: true });
  } catch (cause) {
    const detail = `the fleet lock could not be read (${path}): ${cause instanceof Error ? cause.message : String(cause)}`;
    log(detail);
    return { state: "unreadable", detail };
  }
  const reading = parseFleetLock(text, now);
  if (reading.state === "unreadable") log(`the fleet lock is unreadable (${path}): ${reading.detail}`);
  return reading;
}

function answer(text: string, what: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (cause) {
    throw new Error(`the fleet lock ${what} answered something that is not JSON: ${JSON.stringify(text.slice(0, 200))}`, { cause });
  }
  throw new Error(`the fleet lock ${what} answered a JSON value that is not an object: ${JSON.stringify(text.slice(0, 200))}`);
}

/**
 * Take the lock for `operation`, which `longestRunMs` bounds: the caller derives that from the play's own ceiling
 * (`PLAYBOOK_TIMEOUT_MS`), so this file copies no run length. THROWS when the control plane cannot be asked, because
 * a lock that was not written must never read as one that was.
 */
export function takeFleetLock({ operation, longestRunMs, now, holder = lockHolder(), path = FLEET_LOCK_PATH, transport = sshToControlPlane }:
  { operation: string; longestRunMs: number; now: number; holder?: string } & LockFiles): TakeOutcome {
  const request = { operation, holder, now, longestRunMs };
  const said = answer(transport(lockWriteCommand(path, REMOTE_TAKE, request), { capture: true }), "take");
  if (said.taken === true && isLock(said.lock)) return { taken: true, lock: said.lock, replacedUnreadable: said.replacedUnreadable === true };
  if (said.taken === false && isLock(said.held)) return { taken: false, held: said.held };
  throw new Error(`the fleet lock take answered neither taken nor refused: ${JSON.stringify(said).slice(0, 200)}`);
}

/**
 * THE OPERATION'S UNIT ENDED (any exit): shorten the lock to `now + graceMs` and mark it ended, never clear it, so the
 * next attempt of a sequence meets awake boxes and a finished sequence lets go on its own. Only the holder that took
 * it can; `ended: false` is a lock that is gone or another run's.
 */
export function expireFleetLock({ operation, now, holder = lockHolder(), graceMs = LOCK_GRACE_MS, path = FLEET_LOCK_PATH, transport = sshToControlPlane }:
  { operation: string; now: number; holder?: string; graceMs?: number } & LockFiles): { ended: boolean; lock?: FleetLock } {
  const said = answer(transport(lockWriteCommand(path, REMOTE_END, { operation, holder, now, graceMs }), { capture: true }), "end");
  if (said.ended === true && isLock(said.lock)) return { ended: true, lock: said.lock };
  if (said.ended === false) return { ended: false };
  throw new Error(`the fleet lock end answered neither ended nor not: ${JSON.stringify(said).slice(0, 200)}`);
}

/** The refusal's words: who holds the fleet, until when, and that it clears itself. Starts `REFUSING`, as `runApplyChild` reads it. */
export function fleetLockRefusal({ held, wanted, now }: { held: FleetLock; wanted: string; now: number }): string {
  const minutes = Math.max(1, Math.ceil((held.expiresAt - now) / MS_PER_MINUTE));
  return `REFUSING ${wanted}: the fleet lock is held by ${held.operation} (taken by ${held.holder} at `
    + `${new Date(held.takenAt).toISOString()}), and that operation has not ended. It stops counting at `
    + `${new Date(held.expiresAt).toISOString()} (in ${minutes} min) on its own; or end it. A different fleet `
    + "operation does not start under one that is still walking the boxes.";
}
