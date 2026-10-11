/**
 * ## WHICH BOXES A JOB IS GIVEN WHEN IT ASKED FOR "ALL READY" OR "N" (a11ign#5017, part of #4405 item 4)
 *
 * `-e workers=` used to name boxes or cap the pool at "the first N in inventory order", and nothing chose by
 * load or by which boxes were up. The chairman asked for the whole fleet to be used, balanced: `workers=ready`
 * takes every ready box, `workers=<N>` takes the N with the FEWEST captures in the last 24 h, and the chosen are
 * woken (confirmed up) before the job starts.
 *
 * THREE PARTS, in the order they are used:
 *
 *   - `chooseWorkers`   PURE. Given the request, each box's state and each box's load, which boxes. It never
 *                       pads: a box that is not `ready` is not chosen to make the number, and a short answer
 *                       says why.
 *   - `resolveDispatch` the I/O around it: probe `/health`, read the capture ledger, choose, then `fleet-wake`
 *                       the chosen. Every dependency is injectable, so a test reads no network and sends no packet.
 *   - the CLI below     what `ansible/lab-job.yml` runs (delegated to the machine running the playbook), and
 *                       it never reads the option `lab_dispatch_balance`: the playbook does, and
 *                       refuses a balanced request before this is run when the option is off.
 *
 * WHAT IS UNKNOWN IS NOT ZERO. A box the capture ledger has no entry for (a box added after the ledger began, or
 * a ledger nobody could read) sorts AFTER every box with a reading and is named, because reading "no entry" as
 * "no captures" would make the newest and least-known box win every request.
 */
import { pathToFileURL } from "node:url";

import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { sshToControlPlane } from "./control-plane-fleet.ts";
import { probeWorker, wakeFailed, wakeFleet, wakeReportLine, type Probe, type WakeTarget } from "./fleet-wake.ts";
import { captureTimes, DEFAULT_CAPTURES_STATE_PATH, readCapturesState, type CapturesState } from "./fleet-watch.ts";

/** `ready` is every ready box; a number is that many, the least loaded. */
export type DispatchRequest = "ready" | number;
/** One box as `fleet:status` states it: `ready`, `busy`, `warming` or `unreachable`. */
export type PoolBox = { name: string; state: string };
/** Captures in the last 24 h, by worker name. A name that is absent has NO reading, which is not zero. */
export type Load = Record<string, number>;
export type Choice =
  | { chosen: string[]; short: boolean; notes: string[]; refusal: null }
  | { chosen: null; short: false; notes: string[]; refusal: string };

const WORKER_PORT = 8765;

/** `ready`, or a positive integer written in digits and nothing else -- `0`, `-1`, `2.5` and `all` are not requests. */
export function parseRequest(text: string): DispatchRequest | null {
  if (text === "ready") return "ready";
  const count = /^[0-9]+$/.test(text) ? Number(text) : 0;
  return count >= 1 ? count : null;
}

/**
 * Each worker's captures in the 24 h before `now`, from the ledger `fleet-watch` and `fleet-auto-off` keep. The
 * window is `captureTimes`' own (one worker's ledger at a time), so it is not restated here.
 */
export function loadByWorker(state: CapturesState | null, now: number): Load {
  if (!state) return {};
  const entries = Object.entries(state.workers).map(([name, worker]) =>
    [name, captureTimes({ since: state.since, workers: { [name]: worker } }, now)?.captures24h] as const);
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, number] => entry[1] !== undefined));
}

/** Fewest captures first, no reading last, ties by name with `a11y-worker-2` before `a11y-worker-10`. */
const leastLoadedFirst = (load: Load) => (a: string, b: string): number => {
  const [loadA, loadB] = [load[a] ?? Infinity, load[b] ?? Infinity];
  return loadA === loadB ? a.localeCompare(b, "en", { numeric: true }) : loadA - loadB;
};

function setAside(pool: PoolBox[]): string {
  const rest = pool.filter((box) => box.state !== "ready");
  return rest.length ? ` Not ready: ${rest.map((box) => `${box.name} (${box.state})`).join(", ")}.` : "";
}

/**
 * Which boxes this request is given. PURE.
 *
 * Only a `ready` box is a candidate: `busy` is taken, `warming` is not usable yet and `unreachable` may be off,
 * and none of them is counted to make up a number. Fewer ready boxes than N returns the ones that exist and says
 * so in `notes` with `short: true`; no ready box at all returns an empty `chosen` and says so, and it is the
 * caller that refuses an empty pick (an empty worker list sends a run to discovery, `lab-job.yml` says why).
 */
export function chooseWorkers({ request, pool, load }: { request: DispatchRequest; pool: PoolBox[]; load: Load }): Choice {
  if (request !== "ready" && !(Number.isInteger(request) && request >= 1)) {
    return { chosen: null, short: false, notes: [],
      refusal: `workers=${String(request)} is not a request: it is \`ready\` or a whole number of boxes, at least 1.` };
  }
  const ready = pool.filter((box) => box.state === "ready").map((box) => box.name).sort(leastLoadedFirst(load));
  const chosen = request === "ready" ? ready : ready.slice(0, request);
  const notes: string[] = [];
  const short = request !== "ready" && chosen.length < request;
  if (!ready.length) notes.push(`No box is ready, so none is chosen.${setAside(pool)}`);
  else if (short) notes.push(`${request} were asked for and ${chosen.length} ${chosen.length === 1 ? "box is" : "boxes are"} ready, so that is what is returned.${setAside(pool)}`);
  const unread = chosen.filter((name) => load[name] === undefined);
  if (unread.length) notes.push(`No capture count for ${unread.join(", ")}: ranked after every box with one, not as zero.`);
  return { chosen, short, notes, refusal: null };
}

