/**
 * `fleet facts submit|show`: the local half (A11-283). `cli.ts` hands in the one way it reaches the control plane (`call`, over `src/fleet-facts/remote.ts`),
 * so this file imports nothing from it.
 *
 *     fleet facts submit --boxes <N>|all|<name,name> --label <ticket key>
 *     fleet facts show [--json] [--boxes <name,name>]
 *
 * `submit` prints the job ID at once and the job is followed like any other (`fleet job status|wait|list|fetch <id>`). `show` prints the facts file as a table, or
 * as it is with `--json`; it exits 2 when no facts job has run, and 1 when the inventory could not be read: the table or the file is still printed, but a box the
 * facts file has never heard of is missing from it, and the reason is on stderr.
 */
import { parseArgs } from "node:util";
import { REMOTE_EXIT } from "../fleet-jobs/remote.ts";
import type { FactsFile } from "./types.ts";
import { factsRows, renderTable } from "./show.ts";
import type { FactsSubmitPayload } from "./remote.ts";

export type FactsReply = { reached: boolean; code: number | null; stdout: string; stderr: string };
export type FactsContext = {
  call: (args: string[], options?: { input?: string }) => FactsReply;
  out: (text: string) => void;
  err: (text: string) => void;
  submitter: () => string;
};

const OK = 0;
/** The answer was printed, but it is not the whole fleet. */
const INCOMPLETE = 1;
const USAGE = 2;

/** `--boxes` of a facts job: `all`, a number of boxes, or names. `ready` is a capture's and is refused by name. */
export function factsBoxes(text: string): FactsSubmitPayload["boxes"] | { refusal: string } {
  if (text === "ready") return { refusal: "--boxes ready is a capture's: a facts job wakes the boxes that are asleep, so give box names, a number of boxes, or `all`" };
  if (text === "all") return { kind: "all" };
  if (/^[0-9]+$/.test(text)) return Number(text) >= 1 ? { kind: "count", count: Number(text) } : { refusal: "--boxes 0 asks for no box" };
  const names = text.split(",").map((n) => n.trim()).filter(Boolean);
  return names.length ? { kind: "named", names } : { refusal: "--boxes is a number of boxes, `all`, or box names separated by commas" };
}

const failureOf = (reply: FactsReply): string => reply.stderr.trim() || `the control plane answered ${reply.code}`;

function submit(args: string[], context: FactsContext): number {
  const { values } = parseArgs({ args, strict: true, options: { boxes: { type: "string" }, label: { type: "string" } } });
  if (!values.label) { context.err("--label is required: the ticket key\n"); return USAGE; }
  if (!values.boxes) { context.err("--boxes is required: a number of boxes, `all`, or box names separated by commas\n"); return USAGE; }
  const boxes = factsBoxes(values.boxes);
  if ("refusal" in boxes) { context.err(`${boxes.refusal}\n`); return USAGE; }
  const payload: FactsSubmitPayload = { label: values.label, boxes, submittedBy: context.submitter() };
  const reply = context.call(["submit"], { input: JSON.stringify(payload) });
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) { context.err(`${failureOf(reply)}\n`); return USAGE; }
  const { id } = JSON.parse(reply.stdout) as { id: string };
  context.out(`${id}\n`);
  context.err(`submitted a facts read as ${id}; follow it with: fleet job wait ${id} --timeout 30m\n`);
  return OK;
}

function show(args: string[], context: FactsContext): number {
  const { values } = parseArgs({ args, strict: true, options: { json: { type: "boolean" }, boxes: { type: "string" } } });
  const only = values.boxes === undefined ? null : values.boxes.split(",").map((n) => n.trim()).filter(Boolean);
  const reply = context.call(["show"]);
  if (!reply.reached || reply.code !== REMOTE_EXIT.OK) { context.err(`${failureOf(reply)}\n`); return USAGE; }
  const { file, inventory, inventoryError } = JSON.parse(reply.stdout) as { file: FactsFile; inventory: string[]; inventoryError: string | null };
  if (values.json) {
    const kept = only === null ? file.boxes : Object.fromEntries(Object.entries(file.boxes).filter(([name]) => only.includes(name)));
    context.out(`${JSON.stringify({ ...file, boxes: kept }, null, 1)}\n`);
  } else for (const line of renderTable(factsRows(file, inventory, only))) context.out(`${line}\n`);
  if (inventoryError === null) return OK;
  context.err(`the inventory could not be read (${inventoryError}): only the boxes the facts file holds are shown, so a box that has never been read is missing\n`);
  return INCOMPLETE;
}

export function factsCommand(sub: string | undefined, args: string[], context: FactsContext): number {
  if (sub === "submit") return submit(args, context);
  if (sub === "show") return show(args, context);
  context.err("usage: fleet facts submit --boxes <N>|all|<name,name> --label <ticket key> | fleet facts show [--json] [--boxes <name,name>]\n");
  return USAGE;
}
