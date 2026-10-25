/**
 * THE `fleet` COMMAND: submit fleet work, and follow it by job ID (A11-243, ADR `A11-243-adr-0001`).
 *
 *     fleet capture submit --pages <file>|<url>... --boxes <N>|ready|<name,name> --label <ticket key> [--passes N] [--steps N]
 *                          [--probe tables,typing,dialog] [--body-json <file>] [--freeze <freeze.json>]
 *     fleet capture submit --cases <file> --boxes <N>|ready|<name,name> --label <ticket key> [--freeze <freeze.json>]
 *     fleet job recapture <id> --cases <case id,case id> --label <ticket key>
 *     fleet job status <id> [--json]
 *     fleet job wait <id> --timeout <90s|30m|2h>
 *     fleet job cancel <id>
 *     fleet job list [--label <key>] [--state <s>] [--json]
 *     fleet job fetch <id> --to <dir>
 *     fleet lease list [--json]
 *
 * This is the thin local side. Every call runs `remote.ts` on the control plane, from the service's own checkout, over the SSH route every control
 * command already uses. What stays here is argument parsing, the wait loop and `fetch`.
 *
 * EXIT CODES of `wait`, and no wait is without an end: 0 the job is done (failed captures are records and are counted), 1 the job FAILED (the reason
 * is printed), 3 it was cancelled, 124 the timeout ran out (progress and what is left are printed; 124 is `timeout(1)`'s own), 2 usage, an unknown
 * job, or a service that could not be reached at the start.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { controlPlaneInvocation } from "../control-plane-fleet.ts";
import type { Invocation } from "../control-plane-fleet.ts";
import { MAX_WAIT_MS, formatDuration, parseDuration } from "./duration.ts";
import { parseCasesFile } from "./cases.ts";
import { parsePages } from "./pages.ts";
import { CONTROL_TSX_LOADER, SERVICE_CHECKOUT } from "./paths.ts";
import { REMOTE_EXIT } from "./remote.ts";
import type { RecapturePayload, SubmitPayload } from "./remote.ts";
import { JOB_ID } from "./store.ts";
import { leftLines, renderView } from "./view.ts";
import type { JobView } from "./view.ts";
import type { BoxRequest, Freeze } from "./types.ts";

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, CANCELLED: 3, TIMEOUT: 124 } as const;

/** How the remote half is started. The default is the control plane's own route; a test hands over a local process. */
export type Transport = (remoteArgs: string[]) => Invocation;

const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

export const controlPlaneTransport: Transport = (args) => controlPlaneInvocation(
  `cd ${SERVICE_CHECKOUT} && /usr/bin/node --import ${CONTROL_TSX_LOADER} src/fleet-jobs/remote.ts ${args.map(shellQuote).join(" ")}`);

/** Each ssh round trip has its own limit; a call that exceeds it is a failed poll, not a hung command. */
const CALL_TIMEOUT_MS = 60_000;
/** `wait` polls this often: one SSH round trip each, no stream held open. */
export const POLL_MS = 15_000;

type Call = { reached: boolean; code: number | null; stdout: string; stderr: string };

