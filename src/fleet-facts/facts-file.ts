import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomic } from "../fleet-jobs/store.ts";
import type { BoxFacts, FactsEntry, FactsFile } from "./types.ts";

/**
 * THE FACTS FILE (A11-283, ADR 0005): `fleet-facts.json`, beside the inventory on the control plane. The job service is its ONLY writer, one box at a time, by
 * read-merge-write. A good read replaces the box's entry; a failed one keeps the last facts and `readAt` and marks the entry stale.
 */
export const FACTS_FILE = "/etc/a11ign/fleet-facts.json";
/** The file's path for tests and for a service started somewhere else; the unit does not set it. */
export const FACTS_FILE_ENV = "A11Y_FLEET_FACTS_FILE";
export const FACTS_FILE_VERSION = 1;

export const factsFilePath = (env: NodeJS.ProcessEnv = process.env): string => env[FACTS_FILE_ENV] || FACTS_FILE;

export type ReadFile = { ok: true; value: FactsFile } | { ok: false; reason: string };

/** The file as it stands: a missing file is a first run and reads as empty; one that is not JSON, or of a version this code does not know, is said and never guessed at. */
export function readFactsFile(path: string): ReadFile {
  if (!existsSync(path)) return { ok: true, value: { version: FACTS_FILE_VERSION, boxes: {} } };
  let parsed: Partial<FactsFile>;
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FactsFile>; } catch (cause) { return { ok: false, reason: `${path} is unreadable: ${(cause as Error).message}` }; }
  if (parsed?.version !== FACTS_FILE_VERSION || typeof parsed.boxes !== "object" || parsed.boxes === null || Array.isArray(parsed.boxes)) {
    return { ok: false, reason: `${path} is version ${JSON.stringify(parsed?.version)} and this service reads version ${FACTS_FILE_VERSION}` };
  }
  return { ok: true, value: parsed as FactsFile };
}

export type Attempt = { box: string; job: string; at: string } & ({ facts: BoxFacts } | { error: string });

/** The entry after an attempt: the new facts, or the old ones kept and marked stale. A box never read has `facts: null` and `stale: true`. */
export function entryAfter(previous: FactsEntry | undefined, attempt: Attempt): FactsEntry {
  if ("facts" in attempt) return { readAt: attempt.at, stale: false, lastAttemptAt: attempt.at, lastJob: attempt.job, lastError: null, facts: attempt.facts };
  return { readAt: previous?.readAt ?? null, stale: true, lastAttemptAt: attempt.at, lastJob: attempt.job, lastError: attempt.error, facts: previous?.facts ?? null };
}

/**
 * Put one attempt into the file. A file that cannot be read is NOT overwritten: the reason is returned, and the caller fails the box's entry naming it.
 * The file is the only record of the last good facts of every other box, so a guess at its contents would lose them.
 */
export function recordAttempt(path: string, attempt: Attempt): { ok: true } | { ok: false; reason: string } {
  const read = readFactsFile(path);
  if (!read.ok) return read;
  const file: FactsFile = { version: FACTS_FILE_VERSION, boxes: { ...read.value.boxes, [attempt.box]: entryAfter(read.value.boxes[attempt.box], attempt) } };
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, file);
  return { ok: true };
}
