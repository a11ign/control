/**
 * THE REMOTE HALF OF THE `fleet` COMMAND (A11-243, ADR `A11-243-adr-0001`).
 *
 *     node --import <tsx> src/fleet-jobs/remote.ts submit|recapture|status|cancel|list|tar ...
 *
 * `cli.ts` reaches the control plane over its SSH and runs this from the service's OWN checkout, so the store is only ever read by code of the
 * same version as the service that writes it. Everything it answers is one JSON object (or list) on stdout; a refusal is a sentence on stderr and
 * one of the exit codes below. `tar` alone streams bytes: the job's `results/`, for `fleet job fetch`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readControlPlaneFleet } from "../control-plane-fleet.ts";
import { storeDirFromEnv } from "./paths.ts";
import { LeaseLedger } from "../fleet-leases/ledger.ts";
import { ledgerDirFromEnv, ledgerPathIn } from "../fleet-leases/paths.ts";
import { availability, inOrder } from "../fleet-leases/grant.ts";
import { bodyRefusal, casesRefusal } from "./cases.ts";
import { passesRefusal } from "./plan.ts";
import { LABEL_WORDS, validLabel } from "./label.ts";
import { estimateFor, queueViewOf } from "./queue-view.ts";
import { JOB_ID, JobStore, newJobId } from "./store.ts";
import { HEARTBEAT_STALE_MS, viewJob } from "./view.ts";
import type { JobView, ServiceBeat } from "./view.ts";
import { CASE_STORE_VERSION, STORE_VERSION, isTerminal } from "./types.ts";
import type { BoxRequest, CaseSpec, Freeze, GroupSpec, JobRequest, JobState, JobStateFile } from "./types.ts";

/** The remote half's exit codes. `cli.ts` maps them; 1 is left to Node's own "could not run". */
export const REMOTE_EXIT = { OK: 0, REFUSED: 2, UNKNOWN_JOB: 4, SERVICE_DOWN: 5, ALREADY_ENDED: 6 } as const;

export type RemoteResult = { code: number; stdout: string; stderr: string };
export type RemoteDeps = {
  store: JobStore;
  now?: () => number;
  /** The names the inventory declares, to check a named box against. */
  known?: () => string[];
  stdin?: () => string;
  /** The lease ledger, for a queued job's place and `lease list`. Without one, a queued job shows no place. */
  ledger?: LeaseLedger;
};

/** What `submit` reads on stdin, from the CLI. */
export type SubmitPayload = {
  label: string; pages: string[]; boxes: BoxRequest; passes: number; body: Record<string, unknown>; freeze: Freeze | null; submittedBy: string;
  /** A job of cases has these and no pages, one pass and an empty body. */
  cases?: CaseSpec[]; groups?: Record<string, GroupSpec>;
};

/** What `recapture` reads on stdin, from the CLI. */
export type RecapturePayload = { source: string; cases: string[]; label: string; submittedBy: string };

const labelRefusal = (label: unknown): string | null => validLabel(label) ? null : `--label is required, as the ticket key: ${LABEL_WORDS}`;
const BOX_NAME = /^[\w.-]+$/;
const MAX_PASSES = 10;

