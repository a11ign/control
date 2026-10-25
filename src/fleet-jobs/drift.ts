import { readFileSync, statSync } from "node:fs";
import { CONTROL_PLANE_CHECKOUT_PATH } from "../control-plane-checkout.ts";

/**
 * WHICH BOXES THE HOURLY DRIFT CHECK SAYS ARE OFF THE MANIFEST (A11-205, A11-244). `runs/fleet-drift.json` on the control plane is the one reading:
 * `a11y-fleet-drift.service` writes it from `/root/control`, which follows `main`, while this service's checkout may be on an older ref. A box with a
 * current difference (not a `carried` one: that box did not answer and is unread, unless it was `skipped` under a lease) is out of capture, so a running job lets it go and a new job is not
 * given it. A difference can last for days, so waiting for it to clear would be for ever.
 */
export const FLEET_DRIFT_PATH = `${CONTROL_PLANE_CHECKOUT_PATH}/runs/fleet-drift.json`;

/**
 * Box -> what differs, in a sentence. A reading that cannot be made THROWS (`DriftUnreadable`): a record nobody can read is not proof that no box differs,
 * the rule the ledger and `fleet-lock.ts` hold to. The one exception is a record that does not exist, which is a control plane whose hourly check has
 * not run yet, and reads as "no difference known".
 */
export type DriftReader = () => Record<string, string>;

export class DriftUnreadable extends Error {}

type Entry = { box?: unknown; field?: unknown; has?: unknown; wants?: unknown; carried?: unknown };

export function driftFrom(text: string): Record<string, string> {
  let parsed: { differences?: unknown; skipped?: unknown };
  try { parsed = JSON.parse(text) as { differences?: unknown; skipped?: unknown }; } catch (cause) { throw new DriftUnreadable(`the fleet drift record is not JSON: ${(cause as Error).message}`); }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.differences)) throw new DriftUnreadable("the fleet drift record has no list of differences");
  // A box the hourly check did not ask because a `maintain` lease held it (`skipped`) was REACHABLE; its last differences are carried only because they
  // could not be refreshed this hour, so they still count: otherwise a drifting box would be offered to a job the moment the lease ended.
  const skipped = typeof parsed.skipped === "object" && parsed.skipped !== null ? parsed.skipped : {};
  const found: Record<string, string[]> = {};
  for (const entry of parsed.differences as Entry[]) {
    if (typeof entry?.box !== "string") throw new DriftUnreadable("the fleet drift record has a difference that names no box");
    if (entry.carried === true && !(entry.box in skipped)) continue;
    (found[entry.box] ??= []).push(`${String(entry.field)} is ${String(entry.has ?? "unread")}, the manifest wants ${String(entry.wants)}`);
  }
  return Object.fromEntries(Object.entries(found).map(([box, lines]) => [box, `off the manifest: ${lines.join("; ")}`]));
}

/** Reads the record again only when its mtime has moved, so asking on every tick costs one `stat`. */
export function driftReader(path: string = FLEET_DRIFT_PATH): DriftReader {
  let seen = -1;
  let last: Record<string, string> = {};
  return () => {
    try {
      const { mtimeMs } = statSync(path);
      if (mtimeMs !== seen) { last = driftFrom(readFileSync(path, "utf8")); seen = mtimeMs; }
    } catch (error) {
      seen = -1;
      last = {};
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return last;
      throw error instanceof DriftUnreadable ? error : new DriftUnreadable(`the fleet drift record cannot be read: ${(error as Error).message}`);
    }
    return last;
  };
}
