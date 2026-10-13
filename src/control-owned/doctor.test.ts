// The control half of fleet-layer/doctor.test.ts (a11ign/a11ign#5345). Two tests stay: the `fleet:status` same-words test reads control's
// `src/fleet-status.ts`, and the LIVE test reads core's `packages/judge`; no merged destination holds the second, so it is kept here
// rather than deleted (the rest moved to a11ign/screenreader-fleet's src/doctor.test.ts and src/dist-exports.test.ts, a11ign#5350).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingExportTargets, fleetAgreementLine } from "../../../worker-fleet/src/doctor.ts";
import { MUST_MATCH } from "../../../worker-fleet/src/fleet-consistency.ts";

test("LIVE: every exports target of this repo's own judge package is on disk after the build", () => {
  // Not a fixture -- the real package and the real `dist`, right after this suite's own `pretest` build. It
  // replaces the `tsc --build --dry` LIVE test #3580 removed (#3810). If Rslib renames an output without
  // `exports` following, this is the test that says so, which no fixture can.
  const repoRoot = new URL("../../../../", import.meta.url).pathname;
  assert.deepEqual(missingExportTargets(join(repoRoot, "packages/judge")), []);
});

/**
 * The coverage `fleetConsistency` returns for a whole fleet: every MUST_MATCH field, reported by all of
 * them. DERIVED from `MUST_MATCH` for the reason the first test below gives about its own assertion --
 * a hand-typed list here is the same staleness one file over.
 */
const wholeCoverage = (guests: number) =>
  MUST_MATCH.map(({ path }) => ({ field: path, reported: guests, asked: guests }));

/**
 * The whole fleet with ONE field lowered to `guests` of `of` reporters -- the fixture this family turns
 * on. At `guests: 0` it is #1997's zero case and at `guests: 1` it is #2034's partial one, and the point
 * of building both from one helper is that the two differ by that number and by nothing else.
 */
const reportedBy = ({ field, guests, of }: { field: string, guests: number, of: number }) =>
  wholeCoverage(of).map((entry) => (entry.field === field ? { ...entry, reported: guests } : entry));

test("#2034: `doctor` and `fleet:status` describe one fleet in the same words", () => {
  // Done-when 5: two commands reading one `fields` must not describe it differently. `fleet-status.ts`
  // is READ, not imported -- `packages/control` takes no dependency on this package (ADR 0012), and the
  // sibling tests in this package read its Ansible defaults the same way.
  //
  // TWO-SIDED ON PURPOSE: the phrase is asserted against BOTH sources, so re-wording either command alone
  // fails this test and whoever re-words has to do both.
  // CONCATENATION JOINED FIRST. Both commands wrap their clause across a `\` + `\` boundary to stay
  // inside the line length, so the phrase they both PRINT appears in neither source contiguously -- a
  // plain `includes` on the raw text fails against code that says exactly the right thing.
  const joined = (source: string) => source.replace(/`\s*\+\s*`/g, "").replace(/\s+/g, " ");
  const status = joined(readFileSync(
    fileURLToPath(new URL("../../src/fleet-status.ts", import.meta.url)), "utf8"));
  assert.match(status, /function partialClause\(/,
    "fleet-status.ts no longer has the clause this parity is against -- the assertions below prove nothing");

  const line = fleetAgreementLine({ agreeing: 3, configured: 3,
    fields: { compared: MUST_MATCH.map(({ path }) => path), unchecked: [],
      coverage: reportedBy({ field: "displayMode", guests: 1, of: 3 }) } });
  for (const phrase of ["reported by only SOME of the compared guests", "${reported} of ${asked} reported it"]) {
    assert.ok(status.includes(phrase), `fleet:status no longer says "${phrase}"`);
  }
  assert.ok(line.includes("reported by only SOME of the compared guests"), line);
  assert.ok(line.includes("(1 of 3 reported it)"), line);
});
