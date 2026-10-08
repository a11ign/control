// #866: naming a failed unit, its state and its age from `systemctl`'s own output shapes, fixture-tested
// rather than run against a real lab -- exactly what the row's 2026-09-18 amendment asks for.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseUnitList,
  failedUnitNames,
  failureAge,
  unitsFromAnsibleResults,
  describeFailures,
  renderReport,
} from "./lab-failed-units.mjs";

// `systemctl list-units --all --plain --no-legend a11y-job-*` -- the exact shape #866's own open-check
// greps for (`"loaded failed failed"`), plus an active and an inactive unit so a real run's mix is covered.
const LIST_UNITS_OUTPUT = [
  "a11y-job-gate-stability.service loaded failed failed Gate stability",
  "a11y-job-train.service          loaded active running Train",
  "a11y-job-export.service         loaded inactive dead  Export",
  "a11y-job-evidence-check.service loaded failed failed Evidence check",
  "",
].join("\n");

test("parseUnitList reads UNIT LOAD ACTIVE SUB off systemctl's own columns", () => {
  const rows = parseUnitList(LIST_UNITS_OUTPUT);
  assert.deepEqual(rows, [
    { unit: "a11y-job-gate-stability.service", load: "loaded", active: "failed", sub: "failed" },
    { unit: "a11y-job-train.service", load: "loaded", active: "active", sub: "running" },
    { unit: "a11y-job-export.service", load: "loaded", active: "inactive", sub: "dead" },
    { unit: "a11y-job-evidence-check.service", load: "loaded", active: "failed", sub: "failed" },
  ]);
});

test("parseUnitList against an empty lab (nothing has ever run) finds nothing, not a crash", () => {
  assert.deepEqual(parseUnitList(""), []);
});

test("failedUnitNames keeps only ACTIVE=failed AND SUB=failed, never one alone", () => {
  const rows = parseUnitList(LIST_UNITS_OUTPUT);
  assert.deepEqual(failedUnitNames(rows), [
    "a11y-job-gate-stability.service",
    "a11y-job-evidence-check.service",
  ]);
});

test("failureAge reads systemd's own UTC rendering, unconverted", () => {
  const now = new Date("2026-09-18T16:30:00Z");
  const age = failureAge("Sun 2026-09-06 16:30:00 UTC", now);
  assert.ok(age);
  assert.equal(age.ms, 12 * 86_400_000);
  assert.equal(age.humanized, "12 days");
});

test("failureAge is null for n/a, empty, and an unparseable stamp -- never zero", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  assert.equal(failureAge("n/a", now), null);
  assert.equal(failureAge("", now), null);
  assert.equal(failureAge(undefined, now), null);
  assert.equal(failureAge("not a timestamp", now), null);
});

test("failureAge refuses a stamp in the future rather than reporting a negative age", () => {
  const now = new Date("2026-09-06T00:00:00Z");
  assert.equal(failureAge("Fri 2026-09-18 00:00:00 UTC", now), null);
});

test("unitsFromAnsibleResults reads only item/stdout off ansible's loop-result shape", () => {
  const results = [
    { item: "a11y-job-gate-stability.service", stdout: "Sun 2026-09-06 16:30:00 UTC", rc: 0, cmd: ["systemctl"] },
    { item: "a11y-job-evidence-check.service", stdout: "Sun 2026-09-06 16:20:00 UTC", rc: 0 },
  ];
  assert.deepEqual(unitsFromAnsibleResults(results), [
    { unit: "a11y-job-gate-stability.service", activeEnterTimestamp: "Sun 2026-09-06 16:30:00 UTC" },
    { unit: "a11y-job-evidence-check.service", activeEnterTimestamp: "Sun 2026-09-06 16:20:00 UTC" },
  ]);
});

test("describeFailures is QUIET on an empty population and ATTENTION otherwise, sorted by unit", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  assert.deepEqual(describeFailures([], now), { attention: false, entries: [] });

  const described = describeFailures(
    [
      { unit: "a11y-job-evidence-check.service", activeEnterTimestamp: "Sun 2026-09-06 16:20:00 UTC" },
      { unit: "a11y-job-gate-stability.service", activeEnterTimestamp: "Sun 2026-09-06 16:30:00 UTC" },
    ],
    now,
  );
  assert.equal(described.attention, true);
  // sorted, so the gate-stability unit (alphabetically first) leads regardless of input order
  assert.deepEqual(described.entries.map((e) => e.unit), [
    "a11y-job-evidence-check.service",
    "a11y-job-gate-stability.service",
  ]);
  assert.match(described.entries[0].ageDescription, /ago$/);
});

test("describeFailures names an unreadable timestamp rather than a fabricated age", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  const described = describeFailures([{ unit: "a11y-job-x.service", activeEnterTimestamp: "n/a" }], now);
  assert.equal(described.entries[0].ageDescription, "an unreadable or unknown time");
});

test("renderReport names unit, state and age -- #866's own acceptance wording", () => {
  const now = new Date("2026-09-18T16:30:00Z");
  const described = describeFailures(
    [{ unit: "a11y-job-gate-stability.service", activeEnterTimestamp: "Sun 2026-09-06 16:30:00 UTC" }],
    now,
  );
  assert.deepEqual(renderReport(described), [
    "a11y-job-gate-stability.service: failed, since 12 days ago",
  ]);
});

test("renderReport says so, explicitly, when nothing is failed", () => {
  assert.deepEqual(renderReport({ attention: false, entries: [] }), [
    "no a11y-job-* unit is in a failed state",
  ]);
});
