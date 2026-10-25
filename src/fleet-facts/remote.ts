/**
 * THE REMOTE HALF OF `fleet facts` (A11-283, ADR 0005).
 *
 *     node --import <tsx> src/fleet-facts/remote.ts submit|show ...
 *
 * `cli.ts` reaches the control plane over its SSH and runs this from the service's own checkout, as it does `src/fleet-jobs/remote.ts`, which this file leaves
 * alone and borrows from: the store, the heartbeat check and the exit codes. `submit` reads a JSON request on stdin and writes a `kind: "facts"` job at store
 * version 3; `show` reads the facts file beside the inventory. Everything answered is one JSON object on stdout; a refusal is a sentence on stderr and an exit code.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readControlPlaneFleet } from "../control-plane-fleet.ts";
import { REMOTE_EXIT, serviceRefusal } from "../fleet-jobs/remote.ts";
import type { RemoteResult } from "../fleet-jobs/remote.ts";
import { storeDirFromEnv } from "../fleet-jobs/paths.ts";
import { JobStore, newJobId } from "../fleet-jobs/store.ts";
import { FACTS_STORE_VERSION } from "../fleet-jobs/types.ts";
import type { BoxRequest, JobRequest } from "../fleet-jobs/types.ts";
import { factsFilePath, readFactsFile } from "./facts-file.ts";

/** What `submit` reads on stdin: a facts job names its boxes (`all` is every box in the inventory, named at submit) and has nothing else to say. */
export type FactsSubmitPayload = { label: string; boxes: BoxRequest | { kind: "all" }; submittedBy: string };

export type FactsRemoteDeps = {
  store: JobStore;
  now?: () => number;
  /** The names the inventory declares, in its order. */
  known?: () => string[];
  stdin?: () => string;
  factsFile?: string;
};

const LABEL = /^[A-Za-z0-9._-]{1,64}$/;
const BOX_NAME = /^[\w.-]+$/;
/** Everything a capture job carries and a facts job does not: each is refused by name, so a capture's request is never half-read as a facts job. */
const NOT_FACTS = ["pages", "cases", "groups", "passes", "body", "freeze"] as const;

const ok = (value: unknown): RemoteResult => ({ code: REMOTE_EXIT.OK, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
const refuse = (why: string, code: number = REMOTE_EXIT.REFUSED): RemoteResult => ({ code, stdout: "", stderr: `${why}\n` });

/** The boxes a submit asks for, as a request the service can place, or why not. `all` is expanded here to the inventory's names. */
export function boxesOf(boxes: FactsSubmitPayload["boxes"], known: (() => string[]) | null): BoxRequest | string {
  if (boxes.kind === "ready") return "--boxes ready is a capture's: a facts job wakes the boxes that are asleep, so it names boxes, a number of them, or `all`";
  if (boxes.kind === "count") return Number.isInteger(boxes.count) && boxes.count >= 1 ? boxes : "--boxes is a whole number of boxes (at least 1), `all`, or a list of box names";
  let declared: string[];
  try { declared = known ? known() : []; } catch (error) { return `the inventory could not be read to check the box names: ${(error as Error).message}`; }
  if (boxes.kind === "all") return declared.length ? { kind: "named", names: declared } : "--boxes all found no box: the inventory names none";
  const bad = boxes.names.find((name) => !BOX_NAME.test(name));
  if (bad !== undefined || !boxes.names.length) return `--boxes names a box that is not a worker name: ${JSON.stringify(bad ?? "")}`;
  if (new Set(boxes.names).size !== boxes.names.length) return "--boxes names a box twice";
  const unknown = known ? boxes.names.filter((name) => !declared.includes(name)) : [];
  return unknown.length ? `not boxes in the inventory: ${unknown.join(", ")}` : boxes;
}

/** The first thing wrong with a facts submit, in words, or the request it makes. */
export function factsRequest(payload: Record<string, unknown>, { now, known }: { now: number; known: (() => string[]) | null }): JobRequest | string {
  const extra = NOT_FACTS.find((key) => payload[key] !== undefined);
  if (extra) return `a facts job takes no ${extra}: it reads each box's hardware and captures nothing`;
  const { label, boxes, submittedBy } = payload as FactsSubmitPayload;
  if (!LABEL.test(String(label ?? ""))) return "--label is required, as the ticket key: letters, digits, '.', '_' and '-', at most 64";
  if (!boxes || typeof boxes !== "object") return "--boxes is required: a number of boxes, `all`, or box names separated by commas";
  const asked = boxesOf(boxes, known);
  if (typeof asked === "string") return asked;
  return { version: FACTS_STORE_VERSION, kind: "facts", id: newJobId(new Date(now)), label, pages: [], boxes: asked, passes: 1, body: {}, freeze: null,
    submittedBy: String(submittedBy ?? ""), submittedAt: new Date(now).toISOString() };
}

function submit(deps: FactsRemoteDeps, now: number): RemoteResult {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(deps.stdin?.() ?? "") as Record<string, unknown>; } catch (cause) { return refuse(`submit reads a JSON request on stdin: ${(cause as Error).message}`); }
  const request = factsRequest(payload, { now, known: deps.known ?? null });
  if (typeof request === "string") return refuse(request);
  const down = serviceRefusal(deps.store, now);
  if (down) return refuse(down, REMOTE_EXIT.SERVICE_DOWN);
  deps.store.writeRequest(request);
  return ok({ id: request.id, boxes: request.boxes });
}

/**
 * `show`: the facts file as it is, and the inventory's order for the table. A file that is missing means no facts job has run (a refusal, exit 2); one that
 * cannot be read is said. An inventory that cannot be read is said too, in `inventoryError`: without it the table cannot list a box the file has never heard of.
 */
function show(deps: FactsRemoteDeps, rest: string[]): RemoteResult {
  parseArgs({ args: rest, options: {}, strict: true });
  const path = deps.factsFile ?? factsFilePath();
  if (!existsSync(path)) return refuse(`no facts job has run: ${path} does not exist. Submit one with: fleet facts submit --boxes all --label <ticket key>`);
  const read = readFactsFile(path);
  if (!read.ok) return refuse(read.reason);
  let inventory: string[] = [];
  let inventoryError: string | null = null;
  try { inventory = deps.known?.() ?? []; } catch (error) { inventoryError = (error as Error).message; }
  return ok({ file: read.value, inventory, inventoryError });
}

/** One remote command. PURE of process state: the store, the clock, the inventory and stdin are handed in. */
export function remote(argv: string[], deps: FactsRemoteDeps): RemoteResult {
  const [command, ...rest] = argv;
  try {
    if (command === "submit") return submit(deps, (deps.now ?? Date.now)());
    if (command === "show") return show(deps, rest);
  } catch (error) {
    return refuse(`${command}: ${(error as Error).message}`);
  }
  return refuse("usage: remote.ts submit|show");
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const known = (): string[] => {
    const { workers, refusal } = readControlPlaneFleet();
    if (refusal !== null) throw new Error(refusal);
    return workers.map((w) => w.name);
  };
  const result = remote(process.argv.slice(2), { store: new JobStore(storeDirFromEnv()), known, stdin: () => readFileSync(0, "utf8") });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
