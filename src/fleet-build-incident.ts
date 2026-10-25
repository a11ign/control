// @ts-check
/**
 * The Windows build spread has an owner that acts on it: ONE open incident, whose being open IS the stop (a11ign#5026,
 * the chairman's ruling on #4405).
 *
 * `fleet-watch` already named each odd box once on #928 (`offFleetLines`, #4447), and nothing stopped. 2026-10-11 the
 * fleet sat 10 / 2 / 3 across three builds while captures were being dispatched. The ruling: "If any worker is on a
 * different Windows build from the others, the fleet stops. No lab job, corpus run or other fleet change proceeds until
 * EVERY box is moved FORWARD to the newest build on the fleet. Never backwards, never 'leave the odd one'."
 *
 * ## The contract, the same in the four rows that touch it
 *
 * The incident is ONE GitHub issue in `a11ign/a11ign` labelled `incident`, `lane:orchestrator`, `ready`, `priority` and
 * `out-of-release`, titled `Mixed Windows build across the fleet: <n> boxes behind <target>`, whose body carries
 * `FLEET_BUILD_INCIDENT_LINE` on a line of its own. **OPEN means the line is stopped; CLOSED means the fleet read one
 * build.** The dispatch row and the patch-start row import `FLEET_BUILD_INCIDENT_LINE` and `openFleetBuildIncident`;
 * nothing else spells the line, and the reader matches a LINE equal to it, never the text anywhere in a body (this row's
 * own Acceptance quotes the id, and so would a comment).
 *
 * ## Why the target is the HIGHEST build and not the common one
 *
 * Ten boxes on the older build make the older build the common one, and `offFleetLines` would name the five on the newer
 * build as odd. The ruling is "forward to the newest", so the target is the highest build compared as dotted numbers
 * (`10.0.9` is below `10.0.10`, which a string compare reverses).
 *
 * ## "Closed" needs EVERY box read, "open" needs only two that differ
 *
 * A fleet that reads one build over a subset is `fleet-status`'s rule too (never CONSISTENT over a subset): a box that did
 * not answer, or answered the `unknown` placeholder, may be the one on another build, so the incident stays open. And two
 * boxes on different builds are mixed whatever the third did, so filing needs no such completeness.
 *
 * The reading is `fleetStatus`' `windowsBuilds`: the build each reachable box reported, keyed by URL, whether or not they
 * agree (#5106). It used to be the drift, which carries a `windowsBuild` entry only where somebody disagrees, so a fleet
 * that agreed on the `unknown` placeholder (a fleet-wide restart before the first sample) had no entry and read as every
 * box read: the incident closed while the fleet could still be mixed. A box is READ when it reported a real build, so the
 * placeholder, a box that answered without one, a box with no `environment` and a box that did not answer are all
 * unread, whether the rest agree or not.
 *
 * A status with no `windowsBuilds` (a reader that predates it) claims nothing read and falls back to the drift's values,
 * which can still show a mix: absence of the field is never "everybody agreed".
 *
 * ## Every `gh` call is behind `IncidentDeps`, and a failing one THROWS
 *
 * A throw is "I could not ask", which `fleetBuildIncidentTick` turns into `cannotAsk` so the watch exits `CANNOT_ASK` and
 * never QUIET (#4714's rule). Without `--post` the effects are replaced by `readOnlyIncidentDeps`: reading is free, a dry
 * run files nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readPlaysInFlight } from "./fleet-auto-off.ts";
import { readFleetLock, type FleetLockReading } from "./fleet-lock.ts";
import { boxValues, workerKey, type BoxValue, type Drift, type FleetRow } from "./fleet-watch.ts";

export const FLEET_BUILD_INCIDENT_ID = "incident:fleet-build-mixed";
/** The one line that makes an issue THE incident. Dispatch and patch-start import this; nobody retypes it. */
export const FLEET_BUILD_INCIDENT_LINE = `Incident: ${FLEET_BUILD_INCIDENT_ID}`;
export const FLEET_BUILD_INCIDENT_REPO = "a11ign/a11ign";
export const FLEET_BUILD_INCIDENT_LABELS = ["incident", "lane:orchestrator", "ready", "priority", "out-of-release"];
export const FLEET_BUILD_INCIDENT_TITLE = "Mixed Windows build across the fleet";

