/**
 * A JOB OF CASES, THE PURE HALF (A11-263): the cases file and its refusals in words, where whole groups are placed, where an interrupted group can go,
 * and when `skipWhen` matches. The runner and the CLI over these are in `recapture.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { casesRefusal, parseCasesFile, reassignGroups, skipsOn } from "./cases.ts";
import { planCases } from "./plan.ts";
import { captureCount } from "./types.ts";
import type { CaptureEntry, CaseSpec, GroupSpec } from "./types.ts";

const pair = (name: string, extra: Partial<CaseSpec> = {}): CaseSpec[] => ["good", "bad"].map((variant) => ({
  id: `${name}.${variant}`, url: `https://pages.test/${name}/${variant}.html`, body: { task: `${name} ${variant}` }, group: name, ...extra }));
const file = (cases: unknown, groups?: unknown): string => JSON.stringify({ cases, ...(groups === undefined ? {} : { groups }) });

test("the cases file is read: each case keeps its own body, a case with no group stays ungrouped, and the groups' settings come through", () => {
  const parsed = parseCasesFile(file([...pair("a"), { id: "solo", url: "https://pages.test/solo", body: {} }], { a: { skipWhen: { environment: { screenReaderVersion: "2026.1", guidepupVersion: null } } } }));
  assert.ok(!("refusal" in parsed), "refusal" in parsed ? parsed.refusal : "");
  if ("refusal" in parsed) return;
  assert.deepEqual(parsed.cases.map((c) => [c.id, c.group, c.body]), [["a.good", "a", { task: "a good" }], ["a.bad", "a", { task: "a bad" }], ["solo", undefined, {}]]);
  assert.deepEqual(parsed.groups.a, { skipWhen: { environment: { screenReaderVersion: "2026.1", guidepupVersion: null } } });
});

test("a cases file is refused in words: a duplicate id, a bad id, manifest, a body that sets url, a URL that is not http, no cases, bad JSON", () => {
  const refusal = (text: string): string => { const parsed = parseCasesFile(text); return "refusal" in parsed ? parsed.refusal : "(accepted)"; };
  assert.match(refusal(file([...pair("a"), ...pair("a")])), /case a\.good is given twice/);
  assert.match(refusal(file([{ id: "../x", url: "https://pages.test/", body: {} }])), /id that is not letters, digits/);
  assert.match(refusal(file([{ id: "manifest", url: "https://pages.test/", body: {} }])), /called manifest/);
  assert.match(refusal(file([{ id: "x", url: "https://pages.test/", body: { url: "https://other.test/" } }])), /case x: the capture body sets url, which the service sets for itself/);
  assert.match(refusal(file([{ id: "x", url: "https://pages.test/", body: { captureId: "1", async: true } }])), /sets captureId, async/);
  assert.match(refusal(file([{ id: "x", url: "file:///etc/passwd", body: {} }])), /case x: url is not an http or https URL/);
  assert.match(refusal(file([{ id: "x", url: "https://pages.test/" }])), /case x: the capture body is not an object/);
  assert.match(refusal(file([])), /no cases were given/);
  assert.match(refusal("{nope"), /not JSON/);
  assert.match(refusal("[]"), /not \{ "cases"/);
});

test("a group's settings are refused when they would not mean what they say: an unknown group, a pinned box, an empty skipWhen, a case that attempts", () => {
  const refusal = (cases: CaseSpec[], groups?: unknown): string => casesRefusal(cases, groups) ?? "(accepted)";
  assert.match(refusal(pair("a"), { b: {} }), /groups names b, which no case belongs to/);
  assert.match(refusal(pair("a"), { a: { box: "w2" } }), /group a sets box.*never by a submit/);
  assert.match(refusal(pair("a"), { a: { skipWhen: { environment: {} } } }), /names no field, so it would skip on every box/);
  assert.match(refusal(pair("a"), { a: { skipWhen: { environment: { v: { nested: true } } } } }), /skipWhen\.environment\.v is not a string/);
  assert.match(refusal(pair("a"), { a: { skipWhen: { when: "now" } } }), /skipWhen is \{ "environment"/);
  assert.match(refusal(pair("a", { attempt: 2 })), /sets attempt, which a re-capture sets/);
  assert.match(refusal([{ id: "a", url: "https://pages.test/", body: {} }, { id: "b", url: "https://pages.test/", body: {}, group: "a" }]), /case a has no group, so it is a group of its own, and another case's group has that name/);
  assert.equal(casesRefusal(pair("a"), { a: { skipWhen: { environment: { v: null } } } }), null);
});

test("a case job counts its cases, and a page job its pages times its passes", () => {
  assert.equal(captureCount({ pages: [], passes: 1, cases: pair("a") }), 2);
  assert.equal(captureCount({ pages: ["x", "y", "z"], passes: 2 }), 6);
});

const grouped = (plan: CaptureEntry[]): Record<string, string[]> => {
  const out: Record<string, Set<string>> = {};
  for (const c of plan) (out[c.group!] ??= new Set()).add(c.box);
  return Object.fromEntries(Object.entries(out).map(([group, boxes]) => [group, [...boxes]]));
};

test("planCases keeps every group on ONE box, in file order, and the pair's good comes before its bad", () => {
  const cases = [...pair("a"), ...pair("b"), ...pair("c"), ...pair("d")];
  const plan = planCases(cases, {}, ["w2", "w3", "w4"]);
  for (const [group, boxes] of Object.entries(grouped(plan))) assert.equal(boxes.length, 1, `${group} is on ${boxes}`);
  for (const box of ["w2", "w3", "w4"]) {
    const mine = plan.filter((c) => c.box === box).map((c) => c.case!);
    for (const group of ["a", "b", "c", "d"]) {
      const at = mine.filter((id) => id.startsWith(`${group}.`));
      if (at.length) assert.deepEqual(at, [`${group}.good`, `${group}.bad`]);
    }
  }
  assert.ok(plan.every((c) => c.status === "pending" && c.attempt === 1 && c.pass === 1));
  assert.deepEqual(plan.slice(0, 2).map((c) => c.file), ["a.good.a1.json", "a.bad.a1.json"], "records are named by case and attempt");
});

test("planCases balances whole groups, largest first, and emits a box's entries group by group", () => {
  const big = ["1", "2", "3", "4"].map((n) => ({ id: `big.${n}`, url: `https://pages.test/big/${n}`, body: {}, group: "big" }));
  const cases = [...pair("a"), ...big, ...pair("b"), { id: "solo", url: "https://pages.test/solo", body: {} }];
  const plan = planCases(cases, {}, ["w2", "w3"]);
  assert.deepEqual(grouped(plan).big, ["w2"], "the largest group is placed first, on the first box");
  const counts = ["w2", "w3"].map((box) => plan.filter((c) => c.box === box).length);
  assert.deepEqual(counts, [5, 4], "the pairs go to the lighter box, and the lone case to the first box on a tie");
  const onW3 = plan.filter((c) => c.box === "w3").map((c) => c.group);
  assert.deepEqual(onW3, [...onW3].sort((x, y) => onW3.indexOf(x!) - onW3.indexOf(y!)), "one group is finished before the next starts");
  assert.equal(new Set(onW3).size, 2, "both pairs");
  assert.equal(plan.find((c) => c.case === "solo")!.group, "solo", "a case with no group is a group of its own");
});

test("planCases puts a pinned group on its box whatever the balance says, and refuses a pin to a box the job does not have", () => {
  const groups: Record<string, GroupSpec> = { a: { box: "w4" } };
  const plan = planCases([...pair("a"), ...pair("b")], groups, ["w2", "w3", "w4"]);
  assert.deepEqual(grouped(plan), { a: ["w4"], b: ["w2"] });
  assert.throws(() => planCases(pair("a"), { a: { box: "w9" } }, ["w2"]), /group a is pinned to w9, which the job does not have/);
});

const placed = (statuses: Record<string, CaptureEntry["status"]>, box = "w2"): CaptureEntry[] => planCases([...pair("a"), ...pair("b")], {}, [box]).map((c) => ({ ...c, status: statuses[c.case!] ?? "pending" }));

test("a restart moves a group that is untouched, whole, and fails a group that is partly done, naming why", () => {
  const captures = placed({ "a.good": "done" });
  const { moved, failed } = reassignGroups(captures, {}, "w2", ["w3"]);
  assert.deepEqual(moved.map((c) => c.case), ["b.good", "b.bad"], "group b had nothing done, so it moves whole");
  assert.ok(captures.filter((c) => c.group === "b").every((c) => c.box === "w3"));
  assert.deepEqual(failed.map((f) => f.entry.case), ["a.bad"]);
  assert.equal(failed[0]!.error, "w2 left the fleet; group a was already partly captured there, and a group is never split across boxes");
  assert.equal(captures.find((c) => c.case === "a.bad")!.box, "w2", "the failed case is not moved");
});

test("a restart never moves a group a re-capture pinned, and fails every group when no box is left", () => {
  const pinned = reassignGroups(placed({}), { a: { box: "w2" } }, "w2", ["w3"]);
  assert.deepEqual(pinned.moved.map((c) => c.group), ["b", "b"]);
  assert.match(pinned.failed[0]!.error, /group a is pinned to w2 by a re-capture/);
  const none = reassignGroups(placed({}), {}, "w2", []);
  assert.deepEqual([none.moved.length, none.failed.length], [0, 4]);
});

test("skipWhen matches field by field: a field that differs, or is absent where null is not wanted, does not match", () => {
  const reading = (environment: Record<string, unknown> | null) => ({ code: "c", environment, policy: null });
  const skip = (environment: Record<string, unknown>): GroupSpec => ({ skipWhen: { environment } });
  const env = { screenReaderVersion: "2026.1", browserVersion: "156.0" };
  assert.equal(skipsOn(skip({ screenReaderVersion: "2026.1" }), reading(env)), true);
  assert.equal(skipsOn(skip({ screenReaderVersion: "2026.1", browserVersion: "156.0" }), reading(env)), true);
  assert.equal(skipsOn(skip({ screenReaderVersion: "2026.1", browserVersion: "155.0" }), reading(env)), false, "one field differs");
  assert.equal(skipsOn(skip({ guidepupVersion: null }), reading(env)), true, "an absent field reads as null");
  assert.equal(skipsOn(skip({ guidepupVersion: "1.0" }), reading(env)), false);
  assert.equal(skipsOn(skip({ screenReaderVersion: "2026.1" }), reading(null)), false, "a box that said no environment never skips");
  assert.equal(skipsOn(skip({ screenReaderVersion: "2026.1" }), null), false, "a box that was not read never skips");
  assert.equal(skipsOn({}, reading(env)), false, "a group with no skipWhen is never skipped");
  assert.equal(skipsOn(undefined, reading(env)), false);
});