const ok = (value: unknown): RemoteResult => ({ code: REMOTE_EXIT.OK, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
const refuse = (why: string, code: number = REMOTE_EXIT.REFUSED): RemoteResult => ({ code, stdout: "", stderr: `${why}\n` });

export function readBeat(store: JobStore): ServiceBeat | null {
  try { return JSON.parse(readFileSync(store.servicePath(), "utf8")) as ServiceBeat; } catch { return null; }
}

/** A job is only accepted when something is running it: the heartbeat is fresh. A job that nothing runs would sit `queued` for ever. */
export function serviceRefusal(store: JobStore, now: number): string | null {
  const beat = readBeat(store);
  if (!beat) return "the fleet job service is not running (no heartbeat): nothing would run this job, so it was not accepted";
  const age = now - Date.parse(beat.heartbeatAt);
  return age < HEARTBEAT_STALE_MS ? null : `the fleet job service is not running (last heartbeat ${Math.round(age / 1000)}s ago): nothing would run this job, so it was not accepted`;
}

/** The first thing wrong with the boxes a submit asked for, and with how many passes they can carry. */
function boxesRefusal(p: SubmitPayload, known: (() => string[]) | null): string | null {
  const { boxes } = p;
  if (boxes.kind === "count" && !(Number.isInteger(boxes.count) && boxes.count >= 1)) return "--boxes is a whole number of boxes (at least 1), `ready`, or a list of box names";
  if (boxes.kind === "named") {
    const bad = boxes.names.find((name) => !BOX_NAME.test(name));
    if (bad !== undefined || !boxes.names.length) return `--boxes names a box that is not a worker name: ${JSON.stringify(bad ?? "")}`;
    if (new Set(boxes.names).size !== boxes.names.length) return "--boxes names a box twice";
    let declared: string[] = [];
    try { declared = known ? known() : boxes.names; } catch (error) { return `the inventory could not be read to check the box names: ${(error as Error).message}`; }
    const unknown = boxes.names.filter((name) => !declared.includes(name));
    if (unknown.length) return `not boxes in the inventory: ${unknown.join(", ")}`;
  }
  if (boxes.kind === "ready") return null;
  return passesRefusal(boxes.kind === "named" ? boxes.names.length : boxes.count, p.passes);
}

/** The first thing wrong with a freeze reference, or null: it must name a commit and a time, and the time must not be ahead of now. */
function freezeRefusal(freeze: Freeze | null, now: number): string | null {
  if (!freeze) return null;
  const named = Date.parse(freeze.namedAt);
  if (typeof freeze.commit !== "string" || Number.isNaN(named)) return "the freeze reference has no commit and namedAt";
  return named > now ? `the freeze reference is named in the future (${freeze.namedAt}): a freeze names what was fixed BEFORE the captures` : null;
}

/** A job of cases takes its URLs and bodies from the cases, so a page list, passes or a job body beside them are refused. */
function caseJobRefusal(p: SubmitPayload, known: (() => string[]) | null): string | null {
  if (p.pages?.length || p.passes !== 1 || Object.keys(p.body ?? {}).length) return "a job of cases takes its bodies from the cases: it has no pages, passes or job body";
  return casesRefusal(p.cases, p.groups) ?? boxesRefusal(p, known);
}

/** The first thing wrong with a submit, in words, or null. */
export function submitRefusal(p: SubmitPayload, { now, known }: { now: number; known: (() => string[]) | null }): string | null {
  const label = labelRefusal(p.label);
  if (label) return label;
  if (p.cases !== undefined) return caseJobRefusal(p, known) ?? freezeRefusal(p.freeze, now);
  if (!Array.isArray(p.pages) || !p.pages.length) return "no pages were given";
  if (!Number.isInteger(p.passes) || p.passes < 1 || p.passes > MAX_PASSES) return `--passes is a whole number from 1 to ${MAX_PASSES}`;
  return boxesRefusal(p, known) ?? bodyRefusal(p.body) ?? freezeRefusal(p.freeze, now);
}

function submit(deps: Required<Pick<RemoteDeps, "store" | "now">> & RemoteDeps): RemoteResult {
  let payload: SubmitPayload;
  try { payload = JSON.parse(deps.stdin?.() ?? "") as SubmitPayload; } catch (cause) { return refuse(`submit reads a JSON request on stdin: ${(cause as Error).message}`); }
  const now = deps.now();
  const why = submitRefusal(payload, { now, known: deps.known ?? null });
  if (why) return refuse(why);
  const down = serviceRefusal(deps.store, now);
  if (down) return refuse(down, REMOTE_EXIT.SERVICE_DOWN);
  const request: JobRequest = {
    version: payload.cases ? CASE_STORE_VERSION : STORE_VERSION, id: newJobId(new Date(now)), ...payload, ...(payload.cases ? { groups: payload.groups ?? {} } : {}),
    submittedAt: new Date(now).toISOString() };
  deps.store.writeRequest(request);
  return ok({ id: request.id });
}

/** Each named case as the re-capture runs it: the same URL and body, one attempt on, in its group, with the group pinned to the box it was captured on. */
function pinnedCases(source: JobRequest, captured: JobStateFile, ids: string[]): { cases: CaseSpec[]; groups: Record<string, GroupSpec> } | string {
  const cases: CaseSpec[] = [];
  const groups: Record<string, GroupSpec> = {};
  for (const id of ids) {
    const was = source.cases!.find((c) => c.id === id)!;
    const group = was.group ?? id;
    const box = captured.captures.find((c) => c.case === id)?.box;
    if (!box) return `case ${id} of ${source.id} was never placed on a box`;
    groups[group] = { box };
    cases.push({ id, url: was.url, body: was.body, group, attempt: (was.attempt ?? 1) + 1 });
  }
  return { cases, groups };
}

/** The first group whose pinned box the inventory no longer has, in words, or null. */
function goneBoxRefusal(groups: Record<string, GroupSpec>, known: (() => string[]) | null): string | null {
  let declared: string[] | null;
  try { declared = known ? known() : null; } catch (error) { return `the inventory could not be read to check the boxes: ${(error as Error).message}`; }
  const gone = declared && Object.entries(groups).find(([, spec]) => !declared.includes(spec.box!));
  return gone ? `group ${gone[0]} was captured on ${gone[1].box}, which is not in the inventory now: submit the whole group as a new job` : null;
}

/**
 * The job a re-capture asks for: the named cases of a `done` case job, each pinned to the box its group was captured on, as a new job that names its
 * source. The first thing wrong with it is returned as words.
 */
export function recaptureRequest(p: RecapturePayload, { store, now, known, view }: { store: JobStore; now: number; known: (() => string[]) | null; view: JobView }): JobRequest | string {
  const label = labelRefusal(p.label);
  if (label) return label;
  if (view.state !== "done") return `job ${p.source} is ${view.state}: only a job that is done can be re-captured`;
  const source = store.readRequest(p.source);
  const state = store.readState(p.source);
  if (!source?.ok || !state?.ok) return `job ${p.source} cannot be read to re-capture it`;
  if (!source.value.cases) return `job ${p.source} is a job of pages: only a job of cases can be re-captured`;
  const ids = [...new Set(p.cases)];
  if (!ids.length) return "no cases were named: give --cases <id,id,...>";
  const unknown = ids.filter((id) => !source.value.cases!.some((c) => c.id === id));
  if (unknown.length) return `job ${p.source} has no case ${unknown.join(", ")}`;
  const pinned = pinnedCases(source.value, state.value, ids);
  if (typeof pinned === "string") return pinned;
  const gone = goneBoxRefusal(pinned.groups, known);
  if (gone) return gone;
  const names = [...new Set(Object.values(pinned.groups).map((spec) => spec.box!))];
  return {
    version: CASE_STORE_VERSION, id: newJobId(new Date(now)), label: p.label, pages: [], boxes: { kind: "named", names }, passes: 1, body: {},
    freeze: source.value.freeze, submittedBy: p.submittedBy, submittedAt: new Date(now).toISOString(), ...pinned, recaptureOf: p.source,
  };
}

/** The inventory's box names for an estimate to choose a count from; empty when the inventory could not be read, and the estimate then says so. */
function fleetOf(deps: Pick<RemoteDeps, "known">): string[] {
  try { return deps.known?.() ?? []; } catch { return []; }
}

function viewOf(deps: Pick<RemoteDeps, "store" | "ledger" | "known">, id: string, now: number): JobView | RemoteResult {
  const { store } = deps;
  if (!JOB_ID.test(id)) return refuse(`${JSON.stringify(id)} is not a job ID (fj-<time>-<hex>)`, REMOTE_EXIT.UNKNOWN_JOB);
  const request = store.readRequest(id);
  const state = store.readState(id);
  if (!request && !state) return refuse(`no job ${id}`, REMOTE_EXIT.UNKNOWN_JOB);
  const placeholder: JobRequest = {
    version: STORE_VERSION, id, label: "(unreadable)", pages: [], boxes: { kind: "ready" }, passes: 0, body: {}, freeze: null, submittedBy: "",
    submittedAt: new Date(Date.UTC(+id.slice(3, 7), +id.slice(7, 9) - 1, +id.slice(9, 11), +id.slice(12, 14), +id.slice(14, 16), +id.slice(16, 18))).toISOString(),
  };
  const queue = deps.ledger && request?.ok && !state ? queueViewOf({ ledger: deps.ledger, store, now, fleet: fleetOf(deps) }, id) : null;
  return viewJob({
    request: request?.ok ? request.value : placeholder,
    state: state?.ok ? state.value : null,
    cancelled: store.isCancelled(id),
    beat: readBeat(store), now, storeDir: store.dir, queue,
  });
}

const isResult = (value: JobView | RemoteResult): value is RemoteResult => "code" in value;

function recapture(deps: Required<Pick<RemoteDeps, "store" | "now">> & RemoteDeps): RemoteResult {
  let payload: RecapturePayload;
  try { payload = JSON.parse(deps.stdin?.() ?? "") as RecapturePayload; } catch (cause) { return refuse(`recapture reads a JSON request on stdin: ${(cause as Error).message}`); }
  const now = deps.now();
  const view = viewOf({ store: deps.store }, payload.source, now);
  if (isResult(view)) return view;
  const request = recaptureRequest(payload, { store: deps.store, now, known: deps.known ?? null, view });
  if (typeof request === "string") return refuse(request);
  const down = serviceRefusal(deps.store, now);
  if (down) return refuse(down, REMOTE_EXIT.SERVICE_DOWN);
  deps.store.writeRequest(request);
  return ok({ id: request.id, recaptureOf: request.recaptureOf, boxes: request.boxes });
}

function cancel(deps: RemoteDeps, id: string, now: number): RemoteResult {
  const { store } = deps;
  const view = viewOf({ store }, id, now);
  if (isResult(view)) return view;
  if (isTerminal(view.state)) return refuse(`job ${id} has already ended (${view.state}), so it cannot be cancelled`, REMOTE_EXIT.ALREADY_ENDED);
  store.markCancelled(id, new Date(now).toISOString());
  return ok({ id, cancelRequested: true, state: view.state });
}

function list(store: JobStore, { label, state, limit }: { label?: string; state?: string; limit: number }, now: number): RemoteResult {
  const views = store.list().reverse().flatMap((id) => { const v = viewOf({ store }, id, now); return isResult(v) ? [] : [v]; });
  const chosen = views.filter((v) => (!label || v.label === label) && (!state || v.state === state)).slice(0, limit);
  return ok(chosen.map(({ id, label: l, state: s, submittedAt, startedAt, finishedAt, total, done, failed }) => ({ id, label: l, state: s, submittedAt, startedAt, finishedAt, total, done, failed })));
}

/** `fleet lease list`: the live leases and the queue in the order it is served, each waiter with its place and estimated start. Read-only. */
function leaseList(deps: RemoteDeps, now: number): RemoteResult {
  if (!deps.ledger) return refuse("no lease ledger is configured");
  const read = deps.ledger.live();
  if (!read.ok) return refuse(read.reason);
  const at = { ledger: deps.ledger, store: deps.store, now, fleet: fleetOf(deps) };
  const queue = inOrder(read.ledger.queue).map((w, i) => {
    const estimate = estimateFor(at, w.id);
    return { ...w, place: i + 1, of: read.ledger.queue.length, estimatedStart: estimate.estimatedStart === null ? null : new Date(estimate.estimatedStart).toISOString(),
      estimateReason: estimate.reason, waitingOn: availability(read.ledger, w.id).waitingOn };
  });
  return ok({ at: new Date(now).toISOString(), leases: read.ledger.leases, queue });
}

const STATES: JobState[] = ["queued", "running", "done", "failed", "cancelled"];

type Handler = (rest: string[], deps: RemoteDeps, now: number) => RemoteResult;

const idCommand = (name: string, run: (deps: RemoteDeps, id: string, now: number) => RemoteResult): Handler => (rest, deps, now) =>
  rest.length === 1 ? run(deps, rest[0]!, now) : refuse(`${name} takes one job ID`);

function listCommand(rest: string[], deps: RemoteDeps, now: number): RemoteResult {
  const { values } = parseArgs({ args: rest, options: { label: { type: "string" }, state: { type: "string" }, limit: { type: "string" } }, strict: true });
  if (values.state && !STATES.includes(values.state as JobState)) return refuse(`--state is one of ${STATES.join(", ")}`);
  const limit = values.limit === undefined ? 50 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) return refuse("--limit is a whole number, at least 1");
  return list(deps.store, { label: values.label, state: values.state, limit }, now);
}

const COMMANDS: Record<string, Handler> = {
  submit: (_rest, deps) => submit({ ...deps, now: deps.now ?? Date.now }),
  status: idCommand("status", (deps, id, now) => { const view = viewOf(deps, id, now); return isResult(view) ? view : ok(view); }),
  cancel: idCommand("cancel", cancel),
  recapture: (_rest, deps) => recapture({ ...deps, now: deps.now ?? Date.now }),
  list: listCommand,
  "lease-list": (_rest, deps, now) => leaseList(deps, now),
};

/** One remote command. PURE of process state: the store, the clock and stdin are handed in. */
export function remote(argv: string[], deps: RemoteDeps): RemoteResult {
  const [command, ...rest] = argv;
  const handler = Object.hasOwn(COMMANDS, command ?? "") ? COMMANDS[command!]! : null;
  if (!handler) return refuse("usage: remote.ts submit|recapture|status <id>|cancel <id>|list [--label k] [--state s] [--limit n]|lease-list|tar <id>");
  try {
    return handler(rest, deps, (deps.now ?? Date.now)());
  } catch (error) {
    return refuse(`${command}: ${(error as Error).message}`);
  }
}

/** `tar <id>`: the job's `results/` as a tar stream on stdout. */
function tarResults(store: JobStore, id: string): number {
  if (!JOB_ID.test(id) || !store.has(id)) { process.stderr.write(`no job ${JSON.stringify(id)}\n`); return REMOTE_EXIT.UNKNOWN_JOB; }
  const run = spawnSync("tar", ["-C", store.resultsDir(id), "-cf", "-", "."], { stdio: ["ignore", "inherit", "inherit"] });
  return run.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const store = new JobStore(storeDirFromEnv());
  const argv = process.argv.slice(2);
  if (argv[0] === "tar") process.exit(tarResults(store, argv[1] ?? ""));
  const known = (): string[] => {
    const { workers, refusal } = readControlPlaneFleet();
    if (refusal !== null) throw new Error(refusal);
    return workers.map((w) => w.name);
  };
  const ledger = new LeaseLedger(ledgerPathIn(ledgerDirFromEnv()));
  const result = remote(argv, { store, known, ledger, stdin: () => readFileSync(0, "utf8") });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
