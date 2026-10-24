/**
 * THE FLEET IS READ ON ONE EDGE VERSION, AND THE VERSION IS THE PIN (a11ign/a11ign#5660, precondition 2 of the announcement-emulator spike).
 *
 * On 2026-10-10 the fleet was split 12/3 across two Edge builds, and an oracle that runs on two Edge versions measures noise. `browserVersion`
 * is MUST_MATCH, so a capture REFUSES a fleet whose boxes differ from each other -- but that is the gate, raised DURING the capture. Nothing
 * raised it before capture day: the off-fleet watch read Windows build, display mode and the Edge updater, and not the Edge version. And a gate
 * that compares boxes to EACH OTHER cannot see a fleet that agrees on the wrong build: the pin (`edge.version` in `deploy-pins.json`) is a different question.
 *
 * So the reading compares each box's OWN reported `browserVersion` to the pin, and a box off it is one `edge-pin: <box> <version> (pin <pin>)`
 * line in the watch's ledger. #4405's convergence step owns the Windows build, the display mode and the Edge UPDATER; the Edge VERSION is this row's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fleetStatus } from "../fleet-status.ts";
import { edgePinLines, offFleetLines, readEdgePin, watchFleet } from "../fleet-watch.ts";

const PIN = "155.0.4283.45";
const NEWER = "155.0.4283.60";
const OLDER = "152.0.4191.66";

type Reports = Record<number, string | undefined>;
const nameOf = (n: number) => `a11y-worker-${n}`;
const urlOf = (n: number) => `http://${nameOf(n)}:8765`;

/** The REAL `fleetStatus` over boxes that each report the version they are given, so `browserVersions` is what the status computed and not a fixture. */
const statusOf = (reports: Reports, unreachable: number[] = []) => {
  const workers = Object.keys(reports).map((n) => ({ name: nameOf(Number(n)), url: urlOf(Number(n)) }));
  return fleetStatus({
    workers: () => workers,
    probe: async (worker) => {
      const n = Number(worker.name.replace("a11y-worker-", ""));
      if (unreachable.includes(n)) return { name: worker.name, url: worker.url, reachable: false, error: "ECONNREFUSED" };
      const environment = reports[n] === undefined ? {} : { browserVersion: reports[n] };
      return { name: worker.name, url: worker.url, reachable: true, progress: {},
        health: { ok: true, ready: true, busy: false, environment, code: "abc1234", vitals: { captures: 3, recoveries: 0 } } };
    },
    linkRead: () => new Map(),
    macRead: () => new Map(),
    switchRead: async () => ({ lines: [], tripped: false }) as never,
  });
};

const lines = (found: { line: string }[]) => found.map(({ line }) => line);

test("one box off the pin is reported as that box's name and its version", async () => {
  const status = await statusOf({ 2: PIN, 3: PIN, 4: NEWER, 5: PIN });
  const found = edgePinLines(status, PIN);
  assert.deepEqual(lines(found), [`edge-pin: ${nameOf(4)} ${NEWER} (pin ${PIN})`]);
  assert.equal(found[0].box, nameOf(4), "the box is named without its address, as the ledger keys workers");
});

test("every box on the pin reads clean (negative control for the case above)", async () => {
  const status = await statusOf({ 2: PIN, 3: PIN, 4: PIN });
  assert.deepEqual(edgePinLines(status, PIN), []);
  assert.deepEqual(offFleetLines(status, PIN), [], "and the watch's whole off-fleet reading is quiet with it");
});

test("each box is named, whichever way it is off: newer, older, and more than one at once", async () => {
  const status = await statusOf({ 2: OLDER, 3: PIN, 4: NEWER });
  assert.deepEqual(lines(edgePinLines(status, PIN)), [`edge-pin: ${nameOf(2)} ${OLDER} (pin ${PIN})`, `edge-pin: ${nameOf(4)} ${NEWER} (pin ${PIN})`]);
});

test("the reading is the box's own report, not the pin file: a fleet that AGREES on the wrong build is still odd", async () => {
  // `fleetConsistency` compares boxes to each other, so every box on one wrong build draws NO `browserVersion` drift entry. The pin is the
  // reference here, and this is the case the gate alone cannot see.
  const status = await statusOf({ 2: NEWER, 3: NEWER, 4: NEWER });
  assert.deepEqual([...status.mismatches, ...status.reportedOnly].filter((drift) => drift.field === "browserVersion"), [],
    "premise: the boxes agree, so there is no drift entry to read the finding from");
  assert.deepEqual(Object.values(status.browserVersions), [NEWER, NEWER, NEWER], "each box's own report reaches the status whether or not they agree");
  assert.equal(edgePinLines(status, PIN).length, 3, "and all three are off the pin");
});

