/**
 * THE FACTS FILE (A11-283): a good read replaces a box's entry, a failed one keeps the last facts and marks them stale, and a file that cannot be read is
 * never written over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { m720qFacts } from "./facts.fixture.ts";
import { FACTS_FILE, FACTS_FILE_ENV, factsFilePath, readFactsFile, recordAttempt } from "./facts-file.ts";
import type { FactsFile } from "./types.ts";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-facts-"));
  const path = join(dir, "fleet-facts.json");
  return { path, read: (): FactsFile => JSON.parse(readFileSync(path, "utf8")) as FactsFile, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const YESTERDAY = "2026-10-24T09:00:00.000Z";
const NOW = "2026-10-25T09:00:00.000Z";

test("a first good read creates the file with the box's facts, readAt and no staleness", () => {
  const t = scratch();
  assert.deepEqual(recordAttempt(t.path, { box: "a11y-worker-2", job: "fj-1", at: NOW, facts: m720qFacts() }), { ok: true });
  assert.deepEqual(t.read(), { version: 1, boxes: { "a11y-worker-2": { readAt: NOW, stale: false, lastAttemptAt: NOW, lastJob: "fj-1", lastError: null, facts: m720qFacts() } } });
  t.done();
});

test("a stale box keeps its last facts and readAt, with stale true, lastAttemptAt and lastError", () => {
  const t = scratch();
  recordAttempt(t.path, { box: "a11y-worker-5", job: "fj-1", at: YESTERDAY, facts: m720qFacts() });
  recordAttempt(t.path, { box: "a11y-worker-5", job: "fj-2", at: NOW, error: "a11y-worker-5 did not come up when woken" });
  assert.deepEqual(t.read().boxes["a11y-worker-5"], {
    readAt: YESTERDAY, stale: true, lastAttemptAt: NOW, lastJob: "fj-2", lastError: "a11y-worker-5 did not come up when woken", facts: m720qFacts() });
  t.done();
});

test("a box that was never read and does not answer is facts null, stale true", () => {
  const t = scratch();
  recordAttempt(t.path, { box: "a11y-worker-9", job: "fj-1", at: NOW, error: "unreachable" });
  assert.deepEqual(t.read().boxes["a11y-worker-9"], { readAt: null, stale: true, lastAttemptAt: NOW, lastJob: "fj-1", lastError: "unreachable", facts: null });
  t.done();
});

test("a good read after a failed one replaces the entry and clears stale and the error", () => {
  const t = scratch();
  recordAttempt(t.path, { box: "a11y-worker-5", job: "fj-1", at: YESTERDAY, error: "unreachable" });
  recordAttempt(t.path, { box: "a11y-worker-5", job: "fj-2", at: NOW, facts: m720qFacts() });
  const entry = t.read().boxes["a11y-worker-5"]!;
  assert.equal(entry.stale, false);
  assert.equal(entry.lastError, null);
  assert.equal(entry.readAt, NOW);
  t.done();
});

test("one box's attempt leaves every other box's entry as it was", () => {
  const t = scratch();
  recordAttempt(t.path, { box: "a11y-worker-2", job: "fj-1", at: YESTERDAY, facts: m720qFacts() });
  recordAttempt(t.path, { box: "a11y-worker-3", job: "fj-2", at: NOW, error: "unreachable" });
  assert.equal(t.read().boxes["a11y-worker-2"]!.readAt, YESTERDAY);
  assert.deepEqual(Object.keys(t.read().boxes).sort(), ["a11y-worker-2", "a11y-worker-3"]);
  t.done();
});

test("a file that is not JSON is not overwritten, and the reason names it", () => {
  const t = scratch();
  writeFileSync(t.path, "{ not json");
  const result = recordAttempt(t.path, { box: "a11y-worker-2", job: "fj-1", at: NOW, facts: m720qFacts() });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, new RegExp(`${t.path.replaceAll(".", "\\.")} is unreadable`));
  assert.equal(readFileSync(t.path, "utf8"), "{ not json");
  t.done();
});

test("a file of a version this code does not know is not overwritten", () => {
  const t = scratch();
  const newer = JSON.stringify({ version: 2, boxes: { x: {} } });
  writeFileSync(t.path, newer);
  const result = recordAttempt(t.path, { box: "a11y-worker-2", job: "fj-1", at: NOW, facts: m720qFacts() });
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /is version 2 and this service reads version 1/);
  assert.equal(readFileSync(t.path, "utf8"), newer);
  t.done();
});

test("a missing file reads as empty, and the path is the one beside the inventory unless the environment says otherwise", () => {
  const t = scratch();
  assert.deepEqual(readFactsFile(t.path), { ok: true, value: { version: 1, boxes: {} } });
  assert.equal(factsFilePath({}), "/etc/a11ign/fleet-facts.json");
  assert.equal(FACTS_FILE, "/etc/a11ign/fleet-facts.json");
  assert.equal(factsFilePath({ [FACTS_FILE_ENV]: "/tmp/x.json" }), "/tmp/x.json");
  t.done();
});