/** The `fleet:status` word for what a `/health` probe said. `refused` is a box that is up and not listening yet. */
export function stateOfProbe(probe: Probe): string {
  if (probe.outcome === "ready" || probe.outcome === "busy") return probe.outcome;
  return probe.outcome === "not-ready" ? "warming" : "unreachable";
}

export type DispatchDeps = {
  probe?: (url: string) => Promise<Probe>;
  readLoad?: (now: number) => Load;
  wake?: typeof wakeFleet;
  now?: () => number;
  log?: (line: string) => void;
};

/** The ledger lives on the control plane; `sshToControlPlane` reads it in place there and over ssh elsewhere. */
function readLedgerLoad(now: number): Load {
  const path = `${CONTROL_PLANE_CHECKOUT_PATH}/${DEFAULT_CAPTURES_STATE_PATH}`;
  const read = () => sshToControlPlane(`cat '${path}'`, { capture: true });
  return loadByWorker(readCapturesState(path, read), now);
}

/**
 * Probe the pool, choose, then wake the chosen and keep the ones that answer. A box that was ready a moment ago
 * and has gone (auto-off powers an idle box down after five minutes) is dropped and named, and the result is
 * short rather than padded.
 */
export async function resolveDispatch({ request, pool }: { request: DispatchRequest; pool: WakeTarget[] }, deps: DispatchDeps = {}): Promise<Choice> {
  const { probe = probeWorker, readLoad = readLedgerLoad, wake = wakeFleet, now = Date.now, log = () => {} } = deps;
  const probes = await Promise.all(pool.map((target) => probe(`http://${target.host}:${WORKER_PORT}`)));
  const states = pool.map((target, i): PoolBox => ({ name: target.name, state: stateOfProbe(probes[i] as Probe) }));
  const choice = chooseWorkers({ request, pool: states, load: readLoad(now()) });
  if (choice.refusal !== null || !choice.chosen.length) return choice;

  const results = await wake(pool.filter((target) => choice.chosen.includes(target.name)), { log });
  const gone = results.filter(wakeFailed);
  if (!gone.length) return choice;
  const chosen = choice.chosen.filter((name) => !gone.some((result) => result.name === name));
  return { chosen, refusal: null,
    short: request !== "ready" && chosen.length < request,
    notes: [...choice.notes, `Chosen, then did not come up when woken, so left out: ${gone.map((r) => wakeReportLine(r)).join("; ")}`] };
}

const NAME_SHAPE = /^[\w.-]+$/;
const ADDRESS_SHAPE = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

/** The pool the playbook hands over, built from the inventory there. Names and IPv4 addresses, nothing else. */
export function parsePool(text: string): WakeTarget[] | string {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (cause) { return `--pool is not JSON: ${(cause as Error).message}`; }
  if (!Array.isArray(parsed) || !parsed.length) return "--pool is not a non-empty list of {name, host, mac}.";
  const bad = parsed.find((box) => typeof box?.name !== "string" || !NAME_SHAPE.test(box.name)
    || typeof box?.host !== "string" || !ADDRESS_SHAPE.test(box.host));
  if (bad !== undefined) return `--pool has an entry that is not a worker name and an IPv4 address: ${JSON.stringify(bad)}`;
  return parsed.map(({ name, host, mac }) => ({ name, host, mac: typeof mac === "string" && mac ? mac : null }));
}

export type CliResult = { code: number; stdout: string; stderr: string };

const EXIT = { OK: 0, USAGE: 2, REFUSED: 3 };

/**
 * `node src/fleet-dispatch.ts --request=ready|<N> --pool=<json>`: ONE JSON object on stdout
 * (`{request, chosen, short, notes}`), everything else on stderr, exit 3 when nothing may be chosen. Exit 3 is
 * `lab-job.ts`'s own refusal code, so a caller that treats it as one needs no new case.
 */
export async function cli(argv: string[], deps: DispatchDeps = {}): Promise<CliResult> {
  const flag = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const request = parseRequest(flag("request") ?? "");
  const pool = parsePool(flag("pool") ?? "");
  if (request === null || typeof pool === "string") {
    const why = request === null ? "--request is `ready` or a whole number of boxes, at least 1." : pool as string;
    return { code: EXIT.USAGE, stdout: "", stderr: `fleet-dispatch: ${why}\n` };
  }
  const logLines: string[] = [];
  const choice = await resolveDispatch({ request, pool }, { ...deps, log: (line) => logLines.push(line) });
  const stderr = logLines.map((line) => `${line}\n`).join("");
  if (choice.refusal !== null || !choice.chosen.length) {
    const why = choice.refusal ?? choice.notes.join(" ");
    return { code: EXIT.REFUSED, stdout: "", stderr: `${stderr}fleet-dispatch: REFUSING: ${why}\n` };
  }
  const { chosen, short, notes } = choice;
  return { code: EXIT.OK, stdout: `${JSON.stringify({ request, chosen, short, notes })}\n`, stderr };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await cli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