test("the same reports against a different pin read differently: the pin is the argument and the boxes' reports are the data", async () => {
  const status = await statusOf({ 2: PIN, 3: NEWER });
  assert.deepEqual(lines(edgePinLines(status, PIN)), [`edge-pin: ${nameOf(3)} ${NEWER} (pin ${PIN})`]);
  assert.deepEqual(lines(edgePinLines(status, NEWER)), [`edge-pin: ${nameOf(2)} ${PIN} (pin ${NEWER})`],
    "move the pin and the OTHER box is the odd one; no report changed");
});

test("a box that is unreachable, reports nothing or reports the placeholder is no reading, and none of them reads as on the pin or off it", async () => {
  const status = await statusOf({ 2: PIN, 3: undefined, 4: "unknown", 5: NEWER }, [5]);
  assert.deepEqual(edgePinLines(status, PIN), [], "an asleep box is not named: silence is not a version");
  assert.equal(status.browserVersions[urlOf(3)], null, "premise: a box that answered without a version is null");
  assert.deepEqual(edgePinLines({ rows: status.rows }, PIN), [], "a status with no `browserVersions` claims nothing was read");
});

test("offFleetLines draws the Edge-pin line only when it is given the pin", async () => {
  const status = await statusOf({ 2: PIN, 3: NEWER });
  assert.deepEqual(offFleetLines(status), [], "pin not read: no Edge-pin line, and the existing readings are untouched");
  assert.deepEqual(lines(offFleetLines(status, PIN)), [`edge-pin: ${nameOf(3)} ${NEWER} (pin ${PIN})`]);
});

test("readEdgePin reads the manifest's Edge pin, and a manifest that declares none THROWS rather than reading as no finding", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../deploy-pins.json", import.meta.url), "utf8")) as { edge: { version: string } };
  assert.equal(readEdgePin(), manifest.edge.version, "the pin is the manifest's value, parsed independently here");
  const withEdge = (version: string) => JSON.stringify({ ...manifest, edge: { ...manifest.edge, version } });
  assert.equal(readEdgePin(() => withEdge(OLDER)), OLDER, "and it follows the file it is given");
  assert.throws(() => readEdgePin(() => JSON.stringify({ ...manifest, edge: undefined })), /no box can be compared to the Edge pin: deploy-pins\.json declares no `edge`/);
  assert.throws(() => readEdgePin(() => withEdge("latest")), /deploy-pins\.json edge\.version is "latest"/);
});

const memoryStore = () => {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const data = files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  }) as never;
  const write = ((path: string, data: string) => { files.set(path, data); }) as never;
  return { read, write };
};

test("watchFleet raises a box off the pin ONCE, keeps it quiet while it stays off, and clears it when it returns", async () => {
  const { read, write } = memoryStore();
  const tick = async (reports: Reports, at: number, unreachable: number[] = []) => watchFleet({
    getStatus: () => statusOf(reports, unreachable), now: () => at, edgePin: () => PIN, read, write,
    statePath: "state.json", capturesPath: "captures.json", offFleetPath: "off-fleet.json",
  });
  const off = `edge-pin: ${nameOf(4)} ${NEWER} (pin ${PIN})`;
  assert.deepEqual((await tick({ 2: PIN, 3: PIN, 4: NEWER }, 1_000)).offFleet, [off], "raised before any capture, as a fleet-health line");
  assert.deepEqual((await tick({ 2: PIN, 3: PIN, 4: NEWER }, 2_000)).offFleet, [], "the same box on the next tick is not a second post");
  assert.deepEqual((await tick({ 2: PIN, 3: PIN, 4: NEWER }, 3_000, [4])).offFleet, [], "asleep, its entry is carried and not re-raised");
  assert.deepEqual((await tick({ 2: PIN, 3: PIN, 4: PIN }, 4_000)).offFleet, [], "converged: the line clears");
  assert.deepEqual((await tick({ 2: PIN, 3: PIN, 4: NEWER }, 5_000)).offFleet, [off], "and a box that goes off again is a fresh finding");
});