export function call(transport: Transport, args: string[], { input, timeoutMs = CALL_TIMEOUT_MS }: { input?: string; timeoutMs?: number } = {}): Call {
  const { file, args: argv } = transport(args);
  const run = spawnSync(file, argv, { input, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  // ssh itself ends 255 when it could not connect; a timeout or a missing program has `error` set.
  const reached = run.error === undefined && run.status !== 255 && run.status !== null;
  return { reached, code: run.status, stdout: run.stdout ?? "", stderr: run.error ? `${run.error.message}\n` : run.stderr ?? "" };
}

export type Io = { out: (text: string) => void; err: (text: string) => void };
export type Deps = Io & {
  transport: Transport;
  /** How often `wait` asks the service: one ssh round trip each. */
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readFile: (path: string) => string;
  submitter: () => string;
  /** `fetch` streams a tar from the control plane into `dest`. */
  untar: (source: Invocation, dest: string) => Promise<number>;
};

type Status = { view: JobView } | { unknown: string } | { unreached: string };

function statusOf(deps: Deps, id: string, timeoutMs: number = CALL_TIMEOUT_MS): Status {
  const reply = call(deps.transport, ["status", id], { timeoutMs });
  if (reply.reached && reply.code === REMOTE_EXIT.OK) {
    try { return { view: JSON.parse(reply.stdout) as JobView }; } catch { return { unreached: `the service's answer was not JSON: ${reply.stdout.slice(0, 200)}` }; }
  }
  if (reply.reached && reply.code === REMOTE_EXIT.UNKNOWN_JOB) return { unknown: reply.stderr.trim() || `no job ${id}` };
  return { unreached: reply.stderr.trim() || `the control plane answered ${reply.code}` };
}

/**
 * `fleet job wait`: poll the job until it ends, or until `timeoutMs` has passed. A failed poll is tried again until the deadline; each call is
 * given no more time than the deadline leaves, so the command ends within a second of it. The first poll must reach the service, since a wait
 * on a service that is not there should say so at once and not after the whole timeout.
 */
export async function waitForJob(deps: Deps, id: string, timeoutMs: number): Promise<number> {
  const deadline = deps.now() + timeoutMs;
  let last: JobView | null = null;
  let lastReached: number | null = null;
  let lastError = "";
  for (let first = true; ; first = false) {
    const status = statusOf(deps, id, Math.min(CALL_TIMEOUT_MS, Math.max(1000, deadline - deps.now())));
    if ("unknown" in status) { deps.err(`${status.unknown}\n`); return EXIT.USAGE; }
    if ("unreached" in status) {
      lastError = status.unreached;
      if (first) { deps.err(`could not reach the fleet job service: ${lastError}\n`); return EXIT.USAGE; }
    } else {
      last = status.view;
      lastReached = deps.now();
      const ended = endOf(deps, last);
      if (ended !== null) return ended;
    }
    const left = deadline - deps.now();
    if (left <= 0) break;
    await deps.sleep(Math.min(deps.pollMs, left));
  }
  deps.err(`TIMED OUT after ${formatDuration(timeoutMs)} waiting for ${id}; the job goes on in the service\n`);
  if (last) {
    for (const line of renderView(last)) deps.err(`${line}\n`);
    for (const line of leftLines(last, deps.now())) deps.err(`${line}\n`);
  }
  deps.err(lastReached === null ? `the service was never reached (${lastError})\n`
    : `the service was last reached at ${new Date(lastReached).toISOString()}${lastError ? `; the polls since failed: ${lastError}` : ""}\n`);
  return EXIT.TIMEOUT;
}

/** The exit code of a job that has ended, with what it says; null while it has not. */
function endOf(deps: Deps, view: JobView): number | null {
  if (view.state === "done") {
    deps.out(`${view.id} done: ${view.done - view.failed - view.skipped} captures, ${view.failed} failed${view.skipped ? `, ${view.skipped} skipped` : ""}\nresults: ${view.results.location}  (${view.results.fetch})\n`);
    return EXIT.OK;
  }
  if (view.state === "failed") {
    deps.err(`${view.id} FAILED: ${view.reason ?? "no reason was recorded"}\n`);
    for (const line of renderView(view)) deps.err(`${line}\n`);
    return EXIT.FAILED;
  }
  if (view.state === "cancelled") {
    deps.err(`${view.id} was cancelled${view.reason ? `: ${view.reason}` : ""}; ${view.done} of ${view.total} captures had ended\n`);
    return EXIT.CANCELLED;
  }
  return null;
}

const DEFAULT_BODY = { probeForms: false, probeFocus: true, probeNavigation: true, probeFocusContext: true, probeFocusReveal: true, steps: 600 };
const PROBES: Record<string, string> = { tables: "probeTables", typing: "probeTyping", dialog: "probeDialog" };

export function parseBoxes(text: string): BoxRequest | { refusal: string } {
  if (text === "ready") return { kind: "ready" };
  if (/^[0-9]+$/.test(text)) return Number(text) >= 1 ? { kind: "count", count: Number(text) } : { refusal: "--boxes 0 asks for no box" };
  const names = text.split(",").map((n) => n.trim()).filter(Boolean);
  return names.length ? { kind: "named", names } : { refusal: "--boxes is a number of boxes, `ready`, or box names separated by commas" };
}

function pagesOf(inputs: string[], readFile: (path: string) => string): { pages: string[] } | { refusal: string } {
  const pages = new Set<string>();
  for (const input of inputs) {
    const text = /^https?:\/\//.test(input) ? input : (() => { try { return readFile(input); } catch (cause) { return { error: (cause as Error).message }; } })();
    if (typeof text !== "string") return { refusal: `--pages ${input}: ${text.error}` };
    const parsed = parsePages(text);
    if ("refusal" in parsed) return { refusal: `--pages ${input}: ${parsed.refusal}` };
    for (const page of parsed.pages) pages.add(page);
  }
  return pages.size ? { pages: [...pages] } : { refusal: "no pages were named: give --pages <file> or URLs" };
}

/** The numbers a submit takes: `--passes` (default 1) and `--steps`, each a whole number. */
function numbersOf(values: { passes?: string; steps?: string }): { passes: number; steps: number } | { refusal: string } {
  const passes = values.passes === undefined ? 1 : Number(values.passes);
  const steps = values.steps === undefined ? DEFAULT_BODY.steps : Number(values.steps);
  if (!Number.isInteger(passes)) return { refusal: "--passes is a whole number" };
  if (!Number.isInteger(steps) || steps < 1) return { refusal: "--steps is a whole number, at least 1" };
  return { passes, steps };
}

/** `--probe tables,typing` as the worker's own flags, or the refusal naming the probe that is not one. */
function probeFlags(probe: string | undefined): Record<string, true> | { refusal: string } {
  const probes = (probe ?? "").split(",").filter(Boolean);
  const unknown = probes.find((name) => !(name in PROBES));
  if (unknown) return { refusal: `--probe is any of ${Object.keys(PROBES).join(", ")}: ${unknown} is not one` };
  return Object.fromEntries(probes.map((name) => [PROBES[name]!, true as const]));
}

/** The two JSON files a submit may name: more of the worker's body, and a freeze reference. */
function jsonFiles(values: { "body-json"?: string; freeze?: string }, readFile: (path: string) => string): { extra: Record<string, unknown>; freeze: Freeze | null } | { refusal: string } {
  try {
    return {
      extra: values["body-json"] ? JSON.parse(readFile(values["body-json"])) as Record<string, unknown> : {},
      freeze: values.freeze ? JSON.parse(readFile(values.freeze)) as Freeze : null,
    };
  } catch (cause) { return { refusal: `a file could not be read as JSON: ${(cause as Error).message}` }; }
}

const refused = <T extends object>(value: T | { refusal: string }): value is { refusal: string } => "refusal" in value;

/** What a job of cases takes from its cases file, so each of these beside `--cases` would be a second place for a body to come from. */
const CASE_CONFLICTS = ["pages", "passes", "steps", "probe", "body-json"] as const;

function casesPayload(values: Record<string, string | string[] | undefined>, positionals: string[], deps: Deps): SubmitPayload | { refusal: string } {
  const conflict = CASE_CONFLICTS.find((flag) => values[flag] !== undefined) ?? (positionals.length ? "a page URL" : undefined);
  if (conflict) return { refusal: `--cases cannot be used with ${conflict === "a page URL" ? conflict : `--${conflict}`}: a job's bodies come from one place, the cases file` };
  const boxes = parseBoxes(values.boxes as string);
  let text: string;
  try { text = deps.readFile(values.cases as string); } catch (cause) { return { refusal: `--cases ${values.cases}: ${(cause as Error).message}` }; }
  const parsed = parseCasesFile(text);
  const files = jsonFiles({ freeze: values.freeze as string | undefined }, deps.readFile);
  for (const step of [boxes, parsed, files]) if (refused(step)) return step;
  const { cases, groups } = parsed as Exclude<typeof parsed, { refusal: string }>;
  return { label: values.label as string, pages: [], boxes: boxes as BoxRequest, passes: 1, body: {}, freeze: (files as { freeze: Freeze | null }).freeze, submittedBy: deps.submitter(), cases, groups };
}

function submitPayload(args: string[], deps: Deps): SubmitPayload | { refusal: string } {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    pages: { type: "string", multiple: true }, boxes: { type: "string" }, passes: { type: "string" }, steps: { type: "string" }, probe: { type: "string" },
    "body-json": { type: "string" }, freeze: { type: "string" }, label: { type: "string" }, cases: { type: "string" } } });
  if (!values.label) return { refusal: "--label is required: the ticket key" };
  if (!values.boxes) return { refusal: "--boxes is required: a number of boxes, `ready`, or box names separated by commas" };
  if (values.cases !== undefined) return casesPayload(values, positionals, deps);
  const boxes = parseBoxes(values.boxes);
  const pages = pagesOf([...(values.pages ?? []), ...positionals], deps.readFile);
  const numbers = numbersOf(values);
  const probes = probeFlags(values.probe);
  const files = jsonFiles(values, deps.readFile);
  for (const step of [boxes, pages, numbers, probes, files]) if (refused(step)) return step;
  const { passes, steps } = numbers as { passes: number; steps: number };
  const { extra, freeze } = files as { extra: Record<string, unknown>; freeze: Freeze | null };
  const body = { ...DEFAULT_BODY, steps, ...probes as Record<string, true>, ...extra };
  return { label: values.label, pages: (pages as { pages: string[] }).pages, boxes: boxes as BoxRequest, passes, body, freeze, submittedBy: deps.submitter() };
}

