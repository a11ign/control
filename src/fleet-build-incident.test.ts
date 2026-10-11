// no-token: gh -- every test drives `buildSpread`/`reconcileIncident` or the `gh` seam (`Gh`, `IncidentDeps`) with a fake
// that records its argv; nothing here spawns `gh`, and `runGh` (the real runner) is never called.
//
// a11ign#5026: the Windows build spread files ONE stop-the-line incident and closes it when the fleet reads one build.
// The fleet's drift comes out of the REAL `fleetConsistency`, so a fixture cannot invent a shape `fleetStatus` never returns.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSpread, reconcileIncident, fleetBuildIncidentTick, ghIncidentDeps, readOnlyIncidentDeps, openFleetBuildIncident, parseIncident,
  incidentBody, incidentTitle, FLEET_BUILD_INCIDENT_LINE, FLEET_BUILD_INCIDENT_LABELS, FLEET_BUILD_INCIDENT_REPO,
  type BuildStatus, type IncidentDeps, type OpenIncident,
} from "./fleet-build-incident.ts";
import { fleetConsistency } from "../../worker-fleet/src/fleet-consistency.ts";
import { windowsBuildsOf } from "./fleet-status.ts";

const OLD = "10.0.22631";
const MID = "10.0.26100";
const NEW = "10.0.26200";

const urlOf = (n: number) => `http://10.0.0.${n}:8765`;
const nameOf = (n: number) => `a11y-worker-${n}`;
const rowOf = (n: number, state = "ready") => ({ name: `${nameOf(n)}  10.0.0.${n}`, url: urlOf(n), state });

/**
 * A box's build: a string, `null` for a box that answered without reporting one, `"down"` for one that did not answer,
 * `"no-environment"` for one that answered with no `environment` block at all.
 */
type Build = string | null | "down" | "no-environment";

function fleet(builds: Record<number, Build>): BuildStatus {
  const boxes = Object.entries(builds).map(([n, build]) => ({ n: Number(n), build }));
  const rows = boxes.map(({ n, build }) => rowOf(n, build === "down" ? "unreachable" : "ready"));
  const guests = boxes.filter(({ build }) => build !== "down").map(({ n, build }) => ({
    worker: urlOf(n),
    environment: build === "no-environment" ? undefined
      : build === null ? { displayMode: "1024x768" } : { displayMode: "1024x768", windowsBuild: build },
  }));
  const { mismatches, reportedOnly } = fleetConsistency(guests);
  // `windowsBuilds` comes out of the REAL `windowsBuildsOf`, the helper `fleetStatus` calls, so a fixture cannot invent it.
  return { rows, mismatches, reportedOnly, windowsBuilds: windowsBuildsOf(guests) };
}

const windowsBuildDrift = (status: BuildStatus) =>
  [...status.mismatches ?? [], ...status.reportedOnly ?? []].filter((drift) => drift.field === "windowsBuild");

/** `count` boxes numbered from `from` on one build. */
const on = (build: Build, from: number, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [from + i, build]));

const rulingMap = fleet({ ...on(OLD, 2, 10), ...on(MID, 12, 2), ...on(NEW, 14, 3) });
const oneBuild = fleet(on(NEW, 2, 15));

test("the ruling's 10 / 2 / 3 map is mixed, names 12 laggards with their builds, and targets the newest build", () => {
  const spread = buildSpread(rulingMap);
  assert.equal(spread.mixed, true);
  assert.equal(spread.target, NEW);
  assert.equal(spread.laggards.length, 12);
  assert.deepEqual(spread.laggards[0], { box: nameOf(2), build: OLD });
  assert.deepEqual(spread.laggards.at(-1), { box: nameOf(13), build: MID });
  assert.deepEqual(spread.unread, []);
  assert.equal(spread.read.length, 15);
});

test("one build across the fleet is not mixed (NEGATIVE CONTROL for the map above)", () => {
  const spread = buildSpread(oneBuild);
  assert.equal(spread.mixed, false);
  assert.deepEqual(spread.laggards, []);
  assert.equal(spread.target, NEW, "a fleet that agrees names the build: `windowsBuilds` carries it though no drift entry exists");
  assert.equal(spread.read.length, 15, "no `windowsBuild` drift entry exists when everybody agrees, and every box still reads as read");
  assert.deepEqual(spread.unread, []);
  assert.deepEqual(windowsBuildDrift(oneBuild), [], "positive control: the fixture really has no `windowsBuild` drift entry");
});

