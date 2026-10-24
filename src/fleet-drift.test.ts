/**
 * A11-205: `fleet:drift`, the hourly read of every box against `deploy-pins.json`, and the record the announcement is made from.
 *
 * Every test drives the real `readFleetDrift` / `driftRecordOf` over invented probes: nothing reaches a box. Each failing case has a negative control
 * (a fleet on the manifest passes) so "fails" is not what an empty or broken reading would print anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFleetDrift, driftRecordOf, driftExitCode, DRIFT_EXIT, driftLines, driftingBoxes, parseDriftRecord, parseFreezeRun, writeDriftRecord,
  FLEET_DRIFT_PATH, FREEZE_RUN_PATH } from "./fleet-drift.ts";
import type { DriftRecord, FreezeRun } from "./fleet-drift.ts";
import type { WorkerProbe } from "./fleet-status.ts";

const EXPECTED = { Windows: "26300.9711", Edge: "156.0.4314.42", NVDA: "2026.1.1", "Worker code": "47dcd71db00697b3" };
const ON_MANIFEST = { windows: "26300.9711", edge: "156.0.4314.42", nvda: "2026.1.1", code: "47dcd71db00697b3" };
type Reading = Partial<typeof ON_MANIFEST>;
const NOW = new Date("2026-10-25T10:00:00.000Z");
const LATER = new Date("2026-10-25T11:00:00.000Z");

const boxName = (n: number) => `a11y-worker-${n}`;
const workerOf = (n: number) => ({ name: boxName(n), url: `http://192.0.2.${n}:8765` });

/** A reachable probe whose `/health` carries exactly the readings given; a key left out is a field the box did not report. */
function answering(n: number, box: Reading = {}, ...omit: (keyof Reading)[]): WorkerProbe {
  const reading = { ...ON_MANIFEST, ...box };
  for (const key of omit) delete reading[key];
  const environment: Record<string, unknown> = {};
  if (reading.edge !== undefined) environment.browserVersion = reading.edge;
  if (reading.nvda !== undefined) environment.screenReaderVersion = reading.nvda;
  if (reading.windows !== undefined) environment.windowsBuild = reading.windows;
  return { ...workerOf(n), reachable: true, health: { ok: true, ready: true, busy: false, ...(reading.code === undefined ? {} : { code: reading.code }), environment } };
}
const silent = (n: number): WorkerProbe => ({ ...workerOf(n), reachable: false, error: "ETIMEDOUT" });

async function read(probes: WorkerProbe[], expected: () => typeof EXPECTED = () => EXPECTED) {
  return readFleetDrift({ workers: () => probes.map(({ name, url }) => ({ name, url })),
    probe: async (worker) => probes.find((probe) => probe.name === worker.name) as WorkerProbe, expected });
}
async function recordOf(probes: WorkerProbe[], { previous = null, freeze = null, now = NOW }: { previous?: DriftRecord | null; freeze?: FreezeRun | null; now?: Date } = {}) {
  return driftRecordOf({ ...await read(probes), previous, freeze, now });
}

test("a fleet on the manifest has no difference, is exit 0, and says so (the negative control for every case below)", async () => {
  const record = await recordOf([answering(2), answering(3), answering(4)]);
  assert.deepEqual(record.differences, []);
  assert.equal(record.firstSeenAt, null);
  assert.equal(record.reachable, 3);
  assert.equal(driftExitCode(record), 0);
  assert.deepEqual(driftLines(record),
    ["fleet on the manifest — Windows: 26300.9711; Edge: 156.0.4314.42; NVDA: 2026.1.1; Worker code: 47dcd71db00697b3; all 3 boxes that answered"]);
});