function submitJob(args: string[], deps: Deps): number {
  let payload;
  try { payload = submitPayload(args, deps); } catch (cause) { deps.err(`${(cause as Error).message}\n`); return EXIT.USAGE; }
  if ("refusal" in payload) { deps.err(`${payload.refusal}\n`); return EXIT.USAGE; }
  const reply = call(deps.transport, ["submit"], { input: JSON.stringify(payload) });
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) {
    deps.err(`${failureOf(reply)}\n`);
    return EXIT.USAGE;
  }
  const { id } = JSON.parse(reply.stdout) as { id: string };
  deps.out(`${id}\n`);
  const what = payload.cases ? `${payload.cases.length} ${payload.cases.length === 1 ? "case" : "cases"}` : `${payload.pages.length} pages x ${payload.passes} ${payload.passes === 1 ? "pass" : "passes"}`;
  deps.err(`submitted ${what} as ${id}; follow it with: fleet job wait ${id} --timeout 30m\n`);
  return EXIT.OK;
}

/** `fleet job recapture <id> --cases a,b --label key`: a new job of those cases of a done job, each on the box its group was captured on. */
function recaptureJob(id: string, options: JobOptions, deps: Deps): number {
  if (!options.label) { deps.err("--label is required: the ticket key\n"); return EXIT.USAGE; }
  const cases = (options.cases ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (!cases.length) { deps.err("fleet job recapture needs --cases <case id,case id,...>\n"); return EXIT.USAGE; }
  const payload: RecapturePayload = { source: id, cases, label: options.label, submittedBy: deps.submitter() };
  const reply = call(deps.transport, ["recapture"], { input: JSON.stringify(payload) });
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) { deps.err(`${failureOf(reply)}\n`); return EXIT.USAGE; }
  const { id: newId } = JSON.parse(reply.stdout) as { id: string };
  deps.out(`${newId}\n`);
  deps.err(`re-capturing ${cases.length} ${cases.length === 1 ? "case" : "cases"} of ${id} as ${newId}; follow it with: fleet job wait ${newId} --timeout 30m\n`);
  return EXIT.OK;
}

