/**
 * THE DRIFT RECORD A JOB IS HELD TO (A11-244): what it names, and that a record nobody can read is never read as "no box differs".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftUnreadable, driftFrom, driftReader } from "./drift.ts";

const RECORD = { differences: [
  { box: "a11y-worker-5", field: "edge", has: "155", wants: "156", carried: false },
  { box: "a11y-worker-5", field: "nvda", has: "2026.1", wants: "2026.2", carried: false },
  { box: "a11y-worker-9", field: "edge", has: "155", wants: "156", carried: true },
] };

function record(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-drift-"));
  return { path: join(dir, "fleet-drift.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a current difference names its box and field; a carried one (the box did not answer) names nothing", () => {
  assert.deepEqual(driftFrom(JSON.stringify(RECORD)), {
    "a11y-worker-5": "off the manifest: edge is 155, the manifest wants 156; nvda is 2026.1, the manifest wants 2026.2" });
  assert.deepEqual(driftFrom(JSON.stringify({ differences: [] })), {});
});

test("a record that is not JSON, or has no list of differences, or a difference with no box, is unreadable, not empty", () => {
  for (const text of ["{ not json", "null", "[]", JSON.stringify({}), JSON.stringify({ differences: "none" }), JSON.stringify({ differences: [{ field: "edge" }] })]) {
    assert.throws(() => driftFrom(text), DriftUnreadable, text);
  }
});

test("a record that does not exist is a control plane whose hourly check has not run: no difference is known", () => {
  const t = record();
  assert.deepEqual(driftReader(t.path)(), {});
  t.done();
});

test("a record on disk that cannot be read throws, and is read again once it is fixed", () => {
  const t = record();
  const read = driftReader(t.path);
  writeFileSync(t.path, "{ not json");
  assert.throws(read, DriftUnreadable);
  assert.throws(read, DriftUnreadable, "and again: an unreadable record is not remembered as an empty one");
  writeFileSync(t.path, JSON.stringify(RECORD));
  assert.deepEqual(Object.keys(read()), ["a11y-worker-5"]);
  t.done();
});

test("a path that is a directory is unreadable, not empty", () => {
  const t = record();
  assert.throws(driftReader(join(t.path, "..")), DriftUnreadable);
  t.done();
});

test("the record is read again only when its mtime moves", () => {
  const t = record();
  writeFileSync(t.path, JSON.stringify(RECORD));
  const read = driftReader(t.path);
  assert.deepEqual(Object.keys(read()), ["a11y-worker-5"]);
  writeFileSync(t.path, JSON.stringify({ differences: [] }));
  utimesSync(t.path, new Date(0), new Date(0));
  utimesSync(t.path, new Date(1000), new Date(1000));
  assert.deepEqual(read(), {});
  t.done();
});

test("a carried difference of a box the check SKIPPED under a lease still counts: it was reachable, so it is not offered to a job in the hour after", () => {
  const record = { differences: RECORD.differences, skipped: { "a11y-worker-9": "under maintenance by fleet-freeze:run" } };
  assert.deepEqual(Object.keys(driftFrom(JSON.stringify(record))).sort(), ["a11y-worker-5", "a11y-worker-9"]);
  assert.deepEqual(Object.keys(driftFrom(JSON.stringify(RECORD))), ["a11y-worker-5"], "control: without `skipped` the same carried difference names nothing");
});