const WINDOWS_BUILD_FIELD = "windowsBuild";
const LIST_LIMIT = 100;
const GH_TIMEOUT_MS = 60_000;
const TARGET_PREFIX = "Target: ";
const NOT_READ_PREFIX = "Not read: ";

export type BuildStatus = { rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[], windowsBuilds?: Record<string, string | null> };
export type BoxBuild = { box: string, build: string };

/**
 * `read` and `unread` are box NAMES (the inventory name, without its address); together they are every row. `target` is the
 * highest build read, `null` when no box reported a real one. `laggards` is empty unless `mixed`.
 */
export type BuildSpread = { mixed: boolean, target: string | null, laggards: BoxBuild[], read: string[], unread: string[] };

const compareNumeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function windowsBuildDrift(status: BuildStatus): Drift | undefined {
  return [...(status.mismatches ?? []), ...(status.reportedOnly ?? [])].find((drift) => drift.field === WINDOWS_BUILD_FIELD);
}

/** Reachable boxes that reported a real build; `boxValues` drops the placeholder, an empty value and an unreachable box. */
function readingsOf(status: BuildStatus): BoxValue[] {
  const values = status.windowsBuilds ?? windowsBuildDrift(status)?.values ?? {};
  return boxValues({ field: WINDOWS_BUILD_FIELD, values }, status.rows);
}

/** The spread of the Windows build across one reading. Pure: a fleet on one build, or one nobody reports on, is not mixed. */
export function buildSpread(status: BuildStatus): BuildSpread {
  const readings = readingsOf(status);
  const read = readings.map(({ box }) => box).sort(compareNumeric);
  const seen = new Set(read);
  const unread = status.rows.map((row) => workerKey(row.name)).filter((box) => !seen.has(box)).sort(compareNumeric);
  const builds = [...new Set(readings.map(({ value }) => value))].sort(compareNumeric);
  const target = builds.at(-1) ?? null;
  const mixed = builds.length > 1;
  const laggards = !mixed ? [] : readings
    .flatMap(({ box, value }) => (value !== target ? [{ box, build: value }] : []))
    .sort((a, b) => compareNumeric(a.box, b.box));
  return { mixed, target, laggards, read, unread };
}

export const incidentTitle = (spread: BuildSpread) => `${FLEET_BUILD_INCIDENT_TITLE}: ${spread.laggards.length} boxes behind ${spread.target}`;

/**
 * The incident as a row in the issue template, so the gate can read it. The `Incident:` line is on a line of its own and
 * `openFleetBuildIncident` reads `Target:` and the `- <box>: <build>` lines back out of this same text.
 */
