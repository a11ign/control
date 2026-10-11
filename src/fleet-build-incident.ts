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
 * The reading is `fleetStatus`' own drift: when nobody disagrees there is NO `windowsBuild` entry and no values to show,
 * so a fleet that agrees reads as every reachable box read with no build named. `compared` (how many guests the drift is
 * about) says whether a reachable box was dropped from that comparison for carrying no environment; if it was, nothing
 * is claimed read.
 *
 * ## Every `gh` call is behind `IncidentDeps`, and a failing one THROWS
 *
 * A throw is "I could not ask", which `fleetBuildIncidentTick` turns into `cannotAsk` so the watch exits `CANNOT_ASK` and
 * never QUIET (#4714's rule). Without `--post` the effects are replaced by `readOnlyIncidentDeps`: reading is free, a dry
 * run files nothing.
 */
import { execFileSync } from "node:child_process";
import { boxValues, workerKey, type Drift, type FleetRow } from "./fleet-watch.ts";

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

export type BuildStatus = { rows: FleetRow[], mismatches?: Drift[], reportedOnly?: Drift[], compared?: number };
export type BoxBuild = { box: string, build: string };

/**
 * `read` and `unread` are box NAMES (the inventory name, without its address); together they are every row. `target` is the
 * highest build read, `null` when nothing named one (a fleet that agrees names none). `laggards` is empty unless `mixed`.
 */
export type BuildSpread = { mixed: boolean, target: string | null, laggards: BoxBuild[], read: string[], unread: string[] };

const compareNumeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

type Reading = { box: string, build: string | null };

function windowsBuildDrift(status: BuildStatus): Drift | undefined {
  return [...(status.mismatches ?? []), ...(status.reportedOnly ?? [])].find((drift) => drift.field === WINDOWS_BUILD_FIELD);
}

/** `build: null` is a box that agreed with the rest: the drift carries values only when somebody disagrees. */
function readingsOf(status: BuildStatus): Reading[] {
  const drift = windowsBuildDrift(status);
  if (drift) return boxValues(drift, status.rows).map(({ box, value }) => ({ box, build: value }));
  const answered = status.rows.filter((row) => row.url && row.state !== "unreachable");
  const dropped = status.compared !== undefined && status.compared < answered.length;
  return dropped ? [] : answered.map((row) => ({ box: workerKey(row.name), build: null }));
}

/** The spread of the Windows build across one reading. Pure: a fleet on one build, or one nobody reports on, is not mixed. */
export function buildSpread(status: BuildStatus): BuildSpread {
  const readings = readingsOf(status);
  const read = readings.map(({ box }) => box).sort(compareNumeric);
  const seen = new Set(read);
  const unread = status.rows.map((row) => workerKey(row.name)).filter((box) => !seen.has(box)).sort(compareNumeric);
  const builds = [...new Set(readings.flatMap(({ build }) => (build === null ? [] : [build])))].sort(compareNumeric);
  const target = builds.at(-1) ?? null;
  const mixed = builds.length > 1;
  const laggards = !mixed ? [] : readings
    .flatMap(({ box, build }) => (build !== null && build !== target ? [{ box, build }] : []))
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

export type IncidentDeps = {
  /** Every open incident, oldest first. Throws when GitHub cannot be asked: "none open" is an answer, a throw is not. */
  listOpen: () => OpenIncident[];
  /** @returns what GitHub called the new issue (its URL), for the #928 line */
  file: (draft: { title: string, body: string, labels: string[] }) => string;
  close: (issue: number, how: { reason: "completed" | "not planned", comment: string }) => void;
  now?: () => number;
};

export type Reconciliation = { filed: string | null, closed: number[], heldOpen: { issue: number, unread: string[] } | null };

const NOTHING: Reconciliation = { filed: null, closed: [], heldOpen: null };

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
 * The effect, once per reading. Mixed and none open: file ONE. Mixed and one open: nothing, and no comment per tick. Two
 * open: close the newer as a duplicate of the older. One build, one open, every box read: comment the final reading and
 * close it. One build with a box unread: left open, because a subset is not the fleet.
 */
export function reconcileIncident(spread: BuildSpread, deps: IncidentDeps): Reconciliation {
  const open = deps.listOpen();
  const closed = open.length > 1 ? closeDuplicates(open, deps) : [];
  const standing = open[0];
  if (!standing) return spread.mixed ? { ...NOTHING, filed: fileIncident(spread, deps) } : NOTHING;
  if (spread.mixed) return { ...NOTHING, closed };
  if (spread.unread.length > 0) return { filed: null, closed, heldOpen: { issue: standing.number, unread: spread.unread } };
  deps.close(standing.number, { reason: "completed", comment: finalReading(spread) });
  return { ...NOTHING, closed: [...closed, standing.number] };
}

function fileIncident(spread: BuildSpread, deps: IncidentDeps): string {
  const readAt = new Date((deps.now ?? Date.now)()).toISOString();
  return deps.file({ title: incidentTitle(spread), body: incidentBody(spread, readAt), labels: FLEET_BUILD_INCIDENT_LABELS });
}

export type Gh = (args: string[]) => string;

/** The one `gh` runner: ambient credential, throws on a non-zero exit with `gh`'s own words. */
export const runGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });

/** `gh issue list --label` is a list and not a search, so an issue filed a second ago is in it: search lags and would file twice. */
export function ghIncidentDeps(gh: Gh = runGh): IncidentDeps {
  const repo = ["--repo", FLEET_BUILD_INCIDENT_REPO];
  return {
    listOpen: () => {
      const listed: { number: number, createdAt: string, body: string }[] = JSON.parse(
        gh(["issue", "list", ...repo, "--state", "open", "--label", "incident", "--limit", String(LIST_LIMIT), "--json", "number,createdAt,body"]));
      return listed.flatMap((issue) => parseIncident(issue) ?? []).sort((a, b) => a.number - b.number);
    },
    file: ({ title, body, labels }) =>
      gh(["issue", "create", ...repo, "--title", title, "--body", body, ...labels.flatMap((label) => ["--label", label])]).trim(),
    close: (issue, { reason, comment }) => {
      gh(["issue", "close", String(issue), ...repo, "--reason", reason, "--comment", comment]);
    },
  };
}

/** Reading is free and a dry run writes nothing: the three effects are said, not done. */
export function readOnlyIncidentDeps(deps: IncidentDeps, say: (line: string) => void = console.log): IncidentDeps {
  return {
    ...deps,
    file: ({ title }) => {
      say(`WOULD FILE: ${title}`);
      return "(dry run: not filed)";
    },
    close: (issue, { reason }) => say(`WOULD CLOSE #${issue}: ${reason}`),
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
    const { filed, closed, heldOpen } = reconcileIncident(buildSpread(status), deps);
    if (heldOpen) console.log(`fleet build incident #${heldOpen.issue} held open: ${heldOpen.unread.join(", ")} not read, and a subset is not the fleet`);
    return { fresh: filed === null ? [] : [`${filed} -- the line is stopped (${FLEET_BUILD_INCIDENT_ID})`], closed, cannotAsk: null };
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