// One case per kind of difference. In each, ONE box differs and the others sit on the manifest.
const KINDS: { kind: string; field: string; box: Reading; has: string; wants: string; }[] = [
  { kind: "Windows build", field: "Windows", box: { windows: "22631.6199" }, has: "22631.6199", wants: "26300.9711" },
  { kind: "Edge", field: "Edge", box: { edge: "157.0.1.1" }, has: "157.0.1.1", wants: "156.0.4314.42" },
  { kind: "NVDA", field: "NVDA", box: { nvda: "2025.3" }, has: "2025.3", wants: "2026.1.1" },
  { kind: "worker code", field: "Worker code", box: { code: "25bb45d9b38d7a62" }, has: "25bb45d9b38d7a62", wants: "47dcd71db00697b3" },
];
for (const { kind, field, box, has, wants } of KINDS) {
  test(`one box off the manifest on ${kind} fails with exit 3, naming the box, the field, what it has and what the manifest wants`, async () => {
    const record = await recordOf([answering(2), answering(3), answering(5, box)]);
    assert.deepEqual(record.differences, [{ box: boxName(5), field, has, wants, carried: false }]);
    assert.deepEqual(driftLines(record), [`fleet OFF THE MANIFEST — a11y-worker-5 ${field} has ${has}, the manifest wants ${wants}`]);
    assert.equal(record.firstSeenAt, NOW.toISOString());
    assert.equal(driftExitCode(record), 3);
  });
}

test("a reachable box that reports no value for a field differs (has: null): a field nobody reported is not agreement", async () => {
  const record = await recordOf([answering(2), { ...answering(3, {}, "code", "nvda") }]);
  assert.deepEqual(record.differences.map(({ box, field, has }) => [box, field, has]), [[boxName(3), "NVDA", null], [boxName(3), "Worker code", null]]);
  assert.match(driftLines(record)[0], /a11y-worker-3 NVDA unreported, the manifest wants 2026\.1\.1/);
  assert.equal(driftExitCode(record), 3);
});

test("a fleet that agrees with itself but not with the manifest fails: this is what comparing boxes with each other cannot see", async () => {
  const record = await recordOf([2, 3, 4].map((n) => answering(n, { edge: "155.0.4283.62" })));
  assert.deepEqual(record.differences.map(({ box, field }) => `${box} ${field}`), ["a11y-worker-2 Edge", "a11y-worker-3 Edge", "a11y-worker-4 Edge"]);
  assert.equal(driftExitCode(record), 3);
});

test("an unreachable box is unread, not a difference: it is named, and the rest still pass", async () => {
  const record = await recordOf([answering(2), silent(9), answering(3)]);
  assert.deepEqual(record.differences, []);
  assert.deepEqual(record.unreachable, [boxName(9)]);
  assert.equal(record.reachable, 2);
  assert.equal(record.total, 3);
  assert.equal(driftExitCode(record), 0);
  assert.match(driftLines(record).join("\n"), /not read \(unreachable, not a difference\): a11y-worker-9/);
});

test("nothing answering is exit 4, not 3 and not 0: no box was compared; and 4 is not 1, which Node returns for a script it cannot load", async () => {
  const record = await recordOf([silent(2), silent(3)]);
  assert.equal(driftExitCode(record), 4);
  assert.deepEqual(DRIFT_EXIT, { ON_MANIFEST: 0, DIFFERS: 3, NOTHING_ANSWERED: 4 });
  const unit = readFileSync(new URL("../ansible/files/a11y-fleet-drift.service", import.meta.url), "utf8");
  assert.match(unit, /^SuccessExitStatus=4$/m, "the hourly unit excuses a fleet asleep, and only that");
  assert.doesNotMatch(unit, /^SuccessExitStatus=.*\b[123]\b/m, "neither a difference (3) nor Node's own failure (1) is excused");
  assert.match(driftLines(record).join("\n"), /no box answered: nothing was compared/);
});

test("an unreadable manifest is exit 3 even when no box answered: a broken manifest must not read as a quiet night", async () => {
  const none = driftRecordOf({ ...await read([silent(2)], () => { throw new Error("deploy-pins.json declares no `windows`"); }), previous: null, freeze: null, now: NOW });
  assert.equal(none.reachable, 0);
  assert.equal(driftExitCode(none), 3);
});

