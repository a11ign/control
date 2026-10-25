import type { BoxReading, CaseSpec, CaptureEntry, GroupSpec } from "./types.ts";

/**
 * A JOB OF CASES (A11-263): each capture has its own id, URL and body, and a group holds the cases that must share a box. This file is the cases file
 * a submit reads and the refusals it makes, in words, and the two decisions that are about a group: whether it is skipped, and where an interrupted one
 * can go. All of it is PURE.
 */

/** A case id is a file name's stem: `<id>.a<attempt>.json` is its record. `manifest` is the manifest's own name. */
export const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,160}$/;

/** Fields of the worker's `/capture` body that the service sets for itself. */
export const SERVICE_FIELDS = ["url", "captureId", "async"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isUrl = (text: unknown): boolean => {
  try { return typeof text === "string" && ["http:", "https:"].includes(new URL(text).protocol); } catch { return false; }
};

/** The first thing wrong with the capture body a submit carries, or null. */
export function bodyRefusal(body: unknown): string | null {
  if (!isObject(body)) return "the capture body is not an object";
  const owned = SERVICE_FIELDS.filter((field) => field in body);
  return owned.length ? `the capture body sets ${owned.join(", ")}, which the service sets for itself` : null;
}

const PRIMITIVE = (value: unknown): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);

function groupRefusal(name: string, spec: unknown): string | null {
  if (!isObject(spec)) return `group ${name} is not an object`;
  const extra = Object.keys(spec).filter((key) => key !== "skipWhen");
  if (extra.length) return `group ${name} sets ${extra.join(", ")}: only skipWhen is a group's to set (a box is pinned by a re-capture, never by a submit)`;
  if (spec.skipWhen === undefined) return null;
  const skip = spec.skipWhen;
  const fields = isObject(skip) && isObject(skip.environment) ? skip.environment : null;
  if (!fields || Object.keys(skip).length !== 1) return `group ${name}: skipWhen is { "environment": { <field>: <value>, ... } }`;
  if (!Object.keys(fields).length) return `group ${name}: skipWhen.environment names no field, so it would skip on every box`;
  const bad = Object.entries(fields).find(([, value]) => !PRIMITIVE(value));
  return bad ? `group ${name}: skipWhen.environment.${bad[0]} is not a string, number, boolean or null` : null;
}

/** The first thing wrong with one case, or null. */
function caseRefusal(entry: unknown, index: number): string | null {
  if (!isObject(entry)) return `case ${index + 1} is not an object`;
  const { id, url, body, group } = entry;
  if (typeof id !== "string" || !CASE_ID.test(id)) return `case ${index + 1} has an id that is not letters, digits and . _ + - (starting with a letter or digit, at most 161): ${JSON.stringify(id)}`;
  if (id === "manifest") return `case ${index + 1} is called manifest, which is the manifest's own name`;
  if (!isUrl(url)) return `case ${id}: url is not an http or https URL: ${JSON.stringify(url)}`;
  const bad = bodyRefusal(body);
  if (bad) return `case ${id}: ${bad}`;
  if (group !== undefined && (typeof group !== "string" || !CASE_ID.test(group))) return `case ${id}: group is not a name of letters, digits and . _ + -: ${JSON.stringify(group)}`;
  if (entry.attempt !== undefined) return `case ${id} sets attempt, which a re-capture sets and a submit does not`;
  return null;
}

/** The group a case belongs to: its own, or one of its own named by its id. */
export const groupOf = (entry: Pick<CaseSpec, "id" | "group">): string => entry.group ?? entry.id;

/** The first thing wrong with the cases and groups of a submit, in words, or null. */
export function casesRefusal(cases: unknown, groups: unknown): string | null {
  if (!Array.isArray(cases) || !cases.length) return "no cases were given";
  for (const [index, entry] of cases.entries()) {
    const why = caseRefusal(entry, index);
    if (why) return why;
  }
  const specs = cases as CaseSpec[];
  const ids = specs.map((entry) => entry.id);
  const lower = ids.map((id) => id.toLowerCase());
  const twice = ids.find((_, i) => lower.indexOf(lower[i]!) !== i);
  if (twice !== undefined) return `case ${twice} is given twice (ids that differ only in letter case are the same file on some disks): a case id is unique in the job`;
  const named = new Set(specs.filter((entry) => entry.group !== undefined).map((entry) => entry.group!));
  const clash = specs.find((entry) => entry.group === undefined && named.has(entry.id));
  if (clash) return `case ${clash.id} has no group, so it is a group of its own, and another case's group has that name`;
  if (groups === undefined) return null;
  if (!isObject(groups)) return "groups is not an object of group name to its settings";
  const used = new Set(specs.map(groupOf));
  const unknown = Object.keys(groups).find((name) => !used.has(name));
  if (unknown !== undefined) return `groups names ${unknown}, which no case belongs to`;
  for (const [name, spec] of Object.entries(groups)) {
    const why = groupRefusal(name, spec);
    if (why) return why;
  }
  return null;
}