const needId = (positionals: string[], deps: Deps, what: string): string | null => {
  const [id, ...extra] = positionals;
  if (!id || extra.length || !JOB_ID.test(id)) { deps.err(`${what} takes one job ID (fj-<time>-<hex>)\n`); return null; }
  return id;
};

type JobOptions = { json?: boolean; timeout?: string; label?: string; state?: string; limit?: string; to?: string; cases?: string };

/** A reply that did not come back whole: the words it carried, or what the control plane answered. */
const failureOf = (reply: Call): string => reply.stderr.trim() || `the control plane answered ${reply.code}`;

function listJobs(options: JobOptions, deps: Deps): number {
  const remoteArgs = ["list", ...(options.label ? ["--label", options.label] : []), ...(options.state ? ["--state", options.state] : []), ...(options.limit ? ["--limit", options.limit] : [])];
  const reply = call(deps.transport, remoteArgs);
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) { deps.err(`${failureOf(reply)}\n`); return EXIT.USAGE; }
  const rows = JSON.parse(reply.stdout) as Pick<JobView, "id" | "label" | "state" | "submittedAt" | "total" | "done" | "failed">[];
  if (options.json) deps.out(`${JSON.stringify(rows)}\n`);
  else if (!rows.length) deps.out("no jobs\n");
  else for (const r of rows) deps.out(`${r.id}  ${r.state.padEnd(9)} ${r.label.padEnd(12)} ${r.done}/${r.total}${r.failed ? ` (${r.failed} failed)` : ""}  ${r.submittedAt}\n`);
  return EXIT.OK;
}