test("the target is the NEWEST build, not the common one: ten boxes on the older build and five on the newer still target the newer", () => {
  const spread = buildSpread(fleet({ ...on(OLD, 2, 10), ...on(NEW, 12, 5) }));
  assert.equal(spread.target, NEW);
  assert.equal(spread.laggards.length, 10, "the ten on the common build are the ones moved forward");
  assert.ok(spread.laggards.every(({ build }) => build === OLD));
});

test("builds compare as dotted NUMBERS: 10.0.9.1 is below 10.0.10.1, which a string compare reverses", () => {
  const spread = buildSpread(fleet({ 2: "10.0.9.1", 3: "10.0.10.1", 4: "10.0.10.1" }));
  assert.equal(spread.target, "10.0.10.1");
  assert.deepEqual(spread.laggards, [{ box: nameOf(2), build: "10.0.9.1" }]);
  assert.equal("10.0.9.1" > "10.0.10.1", true, "positive control: the plain string compare picks the wrong one");
});

test("a box that did not answer, did not report, or reported the placeholder is UNREAD, never a build", () => {
  const spread = buildSpread(fleet({ 2: NEW, 3: NEW, 4: "down", 5: null, 6: "unknown" }));
  assert.equal(spread.mixed, false, "the placeholder is no build, so it is not a second one");
  assert.deepEqual(spread.read, [nameOf(2), nameOf(3)]);
  assert.deepEqual(spread.unread, [nameOf(4), nameOf(5), nameOf(6)]);
});

test("a reachable box that carries no environment is UNREAD, and only that box is (the others still read)", () => {
  const spread = buildSpread(fleet({ ...on(NEW, 2, 14), 16: "no-environment" }));
  assert.equal(spread.mixed, false);
  assert.deepEqual(spread.unread, [nameOf(16)]);
  assert.equal(spread.read.length, 14, "positive control: the fourteen that reported a build are read");
});

test("a status with no `windowsBuilds` claims nothing read, and still shows a mix from the drift (absence is never agreement)", () => {
  const legacyAgreeing: BuildStatus = { ...oneBuild, windowsBuilds: undefined };
  const agreeing = buildSpread(legacyAgreeing);
  assert.equal(agreeing.read.length, 0, "no field and no drift entry: nothing says anybody agreed");
  assert.equal(agreeing.unread.length, 15);
  const legacyMixed: BuildStatus = { ...rulingMap, windowsBuilds: undefined };
  assert.equal(buildSpread(legacyMixed).mixed, true, "NEGATIVE CONTROL: the drift alone still names a mix");
});

test("two boxes on different builds are mixed whatever the rest did, so filing needs no completeness", () => {
  const spread = buildSpread(fleet({ 2: OLD, 3: NEW, 4: "down", 5: "unknown" }));
  assert.equal(spread.mixed, true);
  assert.deepEqual(spread.laggards, [{ box: nameOf(2), build: OLD }]);
  assert.deepEqual(spread.unread, [nameOf(4), nameOf(5)]);
});

/** A `gh` seam holding the open issues, recording every effect. */
function seam(open: OpenIncident[] = []) {
  const effects: string[] = [];
  const filed: { title: string, body: string, labels: string[] }[] = [];
  const closed: { issue: number, reason: string, comment: string }[] = [];
  const deps: IncidentDeps = {
    now: () => Date.parse("2026-10-11T17:00:00Z"),
    listOpen: () => open,
    file: (draft) => { filed.push(draft); effects.push("file"); return "https://github.com/a11ign/a11ign/issues/9001"; },
    close: (issue, how) => { closed.push({ issue, ...how }); effects.push(`close #${issue}`); },
  };
  return { deps, effects, filed, closed };
}

const incident = (number: number): OpenIncident => ({ number, createdAt: "2026-10-11T12:00:00Z", target: NEW, laggards: [] });