test("a manifest that cannot be read FAILS the reading with its reason, because a check with no expectation passes every box", async () => {
  const record = await recordOf([answering(2)]);
  assert.equal(driftExitCode(record), 0, "premise: the same fleet passes when the manifest reads");
  const unreadable = driftRecordOf({ ...await read([answering(2)], () => { throw new Error("deploy-pins.json declares no `windows`"); }),
    previous: null, freeze: null, now: NOW });
  assert.match(unreadable.unreadable ?? "", /declares no `windows`/);
  assert.equal(unreadable.expected, null);
  assert.equal(unreadable.firstSeenAt, NOW.toISOString());
  assert.equal(driftExitCode(unreadable), 3);
  assert.match(driftLines(unreadable)[0], /^fleet OFF THE MANIFEST — cannot compare 1 reachable box\(es\): deploy-pins\.json declares no `windows`/);
});

// --- the record --------------------------------------------------------------------------------------------------------------------------

test("the record's shape: names and versions only, the fields the announcement reads, and no address", async () => {
  const record = await recordOf([answering(2), answering(5, { edge: "157.0.1.1" }), silent(9)]);
  assert.deepEqual(Object.keys(record).sort(), ["checkedAt", "differences", "expected", "firstSeenAt", "freeze", "reachable", "total", "unreachable", "unreadable"]);
  assert.deepEqual(record.expected, EXPECTED);
  assert.equal(record.checkedAt, NOW.toISOString());
  assert.deepEqual(Object.keys(record.differences[0]).sort(), ["box", "carried", "field", "has", "wants"]);
  assert.doesNotMatch(JSON.stringify(record), /192\.0\.2|http:/, "an inventory name, never an address");
});

test("firstSeenAt is when the run of differences BEGAN: the next hour keeps it, a clean hour clears it, a new run starts again", async () => {
  const first = await recordOf([answering(2), answering(5, { edge: "157.0.1.1" })]);
  const second = await recordOf([answering(2), answering(5, { edge: "157.0.1.1" })], { previous: first, now: LATER });
  assert.equal(second.firstSeenAt, NOW.toISOString(), "the hold-down counts from the first sighting, not from the latest hour");
  assert.equal(second.checkedAt, LATER.toISOString());
  const clean = await recordOf([answering(2), answering(5)], { previous: second, now: new Date("2026-10-25T12:00:00.000Z") });
  assert.equal(clean.firstSeenAt, null);
  const again = await recordOf([answering(2), answering(5, { edge: "157.0.1.1" })], { previous: clean, now: new Date("2026-10-25T13:00:00.000Z") });
  assert.equal(again.firstSeenAt, "2026-10-25T13:00:00.000Z", "after a clean hour a new difference is a new run");
});

test("a box that differed and now does not answer keeps its last difference, marked carried: asleep is not back on the manifest", async () => {
  const first = await recordOf([answering(2), answering(5, { edge: "157.0.1.1" })]);
  const asleep = await recordOf([answering(2), silent(5)], { previous: first, now: LATER });
  assert.deepEqual(asleep.differences, [{ box: boxName(5), field: "Edge", has: "157.0.1.1", wants: "156.0.4314.42", carried: true }]);
  assert.equal(asleep.firstSeenAt, NOW.toISOString());
  assert.equal(driftExitCode(asleep), 3);
  assert.match(driftLines(asleep)[0], /\(last read; the box did not answer this time\)$/);
  // and the box, answering again on the manifest, clears it
  const back = await recordOf([answering(2), answering(5)], { previous: asleep, now: new Date("2026-10-25T12:00:00.000Z") });
  assert.deepEqual(back.differences, []);
  // negative control: a box that was never off the manifest carries nothing when it sleeps
  const never = await recordOf([answering(2), silent(5)], { previous: await recordOf([answering(2), answering(5)]), now: LATER });
  assert.deepEqual(never.differences, []);
});

test("a carried difference is dropped when the manifest has moved: it was a fact about the old manifest", async () => {
  const first = await recordOf([answering(5, { edge: "157.0.1.1" })]);
  const moved = driftRecordOf({ ...await read([silent(5)], () => ({ ...EXPECTED, Edge: "157.0.1.1" })), previous: first, freeze: null, now: LATER });
  assert.deepEqual(moved.differences, []);
});