export function incidentBody(spread: BuildSpread, readAt: string): string {
  const notRead = spread.unread.length ? [`${NOT_READ_PREFIX}${spread.unread.join(", ")}`, ""] : [];
  return [
    "## What it is",
    "",
    `**The fleet reads more than one Windows build, and the line is stopped.** Boxes behind the newest build on the fleet: ${spread.laggards.length}. `
      + "No lab job, corpus run or other fleet change proceeds until EVERY box is moved FORWARD to it: never backwards, never \"leave the odd one\" "
      + "(chairman ruling, a11ign#4405). `fleet-watch` closes this issue itself on the first reading where every box reads one build.",
    "",
    `${TARGET_PREFIX}${spread.target}`,
    "",
    ...spread.laggards.map(({ box, build }) => `- ${box}: ${build}`),
    "",
    ...notRead,
    `Read by \`fleet-watch\` at ${readAt}, a reading at a moment: re-run the Acceptance, not this list.`,
    "",
    FLEET_BUILD_INCIDENT_LINE,
    "",
    "## Change",
    "",
    "None. This row is a reading: move each box named above forward to the target with `fleet:patch` (the orchestrator's), and the incident clears itself.",
    "",
    "## Region",
    "",
    "A reading: no file is changed by this row.",
    "",
    "## Acceptance",
    "",
    "```bash",
    "gh issue list --repo a11ign/a11ign --label incident --state open --json body --jq "
      + `'[.[]|select(.body|contains("${FLEET_BUILD_INCIDENT_ID}"))]|length'`,
    "```",
    "",
    "It prints `0` once the fleet has read one build; `fleet-watch` closes this issue on that reading, so there is nothing to close by hand.",
    "",
    "## Open-check",
    "",
    `Read ${readAt}. The sentence that is TRUE while this is open and FALSE once it closes: **the fleet reads more than one Windows build.**`,
    "",
    "```",
    "$ pnpm run fleet:status",
    "```",
    "",
    "## Done-when",
    "",
    "1. Every box reads the target build, none unreachable and none a placeholder.",
    "2. The incident is closed by the watch (`fleet-watch`), with the final reading in its closing comment.",
    "",
    "## Tier",
    "",
    "Tier: sonnet -- a forward patch run the orchestrator drives with `fleet:patch`; the judgment is only which box first.",
    "",
    "## Fleet",
    "",
    "Yes. The remedy patches the boxes it names.",
    "",
  ].join("\n");
}

export type OpenIncident = { number: number, createdAt: string, target: string | null, laggards: BoxBuild[] };

/** The issues carrying the incident line, read back out of their bodies. Pure. */
export function parseIncident(issue: { number: number, createdAt: string, body: string }): OpenIncident | null {
  const lines = issue.body.split("\n").map((line) => line.trim());
  if (!lines.includes(FLEET_BUILD_INCIDENT_LINE)) return null;
  const target = lines.find((line) => line.startsWith(TARGET_PREFIX))?.slice(TARGET_PREFIX.length) ?? null;
  const laggards = lines.flatMap((line) => {
    const named = /^- (\S+): (\S+)$/.exec(line);
    return named ? [{ box: named[1], build: named[2] }] : [];
  });
  return { number: issue.number, createdAt: issue.createdAt, target, laggards };
}

/** The start the record keeps, one per incident: `outcome` is `running` until the patch entry has answered. */
export type PatchStart = { issue: number, startedAt: string, outcome: string };

export type PatchStartDeps = {
  /** The recorded start, `null` when none has been made. Throws when the record cannot be read: unknown is not "never started". */
  readRecord: () => PatchStart | null;
  writeRecord: (record: PatchStart) => void;
  /** Why the patch may not start now (a play running, the fleet locked, or either unreadable), `null` when it may. */
  busyReason: () => string | null;
  /** Runs the patch entry `fleet:patch --apply` uses. `refusal` is its REFUSING line, when it refused. */
  runPatch: () => { status: number, refusal: string };
  /** Posts the outcome on the incident issue. */
  comment: (issue: number, body: string) => void;
};

export type IncidentDeps = {
  /** Every open incident, oldest first. Throws when GitHub cannot be asked: "none open" is an answer, a throw is not. */
  listOpen: () => OpenIncident[];
  /** @returns what GitHub called the new issue (its URL), for the #928 line */
  file: (draft: { title: string, body: string, labels: string[] }) => string;
  close: (issue: number, how: { reason: "completed" | "not planned", comment: string }) => void;
  /** The forward patch for the laggards: started once per incident, and never while another play runs. */
  patch: PatchStartDeps;
  now?: () => number;
};

export type Reconciliation = {
  filed: string | null,
  closed: number[],
  heldOpen: { issue: number, unread: string[] } | null,
  /** The start made this reading, with its outcome; `null` when none was made. */
  patch: PatchStart | null,
  /** Why a start was due but not made this reading (busy, or a new issue number that could not be read). Retried next reading. */
  patchHeld: string | null,
};