function showStatus(id: string, options: JobOptions, deps: Deps): number {
  const status = statusOf(deps, id);
  if ("unknown" in status) { deps.err(`${status.unknown}\n`); return EXIT.USAGE; }
  if ("unreached" in status) { deps.err(`could not reach the fleet job service: ${status.unreached}\n`); return EXIT.USAGE; }
  deps.out(options.json ? `${JSON.stringify(status.view)}\n` : `${renderView(status.view).join("\n")}\n`);
  return EXIT.OK;
}

function waitFor(id: string, options: JobOptions, deps: Deps): Promise<number> | number {
  if (!options.timeout) { deps.err(`fleet job wait needs --timeout <duration> (90s, 30m, 2h, at most ${formatDuration(MAX_WAIT_MS)}): there is no wait without a limit\n`); return EXIT.USAGE; }
  const timeout = parseDuration(options.timeout);
  if ("refusal" in timeout) { deps.err(`${timeout.refusal}\n`); return EXIT.USAGE; }
  return waitForJob(deps, id, timeout.ms);
}

function cancelJob(id: string, deps: Deps): number {
  const reply = call(deps.transport, ["cancel", id]);
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) {
    deps.err(`${failureOf(reply)}\n`);
    return reply.code === REMOTE_EXIT.ALREADY_ENDED ? EXIT.FAILED : EXIT.USAGE;
  }
  deps.out(`cancel requested for ${id}: the service stops sending it pages; a capture already on a box ends and is kept\n`);
  return EXIT.OK;
}

async function fetchResults(id: string, options: JobOptions, deps: Deps): Promise<number> {
  if (!options.to) { deps.err("fleet job fetch needs --to <dir>\n"); return EXIT.USAGE; }
  const dest = join(resolve(options.to), id);
  mkdirSync(dest, { recursive: true });
  const code = await deps.untar(deps.transport(["tar", id]), dest);
  if (code !== 0) { deps.err(`fetch failed (${code}): no results were copied for ${id}\n`); return EXIT.USAGE; }
  deps.out(`${dest}  (${readdirSync(dest).length} files)\n`);
  return EXIT.OK;
}

type LeaseListing = {
  at: string;
  leases: { holder: string; kind: string; boxes: string[]; label: string; takenAt: number; expiresAt: number; expectedEnd: number | null }[];
  queue: { holder: string; kind: string; label: string; place: number; of: number; estimatedStart: string | null; estimateReason: string | null; waitingOn: string[] }[];
};

const clock = (ms: number | null): string => ms === null ? "unknown" : new Date(ms).toISOString();

/** `fleet lease list`: who holds which boxes, and who waits, in the order they are served. Read-only. */
function listLeases(args: string[], deps: Deps): number {
  const { values } = parseArgs({ args, strict: true, options: { json: { type: "boolean" } } });
  const reply = call(deps.transport, ["lease-list"]);
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) { deps.err(`${failureOf(reply)}\n`); return EXIT.USAGE; }
  if (values.json) { deps.out(reply.stdout); return EXIT.OK; }
  const listing = JSON.parse(reply.stdout) as LeaseListing;
  deps.out(`leases at ${listing.at}\n`);
  if (!listing.leases.length) deps.out("  none held\n");
  for (const l of listing.leases) deps.out(`  ${l.boxes.join(",")}  ${l.kind}  ${l.holder}  ${l.label}  expected end ${clock(l.expectedEnd)}  lapses ${clock(l.expiresAt)}\n`);
  deps.out("queue\n");
  if (!listing.queue.length) deps.out("  empty\n");
  for (const w of listing.queue) {
    deps.out(`  ${w.place} of ${w.of}  ${w.kind}  ${w.holder}  ${w.label}  estimated start ${w.estimatedStart ?? `unknown (${w.estimateReason})`}${w.waitingOn.length ? `  waiting on ${w.waitingOn.join(", ")}` : ""}\n`);
  }
  return EXIT.OK;
}

