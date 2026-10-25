import { resolveDispatch } from "../fleet-dispatch.ts";
import type { DispatchRequest } from "../fleet-dispatch.ts";
import { readControlPlaneFleet } from "../control-plane-fleet.ts";
import { wakeFailed, wakeFleet, wakeReportLine } from "../fleet-wake.ts";
import type { WakeTarget } from "../fleet-wake.ts";
import type { Box, BoxRequest } from "./types.ts";

export type Chosen = { boxes: Box[]; short: boolean; notes: string[] };
export type Choose = { chosen: Chosen } | { refusal: string };

/**
 * HOW THE SERVICE FINDS ITS BOXES. Two questions, both answered from the control plane's own inventory: which boxes does a request get right now
 * (`choose`), and where are these named boxes (`locate`, for a restart and for a named request).
 */
export interface BoxResolver {
  /** `claimed` are the boxes other jobs hold; a count or `ready` is chosen from the rest. */
  choose(request: BoxRequest, claimed: ReadonlySet<string>): Promise<Choose>;
  locate(names: string[]): Promise<{ found: Box[]; missing: string[] }>;
  /** Every box the inventory names, for a submit to check a named box against. */
  known(): Promise<string[]>;
}

type Inventory = () => { name: string; url: string; mac?: string }[];

const targetOf = (box: { name: string; url: string; mac?: string }): WakeTarget =>
  ({ name: box.name, host: new URL(box.url).hostname, mac: box.mac ?? null });

/** The real resolver: the inventory is read over the control plane's route, boxes are chosen least-loaded by `resolveDispatch` and woken. */
export function inventoryResolver({ inventory = readInventory, log = () => {} }: { inventory?: Inventory; log?: (line: string) => void } = {}): BoxResolver {
  return {
    async known() { return inventory().map((box) => box.name); },

    async locate(names) {
      const all = inventory();
      const found = names.flatMap((name) => { const box = all.find((b) => b.name === name); return box ? [{ name, url: box.url }] : []; });
      return { found, missing: names.filter((name) => !found.some((box) => box.name === name)) };
    },

    async choose(request, claimed) {
      const all = inventory().filter((box) => !claimed.has(box.name));
      if (request.kind === "named") return chooseNamed(request.names, all, log);
      const asked: DispatchRequest = request.kind === "ready" ? "ready" : request.count;
      if (!all.length) return { refusal: "every box in the inventory is held by another job" };
      const choice = await resolveDispatch({ request: asked, pool: all.map(targetOf) }, { log });
      if (choice.refusal !== null) return { refusal: choice.refusal };
      if (!choice.chosen.length) return { refusal: choice.notes.join(" ") || "no box is ready" };
      return { chosen: {
        boxes: choice.chosen.map((name) => ({ name, url: all.find((box) => box.name === name)!.url })),
        short: choice.short, notes: choice.notes } };
    },
  };
}

async function chooseNamed(names: string[], all: { name: string; url: string; mac?: string }[], log: (line: string) => void): Promise<Choose> {
  const boxes = names.map((name) => all.find((box) => box.name === name));
  const missing = names.filter((_, i) => !boxes[i]);
  if (missing.length) return { refusal: `not in the inventory, or held by another job: ${missing.join(", ")}` };
  const woken = await wakeFleet(boxes.map((box) => targetOf(box!)), { log });
  const down = woken.filter(wakeFailed);
  if (down.length) return { refusal: `did not come up when woken: ${down.map((r) => wakeReportLine(r)).join("; ")}` };
  return { chosen: { boxes: boxes.map((box) => ({ name: box!.name, url: box!.url })), short: false, notes: [] } };
}

function readInventory() {
  const { workers, refusal } = readControlPlaneFleet();
  if (refusal !== null) throw new Error(refusal);
  return workers;
}