test("mixed and none open: files ONE incident carrying the contract (title, labels, the line on its own, every laggard)", () => {
  const { deps, filed, closed } = seam();
  const result = reconcileIncident(buildSpread(rulingMap), deps);
  assert.equal(filed.length, 1);
  assert.equal(closed.length, 0);
  assert.equal(result.filed, "https://github.com/a11ign/a11ign/issues/9001");
  const [{ title, body, labels }] = filed;
  assert.equal(title, `Mixed Windows build across the fleet: 12 boxes behind ${NEW}`);
  assert.deepEqual(labels, ["incident", "lane:orchestrator", "ready", "priority", "out-of-release"]);
  assert.ok(body.split("\n").includes(FLEET_BUILD_INCIDENT_LINE), "the line is on a line of its own");
  assert.equal(FLEET_BUILD_INCIDENT_LINE, "Incident: incident:fleet-build-mixed");
  for (const { box, build } of buildSpread(rulingMap).laggards) assert.match(body, new RegExp(`^- ${box}: ${build.replaceAll(".", "\\.")}$`, "m"));
  assert.match(body, new RegExp(`^Target: ${NEW.replaceAll(".", "\\.")}$`, "m"));
  for (const heading of ["## What it is", "## Change", "## Region", "## Acceptance", "## Open-check", "## Done-when", "## Tier", "## Fleet"]) {
    assert.ok(body.includes(heading), `the body is a row in the template: ${heading}`);
  }
  assert.match(body, /^Yes\./m, "Fleet: Yes");
});

test("one build and none open files nothing (NEGATIVE CONTROL for the filing above)", () => {
  const { deps, effects } = seam();
  assert.deepEqual(reconcileIncident(buildSpread(oneBuild), deps), { filed: null, closed: [], heldOpen: null });
  assert.deepEqual(effects, []);
});

test("mixed with an open incident files nothing and says nothing: no comment per tick", () => {
  const { deps, effects } = seam([incident(5100)]);
  assert.deepEqual(reconcileIncident(buildSpread(rulingMap), deps), { filed: null, closed: [], heldOpen: null });
  assert.deepEqual(effects, [], "no file, no close, and no comment: `IncidentDeps` has no comment effect to call");
});

test("two open incidents (a race between two ticks): the NEWER is closed as a duplicate of the older, and nothing is filed", () => {
  const { deps, closed, filed } = seam([incident(5100), incident(5101)]);
  const result = reconcileIncident(buildSpread(rulingMap), deps);
  assert.deepEqual(result.closed, [5101]);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].issue, 5101);
  assert.equal(closed[0].reason, "not planned");
  assert.match(closed[0].comment, /Duplicate of #5100/);
  assert.equal(filed.length, 0);
});

test("one build with a box UNREAD leaves the incident open and names the box; the same fleet fully read closes it", () => {
  const unread = seam([incident(5100)]);
  const held = reconcileIncident(buildSpread(fleet({ ...on(NEW, 2, 14), 16: "down" })), unread.deps);
  assert.deepEqual(unread.effects, [], "a subset is not the fleet");
  assert.deepEqual(held.heldOpen, { issue: 5100, unread: [nameOf(16)] });

  const read = seam([incident(5100)]);
  const closed = reconcileIncident(buildSpread(oneBuild), read.deps);
  assert.deepEqual(closed.closed, [5100]);
  assert.equal(read.closed[0].reason, "completed");
  assert.match(read.closed[0].comment, /reads one Windows build/);
  assert.match(read.closed[0].comment, /15 boxes read/);
});

test("a fleet where EVERY box reports the same placeholder is not read: the open incident stays open (a11ign#5106)", () => {
  // The case a11ign#5026 pinned as a known limit: a fleet-wide restart before the first sample leaves every box on
  // `unknown`, `fleetConsistency` names no `windowsBuild` value for a fleet that agrees, and the incident closed. The
  // build now comes from `windowsBuilds`, so the placeholder is unread whether or not the boxes agree.
  const placeholder = fleet(on("unknown", 2, 4));
  assert.deepEqual(windowsBuildDrift(placeholder), [], "premise: the drift has no `windowsBuild` entry for this fleet, which is what hid it");
  const spread = buildSpread(placeholder);
  assert.equal(spread.mixed, false);
  assert.equal(spread.target, null);
  assert.deepEqual(spread.read, []);
  assert.equal(spread.unread.length, 4);
  const { deps, effects } = seam([incident(5100)]);
  const outcome = reconcileIncident(spread, deps);
  assert.deepEqual(effects, [], "nothing is closed");
  assert.deepEqual(outcome.heldOpen?.unread, spread.unread, "and it is said to be held open, naming the boxes");
});