const NOTHING: Reconciliation = { filed: null, closed: [], heldOpen: null, patch: null, patchHeld: null };
const NO_START = { patch: null, patchHeld: null };

function closeDuplicates(open: OpenIncident[], deps: IncidentDeps): number[] {
  const [keep, ...newer] = open;
  for (const duplicate of newer) {
    deps.close(duplicate.number, { reason: "not planned", comment: `Duplicate of #${keep.number}: two ticks filed the same incident, and the older one stands.` });
  }
  return newer.map(({ number }) => number);
}

function finalReading(spread: BuildSpread): string {
  const build = spread.target === null ? "" : ` (${spread.target})`;
  return `The fleet reads one Windows build${build}: ${spread.read.length} boxes read, none unreachable and none a placeholder. The line is no longer stopped.`;
}

/**
 * The effect, once per reading. Mixed and none open: file ONE, then start its patch. Mixed and one open: start its patch
 * unless it already has one, and no comment per tick. Two open: close the newer as a duplicate of the older. One build,
 * one open, every box read: comment the final reading and close it. One build with a box unread: left open, because a
 * subset is not the fleet.
 */
export function reconcileIncident(spread: BuildSpread, deps: IncidentDeps): Reconciliation {
  const open = deps.listOpen();
  const closed = open.length > 1 ? closeDuplicates(open, deps) : [];
  const standing = open[0];
  if (!standing) return spread.mixed ? startAfterFiling(spread, deps) : NOTHING;
  if (spread.mixed) return { ...NOTHING, closed, ...startPatchFor(standing.number, deps) };
  if (spread.unread.length > 0) return { ...NOTHING, closed, heldOpen: { issue: standing.number, unread: spread.unread } };
  deps.close(standing.number, { reason: "completed", comment: finalReading(spread) });
  return { ...NOTHING, closed: [...closed, standing.number] };
}

function startAfterFiling(spread: BuildSpread, deps: IncidentDeps): Reconciliation {
  const filed = fileIncident(spread, deps);
  const issue = issueNumberOf(filed);
  if (issue === null) return { ...NOTHING, filed, patchHeld: `the new incident's number is not in ${filed}; the start waits for the next reading` };
  return { ...NOTHING, filed, ...startPatchFor(issue, deps) };
}

/** The issue number from the URL `gh issue create` prints, `null` for anything else. */
export function issueNumberOf(url: string): number | null {
  const match = /\/issues\/(\d+)\s*$/.exec(url);
  return match ? Number(match[1]) : null;
}

function fileIncident(spread: BuildSpread, deps: IncidentDeps): string {
  const readAt = new Date((deps.now ?? Date.now)()).toISOString();
  return deps.file({ title: incidentTitle(spread), body: incidentBody(spread, readAt), labels: FLEET_BUILD_INCIDENT_LABELS });
}

/**
 * The forward patch for this incident, at most once. The record is read first, so a start already made (or refused, or
 * failed) is never repeated. A busy reading is NOT recorded: the next reading asks again. The record says `running` BEFORE
 * the patch entry runs, so a watch that dies mid-run leaves a start that is never retried, not a second patch.
 */
function startPatchFor(issue: number, deps: IncidentDeps): Pick<Reconciliation, "patch" | "patchHeld"> {
  const { patch: start } = deps;
  if (start.readRecord()?.issue === issue) return NO_START;
  const busy = start.busyReason();
  if (busy) return { patch: null, patchHeld: `${busy}; the start waits for a reading with the fleet idle` };
  const startedAt = new Date((deps.now ?? Date.now)()).toISOString();
  start.writeRecord({ issue, startedAt, outcome: "running" });
  const { status, refusal } = start.runPatch();
  const patch = { issue, startedAt, outcome: patchOutcome(status, refusal) };
  start.writeRecord(patch);
  start.comment(issue, patchCommentBody(patch));
  return { patch, patchHeld: null };
}