/**
 * The cases file: `{ "cases": [{ id, url, body, group? }], "groups": { <name>: { skipWhen? } } }`. A refusal is a sentence naming what is wrong. A re-capture
 * pins a box and sets an attempt, which a file may not.
 */
export function parseCasesFile(text: string): { cases: CaseSpec[]; groups: Record<string, GroupSpec> } | { refusal: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (cause) { return { refusal: `the cases file is not JSON: ${(cause as Error).message}` }; }
  if (!isObject(parsed) || !Array.isArray(parsed.cases)) return { refusal: "the cases file is JSON but not { \"cases\": [...] }" };
  const refusal = casesRefusal(parsed.cases, parsed.groups);
  if (refusal) return { refusal };
  return { cases: parsed.cases as CaseSpec[], groups: (parsed.groups ?? {}) as Record<string, GroupSpec> };
}

/** The note on a capture that was skipped because its group's `skipWhen` matched. */
export const SKIPPED = "environment matches skipWhen";

/** The record a case's attempt is written to: `<id>.a<attempt>.json`. */
export const caseRecordFile = (id: string, attempt: number): string => `${id}.a${attempt}.json`;

/** The entries of a group, in the order they were planned. */
export const entriesOf = (captures: CaptureEntry[], group: string): CaptureEntry[] => captures.filter((c) => c.group === group);

/**
 * Whether a group is skipped on a box: every field `skipWhen` names equals what the box's `/health` said when the job began (a field it did not say
 * reads as null). A box that was not read, or said no environment, never skips: a skip is a claim about a box, and nothing was read from it.
 */
export function skipsOn(spec: GroupSpec | undefined, reading: BoxReading | null | undefined): boolean {
  const wanted = spec?.skipWhen?.environment;
  if (!wanted || !reading?.environment) return false;
  return Object.entries(wanted).every(([field, value]) => (reading.environment![field] ?? null) === value);
}

/**
 * Mark `skipped` every group on `box` that has not begun and whose `skipWhen` matches the box's reading. Idempotent, and decided once for every group on
 * the box, so a box that leaves, or a box a restart finds gone, skips such a group and does not fail it. Returns the cases it marked.
 */
export function skipMatchingGroups(captures: CaptureEntry[], groups: Record<string, GroupSpec>, box: string, reading: BoxReading | null | undefined): CaptureEntry[] {
  const skipped: CaptureEntry[] = [];
  for (const group of new Set(captures.filter((c) => c.box === box && c.group !== undefined).map((c) => c.group!))) {
    const entries = entriesOf(captures, group);
    if (!entries.every((c) => c.status === "pending") || !skipsOn(groups[group], reading)) continue;
    for (const entry of entries) { entry.status = "skipped"; entry.note = SKIPPED; skipped.push(entry); }
  }
  return skipped;
}

/**
 * Where the groups of an interrupted job go when a box is gone from the inventory at a restart. A group moves only WHOLE and only if none of its cases
 * ended on the old box, and a group pinned to the box by a re-capture does not move at all: it was put there to sit beside what it is compared with.
 * Every other pending case of the box fails, naming why. Returns the cases that moved and the cases that failed; `captures` is changed in place.
 */
export function reassignGroups(captures: CaptureEntry[], groups: Record<string, GroupSpec>, from: string, live: string[]): { moved: CaptureEntry[]; failed: { entry: CaptureEntry; error: string }[] } {
  const moved: CaptureEntry[] = [];
  const failed: { entry: CaptureEntry; error: string }[] = [];
  const unfinished = (box: string) => captures.filter((c) => c.box === box && (c.status === "pending" || c.status === "dispatched")).length;
  const here = [...new Set(captures.filter((c) => c.box === from && c.status === "pending").map((c) => c.group!))];
  for (const group of here) {
    const all = entriesOf(captures, group);
    const pending = all.filter((c) => c.status === "pending");
    const begun = all.some((c) => c.status !== "pending");
    const pinned = groups[group]?.box === from;
    if (begun || pinned || !live.length) {
      const why = pinned ? `group ${group} is pinned to ${from} by a re-capture, and a group is never moved off the box it is compared on`
        : begun ? `group ${group} was already partly captured there, and a group is never split across boxes`
        : "no box is left";
      for (const entry of pending) failed.push({ entry, error: `${from} left the fleet; ${why}` });
      continue;
    }
    const box = live.reduce((best, candidate) => unfinished(candidate) < unfinished(best) ? candidate : best);
    for (const entry of pending) { entry.box = box; moved.push(entry); }
  }
  return { moved, failed };
}