test("the same four boxes on ONE real build are read and close the incident (POSITIVE CONTROL for the placeholder fleet above)", () => {
  const { deps, effects } = seam([incident(5100)]);
  const outcome = reconcileIncident(buildSpread(fleet(on(NEW, 2, 4))), deps);
  assert.deepEqual(effects, ["close #5100"]);
  assert.deepEqual(outcome.closed, [5100]);
});

test("a failing `gh` is CANNOT_ASK in the tick and never a clean reading, whichever call failed", () => {
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const listing = { ...seam().deps, listOpen: () => { throw new Error("gh: HTTP 502"); } };
    const filing = { ...seam().deps, file: () => { throw new Error("gh: HTTP 422 label does not exist"); } };
    assert.match(fleetBuildIncidentTick(rulingMap, listing).cannotAsk ?? "", /502/);
    assert.match(fleetBuildIncidentTick(rulingMap, filing).cannotAsk ?? "", /422/);
    const fine = fleetBuildIncidentTick(oneBuild, seam().deps);
    assert.deepEqual(fine, { fresh: [], closed: [], cannotAsk: null }, "positive control: a gh that works asks without a complaint");
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 2, "each failure is SAID on stderr");
});

test("a newly filed incident is a fresh line for the #928 post", () => {
  const tick = fleetBuildIncidentTick(rulingMap, seam().deps);
  assert.equal(tick.fresh.length, 1);
  assert.match(tick.fresh[0], /issues\/9001/);
  assert.match(tick.fresh[0], /incident:fleet-build-mixed/);
});

type Call = string[];

/** A fake `gh`: records argv and plays a tiny issue store, so the real argv shapes are what the seam sees. */
function fakeGh(initial: { number: number, createdAt: string, body: string }[] = []) {
  const calls: Call[] = [];
  const issues = [...initial];
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[1] === "list") return JSON.stringify(issues);
    if (args[1] === "create") {
      issues.push({ number: 5200 + issues.length, createdAt: "2026-10-11T17:00:00Z", body: args[args.indexOf("--body") + 1] });
      return `https://github.com/a11ign/a11ign/issues/${5200 + issues.length - 1}\n`;
    }
    return "";
  };
  return { gh, calls, issues };
}

test("the real argv: the list is a LABEL list and not a search, create carries every label, close carries reason and comment", () => {
  const { gh, calls } = fakeGh();
  const deps = ghIncidentDeps(gh);
  deps.listOpen();
  const url = deps.file({ title: "T", body: "B", labels: FLEET_BUILD_INCIDENT_LABELS });
  deps.close(5100, { reason: "completed", comment: "done" });
  const [list, create, close] = calls;
  assert.deepEqual(list.slice(0, 2), ["issue", "list"]);
  assert.ok(list.includes("--label") && list.includes("incident") && !list.includes("--search"), "search lags a second behind a filing and would file twice");
  assert.ok(list.includes(FLEET_BUILD_INCIDENT_REPO) && create.includes(FLEET_BUILD_INCIDENT_REPO) && close.includes(FLEET_BUILD_INCIDENT_REPO));
  const labelsGiven = create.flatMap((arg, i) => (arg === "--label" ? [create[i + 1]] : []));
  assert.deepEqual(labelsGiven, ["incident", "lane:orchestrator", "ready", "priority", "out-of-release"]);
  assert.equal(url, "https://github.com/a11ign/a11ign/issues/5200");
  assert.deepEqual(close.slice(0, 3), ["issue", "close", "5100"]);
  assert.ok(close.includes("--reason") && close.includes("completed") && close.includes("--comment") && close.includes("done"));
});

test("round trip through the store: what is filed is read back as the incident, with its target and laggards", () => {
  const { gh, issues } = fakeGh();
  const deps = ghIncidentDeps(gh);
  reconcileIncident(buildSpread(rulingMap), { ...deps, now: () => Date.parse("2026-10-11T17:00:00Z") });
  assert.equal(issues.length, 1);
  const read = openFleetBuildIncident(deps);
  assert.equal(read?.number, 5200);
  assert.equal(read?.target, NEW);
  assert.deepEqual(read?.laggards, buildSpread(rulingMap).laggards);
  assert.equal(read?.createdAt, "2026-10-11T17:00:00Z");
  // The next tick over the same fleet files nothing more: the filed issue is what the list now finds.
  const second = reconcileIncident(buildSpread(rulingMap), deps);
  assert.equal(second.filed, null);
  assert.equal(issues.length, 1);
});