async function job(sub: string | undefined, args: string[], deps: Deps): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    json: { type: "boolean" }, timeout: { type: "string" }, label: { type: "string" }, state: { type: "string" }, limit: { type: "string" }, to: { type: "string" }, cases: { type: "string" } } });
  if (values.cases !== undefined && sub !== "recapture") { deps.err(`--cases is for fleet job recapture; fleet job ${sub} does not take it\n`); return EXIT.USAGE; }
  if (sub === "list") return listJobs(values, deps);
  const id = needId(positionals, deps, `fleet job ${sub}`);
  if (id === null) return EXIT.USAGE;
  if (sub === "status") return showStatus(id, values, deps);
  if (sub === "wait") return waitFor(id, values, deps);
  if (sub === "cancel") return cancelJob(id, deps);
  if (sub === "recapture") return recaptureJob(id, values, deps);
  if (sub === "fetch") return fetchResults(id, values, deps);
  deps.err("usage: fleet job status|wait|cancel|recapture|list|fetch ...\n");
  return EXIT.USAGE;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  try {
    // `pnpm run fleet -- job wait ...` hands the script its `--` as well; no command begins with one.
    const [group, sub, ...rest] = argv[0] === "--" ? argv.slice(1) : argv;
    if (group === "capture" && sub === "submit") return submitJob(rest, deps);
    if (group === "job") return await job(sub, rest, deps);
    if (group === "lease" && sub === "list") return listLeases(rest, deps);
  } catch (error) {
    deps.err(`${(error as Error).message}\n`);
    return EXIT.USAGE;
  }
  deps.err("usage: fleet capture submit ... | fleet job status|wait|cancel|recapture|list|fetch ... | fleet lease list  (see the header of src/fleet-jobs/cli.ts)\n");
  return EXIT.USAGE;
}

/** The real `fetch`: the remote `tar` stream into a local `tar -x`, never held whole in memory. */
export async function untarFrom(source: Invocation, dest: string): Promise<number> {
  const reader = spawn(source.file, source.args, { stdio: ["ignore", "pipe", "inherit"] });
  const writer = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "inherit", "inherit"] });
  reader.stdout.pipe(writer.stdin);
  const ended = (child: typeof reader | typeof writer) => new Promise<number>((resolveCode) => {
    child.on("error", () => resolveCode(1));
    child.on("close", (code) => resolveCode(code ?? 1));
  });
  const codes = await Promise.all([ended(reader), ended(writer)]);
  return codes.find((code) => code !== 0) ?? 0;
}

/** The names `loadFleetEnv` takes from `~/.config/a11ign/fleet.env`: how this host reaches the control plane, and nothing else. */
const FLEET_ENV_NAMES = ["A11Y_PVE_KEY", "A11Y_CONTROL_HOST", "A11Y_CONTROL_HOST_FILE"];

/** `NAME=value` lines (an `export ` before the name, and quotes around the value, are allowed) for the names above. The file is read, never run. */
export function parseFleetEnv(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*?)\s*$/.exec(line);
    if (match && FLEET_ENV_NAMES.includes(match[1]!)) found[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return found;
}

/** Fill in how to reach the control plane from `~/.config/a11ign/fleet.env` where the environment does not already say. */
export function loadFleetEnv(env: NodeJS.ProcessEnv = process.env, read: (path: string) => string = (path) => readFileSync(path, "utf8")): void {
  let text: string;
  try { text = read(join(env.HOME ?? "", ".config/a11ign/fleet.env")); } catch { return; }
  for (const [name, value] of Object.entries(parseFleetEnv(text))) env[name] ??= value;
}

export const realDeps = (): Deps => ({
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); },
  transport: controlPlaneTransport,
  pollMs: POLL_MS,
  now: Date.now,
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  readFile: (path) => readFileSync(path, "utf8"),
  submitter: () => `${userInfo().username}@${hostname()}`,
  untar: untarFrom,
});

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  loadFleetEnv();
  process.exit(await main(process.argv.slice(2), realDeps()));
}