function patchOutcome(status: number, refusal: string): string {
  if (status === 0) return "done";
  return refusal ? `refused: ${refusal}` : `failed: exit ${status}`;
}

function patchCommentBody({ issue, outcome }: PatchStart): string {
  return `**\`fleet-watch\` does not upgrade the fleet** (#4405, A11-205), and said so once for this incident. Outcome: ${outcome}. `
    + "It is never retried by the watch: the line stays stopped until a person edits `deploy-pins.json` and moves the boxes "
    + `(\`fleet:patch -- --apply\`), or closes this incident (#${issue}).`;
}

export type Gh = (args: string[]) => string;

/** The one `gh` runner: ambient credential, throws on a non-zero exit with `gh`'s own words. */
export const runGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });

/**
 * Oldest first by CREATION TIME, the issue number breaking a tie. The number is not the age: a transferred issue is
 * renumbered on arrival, so the older incident can carry the higher number and "the older one stands" must not read it.
 * A `createdAt` that does not parse sorts last, so it never outranks a dated incident.
 */
function byCreation(a: OpenIncident, b: OpenIncident): number {
  const at = (incident: OpenIncident) => {
    const time = Date.parse(incident.createdAt);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  const [first, second] = [at(a), at(b)];
  if (first !== second) return first < second ? -1 : 1;
  return a.number - b.number;
}

/** `gh issue list --label` is a list and not a search, so an issue filed a second ago is in it: search lags and would file twice. */
export function ghIncidentDeps(gh: Gh = runGh, patch: PatchStartDeps = ghPatchStartDeps()): IncidentDeps {
  const repo = ["--repo", FLEET_BUILD_INCIDENT_REPO];
  return {
    listOpen: () => {
      const listed: { number: number, createdAt: string, body: string }[] = JSON.parse(
        gh(["issue", "list", ...repo, "--state", "open", "--label", "incident", "--limit", String(LIST_LIMIT), "--json", "number,createdAt,body"]));
      return listed.flatMap((issue) => parseIncident(issue) ?? []).sort(byCreation);
    },
    file: ({ title, body, labels }) =>
      gh(["issue", "create", ...repo, "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])]).trim(),
    close: (issue, { reason, comment }) => {
      gh(["issue", "close", String(issue), ...repo, "--reason", reason, "--comment", comment]);
    },
    patch,
  };
}

/** The record of starts, beside `fleet-watch-state.json`: relative to the control checkout, as that file's path is. */
export const FLEET_BUILD_INCIDENT_STATE_PATH = "runs/fleet-build-incident-state.json";

/**
 * The real start: the record on disk, the busy readers `fleet-auto-off` and `fleet-lock` already answer with, and a start that REFUSES.
 *
 * It used to spawn `patch.yml --apply` from this watch. Nothing on a box upgrades by itself (A11-205, docs/adr/0001): an upgrade is a person's run from an edited
 * `deploy-pins.json`, and a machine that started one whenever two boxes read different builds was the converge-forward drift that ADR ends (it also targeted the newest
 * build, which is no longer anything). The incident is still filed and still stops the line; the start is recorded once as refused, with the command a person runs.
 */
export function ghPatchStartDeps(path = FLEET_BUILD_INCIDENT_STATE_PATH, gh: Gh = runGh, now: () => number = Date.now): PatchStartDeps {
  return {
    readRecord: () => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null),
    writeRecord: (record) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    },
    busyReason: () => busyReasonAt(now()),
    runPatch: refuseUnattendedUpgrade,
    comment: (issue, body) => {
      gh(["issue", "comment", String(issue), "--repo", FLEET_BUILD_INCIDENT_REPO, "--body", body]);
    },
  };
}

/**
 * A play in flight of ANY playbook counts, not only the patch's: two plays on the fleet at once is what the gate forbids.
 * The readers are the real ones by default; a test answers for them.
 */
export function busyReasonAt(now: number, readers: { plays?: () => ReturnType<typeof readPlaysInFlight>, lock?: (now: number) => FleetLockReading } = {}): string | null {
  const plays = (readers.plays ?? readPlaysInFlight)();
  if (plays.reading !== "none") return `a fleet play is ${plays.reading} (${plays.detail})`;
  const lock = (readers.lock ?? readFleetLock)(now);
  if (lock.state === "held") return `the fleet is held by ${lock.lock.holder} (${lock.lock.operation})`;
  if (lock.state === "unreadable") return `the fleet lock is unreadable (${lock.detail})`;
  return null;
}

/** The start that is not made: the deliberate upgrade is a person's (`fleet:patch -- --apply`, after editing `deploy-pins.json`). */
export function refuseUnattendedUpgrade(): { status: number, refusal: string } {
  return { status: 2, refusal: "REFUSING: the fleet upgrade is a person's run, not the watch's (A11-205, docs/adr/0001): edit deploy-pins.json and run `pnpm run fleet:patch -- --apply`" };
}

/** Reading is free and a dry run writes nothing: the effects are said, not done, and a start is said with its target. */
export function readOnlyIncidentDeps(deps: IncidentDeps, say: (line: string) => void = console.log): IncidentDeps {
  return {
    ...deps,
    file: ({ title }) => {
      say(`WOULD FILE: ${title}`);
      return "(dry run: not filed)";
    },
    close: (issue, { reason }) => say(`WOULD CLOSE #${issue}: ${reason}`),
    patch: {
      ...deps.patch,
      writeRecord: () => {},
      runPatch: () => {
        say("WOULD NOT START an upgrade: it is a person's run (fleet:patch --apply, after editing deploy-pins.json)");
        return { status: 0, refusal: "" };
      },
      comment: (issue) => say(`WOULD COMMENT on #${issue}: the patch's outcome`),
    },
  };
}

/** The open incident the other rows read: the oldest when there are two. `null` is "none open"; a `gh` that fails THROWS. */
export function openFleetBuildIncident(deps: Pick<IncidentDeps, "listOpen"> = ghIncidentDeps()): OpenIncident | null {
  return deps.listOpen()[0] ?? null;
}

/** What one watch tick reports of the incident: lines for the #928 post, and why it could not ask (`null` when it could). */
export type BuildIncidentTick = { fresh: string[], closed: number[], cannotAsk: string | null };

export const NO_INCIDENT_TICK: BuildIncidentTick = { fresh: [], closed: [], cannotAsk: null };

/**
 * One reading's worth of the incident. A `gh` that throws is `cannotAsk`, said on stderr: an unread GitHub is not a fleet on
 * one build, and the watch must not read it as QUIET.
 */
export function fleetBuildIncidentTick(status: BuildStatus, deps: IncidentDeps): BuildIncidentTick {
  try {
    const { filed, closed, heldOpen, patch, patchHeld } = reconcileIncident(buildSpread(status), deps);
    if (heldOpen) console.log(`fleet build incident #${heldOpen.issue} held open: ${heldOpen.unread.join(", ")} not read, and a subset is not the fleet`);
    if (patchHeld) console.log(`fleet build incident forward patch not started: ${patchHeld}`);
    const fresh = [
      ...(filed === null ? [] : [`${filed} -- the line is stopped (${FLEET_BUILD_INCIDENT_ID})`]),
      ...(patch === null ? [] : [`forward patch for the incident #${patch.issue}: ${patch.outcome}`]),
    ];
    return { fresh, closed, cannotAsk: null };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.error(`CANNOT ASK GitHub about the fleet build incident: ${reason}`);
    return { fresh: [], closed: [], cannotAsk: reason };
  }
}

/** The comment body for an incident filed this tick. */
export function incidentFiledBody(lines: string[]): string {
  return [`**The fleet is on more than one Windows build: stop the line** (#4405).`, ...lines.map((line) => `- ${line}`)].join("\n");
}