test("only a body with the line on a line of its own is the incident: the id quoted inline, or in another row's Acceptance, is not", () => {
  const spread = buildSpread(rulingMap);
  const body = incidentBody(spread, "2026-10-11T17:00:00Z");
  assert.ok(parseIncident({ number: 1, createdAt: "x", body }));
  assert.ok(body.includes("incident:fleet-build-mixed", body.indexOf("## Acceptance")), "positive control: this body quotes the id in its own Acceptance");
  const withoutLine = body.split("\n").filter((line) => line !== FLEET_BUILD_INCIDENT_LINE).join("\n");
  assert.equal(parseIncident({ number: 1, createdAt: "x", body: withoutLine }), null, "the Acceptance's quotation of the id does not make a row an incident");
  assert.equal(parseIncident({ number: 2, createdAt: "x", body: `see ${FLEET_BUILD_INCIDENT_LINE} for the stop` }), null);
});

test("the OLDER incident stands by creation time, not by issue number: a lower number made later is the duplicate", () => {
  const issue = (number: number, createdAt: string) => ({ number, createdAt, body: incidentBody(buildSpread(rulingMap), "t") });
  // #5100 was transferred in after #5101 was filed, so the lower number is the NEWER incident.
  const store = [issue(5100, "2026-10-11T15:00:00Z"), issue(5101, "2026-10-11T09:00:00Z")];
  assert.equal(openFleetBuildIncident(ghIncidentDeps(fakeGh(store).gh))?.number, 5101);

  const { gh, calls } = fakeGh(store);
  const result = reconcileIncident(buildSpread(rulingMap), ghIncidentDeps(gh));
  assert.deepEqual(result.closed, [5100], "the newer by time is closed, whatever its number");
  const closes = calls.filter((args) => args[1] === "close");
  assert.deepEqual(closes.map((args) => args[2]), ["5100"]);
  assert.match(closes[0][closes[0].indexOf("--comment") + 1], /Duplicate of #5101/);
});

test("creation ties fall to the issue number, and a createdAt that does not parse sorts last", () => {
  const issue = (number: number, createdAt: string) => ({ number, createdAt, body: incidentBody(buildSpread(rulingMap), "t") });
  const tied = [issue(5103, "2026-10-11T12:00:00Z"), issue(5102, "2026-10-11T12:00:00Z")];
  assert.equal(openFleetBuildIncident(ghIncidentDeps(fakeGh(tied).gh))?.number, 5102);
  const undated = [issue(5100, "not a date"), issue(5104, "2026-10-11T12:00:00Z")];
  assert.equal(openFleetBuildIncident(ghIncidentDeps(fakeGh(undated).gh))?.number, 5104);
});

test("openFleetBuildIncident: the oldest of two, null for none, and a THROW (not null) for a gh that cannot be asked", () => {
  const issue = (number: number) => ({ number, createdAt: "2026-10-11T12:00:00Z", body: incidentBody(buildSpread(rulingMap), "t") });
  assert.equal(openFleetBuildIncident(ghIncidentDeps(fakeGh([issue(5101), issue(5100)]).gh))?.number, 5100);
  assert.equal(openFleetBuildIncident(ghIncidentDeps(fakeGh().gh)), null);
  assert.throws(() => openFleetBuildIncident(ghIncidentDeps(() => { throw new Error("gh: not logged in"); })), /not logged in/);
});

test("a dry run reads and says, and files and closes nothing", () => {
  const said: string[] = [];
  const { gh, calls } = fakeGh();
  const deps = readOnlyIncidentDeps(ghIncidentDeps(gh), (line) => said.push(line));
  const result = reconcileIncident(buildSpread(rulingMap), deps);
  assert.deepEqual(calls.map((call) => call[1]), ["list"], "only the read reached gh");
  assert.match(said[0], /WOULD FILE: Mixed Windows build across the fleet: 12 boxes behind/);
  assert.match(result.filed ?? "", /dry run/);
});

test("the title counts the laggards, not the fleet", () => {
  assert.equal(incidentTitle(buildSpread(fleet({ 2: OLD, 3: NEW, 4: NEW }))), `Mixed Windows build across the fleet: 1 boxes behind ${NEW}`);
});
