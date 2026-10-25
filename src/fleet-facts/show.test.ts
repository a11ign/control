/**
 * `fleet facts show`'s TABLE (A11-283): one row per box in the inventory's order, a stale box marked STALE with its last read time, a never-read box said.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { m720qFacts } from "./facts.fixture.ts";
import { COLUMNS, factsRows, readAtOf, renderTable } from "./show.ts";
import type { FactsEntry, FactsFile } from "./types.ts";

const READ = "2026-10-25T09:00:00.000Z";
const good = (over: Partial<FactsEntry> = {}): FactsEntry => ({ readAt: READ, stale: false, lastAttemptAt: READ, lastJob: "fj-1", lastError: null, facts: m720qFacts(), ...over });
const column = (name: (typeof COLUMNS)[number]): number => COLUMNS.indexOf(name);

test("a read box is one row: model and type, serial, BIOS, CPU, RAM, disks, free space, Windows, TPM, Secure Boot and when it was read", () => {
  const file: FactsFile = { version: 1, boxes: { "a11y-worker-2": good() } };
  const [row] = factsRows(file, ["a11y-worker-2"]);
  assert.deepEqual(row, [
    "a11y-worker-2",
    "LENOVO ThinkCentre M720q (10T8)",
    "PF1ABCDE",
    "M1UKT77A 2024-03-14",
    "Intel(R) Core(TM) i5-8500T CPU @ 2.10GHz, 6 c / 6 t",
    "16 GB, 2 × 2666 MT/s",
    "SAMSUNG MZVLB256HBHQ-000L7 NVMe SSD 256 GB",
    "180 / 255 GB",
    "26200.6584 (25H2)",
    "present, ready, spec 2.0, 0, 1.38",
    "enabled",
    READ,
  ]);
});

test("an HP box does not say its make twice, and a box with two disks lists both", () => {
  const facts = { ...m720qFacts(), make: "HP", model: "HP ProDesk 600 G4 DM", machineType: "4KX37EA#ABD", disks: [
    { model: "KXG60ZNV256G TOSHIBA", type: "SSD", bus: "NVMe", sizeBytes: 256_060_514_304 }, { model: "ST500LM034", type: "HDD", bus: "SATA", sizeBytes: 500_107_862_016 }] };
  const [row] = factsRows({ version: 1, boxes: { w: good({ facts }) } }, ["w"]);
  assert.equal(row![column("make / model (type)")], "HP ProDesk 600 G4 DM (4KX37EA#ABD)");
  assert.equal(row![column("disks")], "KXG60ZNV256G TOSHIBA NVMe SSD 256 GB; ST500LM034 SATA HDD 500 GB");
});

test("a stale box is marked STALE with its last read time, its last attempt and why, and still shows its last facts", () => {
  const file: FactsFile = { version: 1, boxes: { "a11y-worker-5": good({ readAt: "2026-10-24T09:00:00.000Z", stale: true, lastAttemptAt: READ, lastError: "a11y-worker-5 did not come up when woken" }) } };
  const [row] = factsRows(file, ["a11y-worker-5"]);
  assert.equal(row![column("read at")], `STALE: last read 2026-10-24T09:00:00.000Z; last attempt ${READ}: a11y-worker-5 did not come up when woken`);
  assert.equal(row![column("serial")], "PF1ABCDE");
});

test("a box in the inventory with no entry reads never read, and a box tried but never answered says why", () => {
  const file: FactsFile = { version: 1, boxes: { b: { readAt: null, stale: true, lastAttemptAt: READ, lastJob: "fj-1", lastError: "unreachable", facts: null } } };
  const [a, b] = factsRows(file, ["a", "b"]);
  assert.equal(a![column("read at")], "never read");
  assert.equal(a![column("serial")], "-");
  assert.equal(b![column("read at")], `never read; last attempt ${READ}: unreachable`);
});

test("rows follow the inventory's order, then any box only the file knows, sorted; --boxes narrows them", () => {
  const file: FactsFile = { version: 1, boxes: { z: good(), b: good(), a: good(), old: good() } };
  assert.deepEqual(factsRows(file, ["z", "a", "b"]).map((r) => r[0]), ["z", "a", "b", "old"]);
  assert.deepEqual(factsRows(file, ["z", "a", "b"], ["b", "z"]).map((r) => r[0]), ["z", "b"]);
});

test("an unknown TPM and Secure Boot read says so, with the message", () => {
  const facts = { ...m720qFacts(), tpm: { state: "unknown" as const, ready: null, specVersion: null, error: "Access is denied" }, secureBoot: { state: "unknown" as const, error: "not elevated" } };
  const [row] = factsRows({ version: 1, boxes: { w: good({ facts }) } }, ["w"]);
  assert.equal(row![column("TPM")], "unknown: Access is denied");
  assert.equal(row![column("Secure Boot")], "unknown: not elevated");
});

test("the rendered table has a header and one line per box, with the columns lined up", () => {
  const lines = renderTable(factsRows({ version: 1, boxes: { "a11y-worker-2": good(), "a11y-worker-10": good() } }, ["a11y-worker-2", "a11y-worker-10"]));
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.startsWith("box"));
  assert.equal(lines[1]!.indexOf("LENOVO"), lines[2]!.indexOf("LENOVO"));
});

test("readAtOf of a good entry is its time", () => {
  assert.equal(readAtOf(good()), READ);
});
