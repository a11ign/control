// The part of fleet-layer/fleet-consistency.test.ts with no merged destination (a11ign/a11ign#5345): four tests that read the worker's
// `server.ts`, `display-sample.ts` and `file-version.ts` as TEXT. The `fleetConsistency` tests moved to a11ign/screenreader-fleet (#5350).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MUST_MATCH, REPORTED_ONLY } from "@a11ign/screenreader-fleet/fleet-consistency";
import { join } from "node:path";
import { layerSourceDir } from "../layer-checkouts.ts";

/**
 * One file of the worker as TEXT, from the layer's checkout through the resolver (#4516): the package ships `dist/` alone from v0.9.0, bundled and with its
 * comments gone, and these guards read the comments and the source's own anchors.
 */
const workerSource = (file: string) => readFileSync(join(layerSourceDir("nvda-worker"), file), "utf8");

/** The worker's `server.ts` as TEXT: it is not importable (guidepup at module scope) and not an export. */
const workerServerSource = () => workerSource("server.ts");

/**
 * Everything the worker's `/health` environment reports, as TEXT: `runtimeEnvironment`'s block, the display
 * sampler's reading (#2673) and the version sampler's reading (#2684) -- all three merged in on every call
 * because the display and version fields are sampled on a timer and carry their age. A field that moved out
 * of `runtimeEnvironment` is still reported, and a guard that read only the block would have called it
 * never sent. `currentEnvironment`'s own merge is the fourth place (#4516): `windowsBuild` (#4433) is returned from it, beside the
 * samplers, and from no sampler's `current`, so a guard that read the three above called it never sent in screenreader-worker v0.9.0.
 */
const workerReportedFieldsSource = () => {
  const server = workerServerSource();
  const start = server.indexOf("function runtimeEnvironment() {");
  const end = server.indexOf("function provisionRevision() {");
  assert.ok(start !== -1 && end > start, "server.ts no longer has a runtimeEnvironment block to read");
  const displaySample = workerSource("display-sample.ts");
  const displayCurrent = displaySample.indexOf("current: () => ({");
  assert.ok(displayCurrent !== -1, "display-sample.ts no longer has the reading `currentEnvironment` merges in");
  // `windowsVersion`/`screenReaderVersion`/`browserVersion` moved off `runtimeEnvironment` the same way and
  // for the same reason (#2684): `createVersionSampler` lives in `file-version.ts`, not `server.ts`,
  // because `server.ts` needs guidepup and cannot be imported off Windows to test the move BEHAVIOURALLY.
  const fileVersion = workerSource("file-version.ts");
  const versionCurrent = fileVersion.indexOf("current: () => ({");
  assert.ok(versionCurrent !== -1, "file-version.ts no longer has the reading `currentEnvironment` merges in");
  const merge = server.indexOf("function currentEnvironment() {");
  const mergeEnd = server.indexOf("\n}\n", merge);
  assert.ok(merge !== -1 && mergeEnd > merge, "server.ts no longer has a currentEnvironment merge to read");
  return server.slice(start, end) + displaySample.slice(displayCurrent) + fileVersion.slice(versionCurrent) + server.slice(merge, mergeEnd);
};

/**
 * Whether the worker's text names `path` as a property of what it reports: `path: value`, or the SHORTHAND (`{ ..., path }`) that
 * `currentEnvironment` returns `windowsBuild` in (#4516). The matcher must be able to MISS, and each test below plants a name it cannot find.
 */
const reportsField = (reported: string, path: string) => reported.includes(`${path}:`) || new RegExp(`[,{]\\s*${path}\\s*[,}]`).test(reported);

test("EVERY MUST_MATCH FIELD IS ONE THE WORKER ACTUALLY REPORTS", () => {
  // The hole #1953 fell through, generalised so the next field cannot fall through it too.
  //
  // `check()` skips a field no guest reports ("absent is not a mismatch", and that rule is right -- an
  // older worker must not be flagged against newer ones). The cost is that a `MUST_MATCH` entry naming
  // something the worker never sends is INVISIBLE: it compares nothing, reports nothing, and the fleet
  // reads CONSISTENT. `displayMode` is that failure from the other end -- a property that mattered, that
  // nothing sent, so nothing could compare -- and a typo'd path here would produce it silently.
  //
  // Asserted against server.mjs's SOURCE, the same narrow exception `provision-stamp.test.ts` states:
  // `server.mjs` imports guidepup, which constructs a ScreenReader at module scope and throws on a host
  // with no screen reader, so this file cannot import it on any runner this repo has.
  const reported = workerReportedFieldsSource();

  const missing = MUST_MATCH.map((f) => f.path).filter((path) => !reportsField(reported, path));
  assert.deepEqual(missing, [], "MUST_MATCH compares fields the worker's /health environment never sends");

  // The positive control for the line above: `deepEqual(missing, [])` passes when the matcher matches
  // everything, and a matcher that cannot fail is the defect this whole file is about.
  assert.ok(!reportsField(reported, "displayModeThatIsNotReported"),
    "the source matcher matches names that are not there, so the assertion above proves nothing");
});