test("the daily freeze's last run is carried into the record: what it put back, who it did not reach, who did not hold", async () => {
  const freeze = parseFreezeRun(JSON.stringify({ checkedAt: "2026-10-25T04:11:07Z", scope: "the fleet", frozen: ["a11y-worker-2"],
    putBack: { "a11y-worker-3": ["Windows Update service", "edgeupdate task"] }, unreachable: ["a11y-worker-9"], failed: ["a11y-worker-4"] }));
  assert.ok(freeze);
  const record = await recordOf([answering(2)], { freeze });
  assert.deepEqual(record.freeze, { checkedAt: "2026-10-25T04:11:07Z", scope: "the fleet",
    putBack: { "a11y-worker-3": ["Windows Update service", "edgeupdate task"] }, unreachable: ["a11y-worker-9"], failed: ["a11y-worker-4"] });
  const lines = driftLines(record);
  assert.ok(lines.includes("the freeze put back, at 2026-10-25T04:11:07Z: a11y-worker-3 (Windows Update service, edgeupdate task)"));
  assert.ok(lines.includes("the freeze did not reach, at 2026-10-25T04:11:07Z: a11y-worker-9"));
  assert.ok(lines.includes("the freeze did not hold on, at 2026-10-25T04:11:07Z: a11y-worker-4"));
  assert.equal(driftExitCode(record), 0, "a freeze line is carried for the record; only a difference from the manifest fails the check");
});

test("a freeze record that is missing or malformed is no freeze lines, not a crash; and the paths are the two files the plays write", () => {
  assert.equal(parseFreezeRun(null), null);
  assert.equal(parseFreezeRun("{not json"), null);
  assert.equal(parseFreezeRun("[]"), null);
  assert.equal(parseFreezeRun(JSON.stringify({ putBack: {} })), null, "no checkedAt, so it cannot be dated");
  assert.equal(FREEZE_RUN_PATH, "runs/fleet-freeze-last-run.json");
  assert.equal(FLEET_DRIFT_PATH, "runs/fleet-drift.json");
});

test("a record written to disk reads back as the record, and a half-written or foreign file reads as no previous record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-drift-"));
  const path = join(dir, "runs", "fleet-drift.json");
  const record = await recordOf([answering(2), answering(5, { windows: "22631.6199" }), silent(9)]);
  writeDriftRecord(path, record);
  assert.deepEqual(parseDriftRecord(readFileSync(path, "utf8")), record);
  assert.equal(parseDriftRecord(null), null);
  assert.equal(parseDriftRecord("{\"checkedAt\": "), null);
  assert.equal(parseDriftRecord(JSON.stringify({ hello: "world" })), null);
});

// --- use at dispatch -----------------------------------------------------------------------------------------------------------------------

test("driftingBoxes names the boxes that differ, once each, and none when the pool is on the manifest", async () => {
  const probes = [answering(2), answering(5, { edge: "157.0.1.1", nvda: "2025.3" }), answering(6)];
  const asked = (pool: WorkerProbe[]) => driftingBoxes(pool.map(({ name, url }) => ({ name, url })),
    { probe: async (worker) => probes.find((probe) => probe.name === worker.name) as WorkerProbe, expected: () => EXPECTED });
  assert.deepEqual(await asked(probes), { drifting: [boxName(5)] });
  assert.deepEqual(await asked([probes[0], probes[2]]), { drifting: [] }, "negative control: a pool without the box has nothing to leave out");
});

test("driftingBoxes cannot ask when the manifest cannot be read: it must not answer `nothing drifts`", async () => {
  const probes = [answering(2)];
  const answer = await driftingBoxes(probes.map(({ name, url }) => ({ name, url })),
    { probe: async () => probes[0], expected: () => { throw new Error("pnpm install --frozen-lockfile"); } });
  assert.deepEqual(answer, { cannotAsk: "pnpm install --frozen-lockfile" });
});