test("#2063: EVERY REPORTED_ONLY FIELD IS ONE THE WORKER ACTUALLY REPORTS", () => {
  // `EVERY MUST_MATCH FIELD…` above, for the second channel, and it matters MORE here: a typo in
  // `MUST_MATCH` at least shows up as a permanent coverage gap that refuses a run, while a typo here is
  // a field that reads `unreported` for ever and looks exactly like a fleet that has not been deployed.
  const reported = workerReportedFieldsSource();

  const missing = REPORTED_ONLY.map((f) => f.path).filter((path) => !reportsField(reported, path));
  assert.deepEqual(missing, [], "REPORTED_ONLY names fields the worker's /health environment never sends");

  // The positive control for the line above, the same one the MUST_MATCH test carries: the matcher has
  // to be able to MISS, or an empty list proves nothing.
  assert.ok(!reportsField(reported, "displayAdapterThatIsNotReported"),
    "the source matcher matches names that are not there, so the assertion above proves nothing");
});

// #2211: WHAT AN OPERATOR IS TOLD ABOUT `displayAdapter` IS PINNED, NOT JUST WHAT THE FIELD DOES. The
// `#2063` tests above hold its behaviour (drift state, channel, census line) and none of its TEXT, so the
// sentence "no deployed worker reports it yet" was corrected once (#2246) with nothing keeping it corrected,
// and it printed on every `fleet:status` run directly beneath ten reported values.

/** Sentences that assert the field is unreported. Each is a spelling the old text used or would reword to. */
const CLAIMS_UNREPORTED = [
  /\bno (deployed )?(worker|guest)s? (reports?|sends?) it\b/i,
  /\breads? (as )?`?unknown`? (across|on every|on all)\b/i,
  /\buntil (this code|the worker|it) (is|has been|was) deployed\b/i,
  /\bwhich it will until\b/i,
];
const claimsUnreported = (text: string) => CLAIMS_UNREPORTED.some((claim) => claim.test(text));

const workerDisplayAdapterComment = () => {
  const server = workerServerSource();
  // The comment is the SUBJECT here, so it is not stripped -- and it is located by the heading that opens it and
  // the CODE line that ends it, so what is found cannot be a phrase that lives only in prose (#1213's defect).
  // Since #2673 the comment is `displayAdapter`'s own docblock: the field left `runtimeEnvironment` for the sampler.
  const start = server.indexOf("WHICH GRAPHICS ADAPTER THIS GUEST IS RUNNING ON");
  const end = server.indexOf("async function displayAdapter() {");
  assert.ok(start !== -1 && end > start, "server.ts no longer carries displayAdapter's comment to read");
  const between = server.slice(start, end);
  assert.ok(/REPORTED, NEVER GATED/.test(between), "the anchors no longer bracket displayAdapter's comment");
  return between;
};

/** Every occurrence of `reading` must sit within `reach` characters of a calendar date, either side. */
function readingsWithoutADate(text: string, reading: RegExp, reach = 160) {
  const dated = (at: number) => /\d{4}-\d{2}-\d{2}/.test(text.slice(Math.max(0, at - reach), at + reach));
  return [...text.matchAll(new RegExp(reading.source, "g"))].filter((m) => !dated(m.index)).length;
}
const HARDWARE_READINGS = [/640x480/, /Intel\(R\) (UHD|HD) Graphics 630/];

test("#2211: the worker's own displayAdapter comment claims no absence either", () => {
  const comment = workerDisplayAdapterComment();
  assert.equal(claimsUnreported(comment), false,
    "the reporter still says the fleet reads the field as unknown `until this code is deployed`");
  assert.equal(claimsUnreported("the fleet reading it as `unknown` on every guest -- which it will until this code is deployed"),
    true, "the matcher does not recognise the comment this row removed");
});

test("#2211: every hardware reading in the worker's displayAdapter comment is attributable to a moment", () => {
  // The worker half of the test a11ign/screenreader-fleet carries for the exemption text; the comment is worker source, so it stays here.
  const comment = workerDisplayAdapterComment();
  for (const reading of HARDWARE_READINGS) {
    if (!reading.test(comment)) continue; // a reading that is absent is not an undated one
    assert.equal(readingsWithoutADate(comment, reading), 0,
      `worker comment: ${reading} appears with no date beside it, so a reader cannot tell June from an hour ago`);
  }
  // Positive control: the undated clause this row dated must be caught, or `0` above proves only that nothing matched.
  assert.equal(readingsWithoutADate("workers 7-11 fell back to the Basic Display Adapter and captured at 640x480", /640x480/), 1,
    "the date matcher accepts an undated reading");
});
