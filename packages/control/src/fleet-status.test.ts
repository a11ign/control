// `fleet:status` answers "what are my boxes doing", so the tests are about the states it must keep
// APART. A status table that shows a dying worker as healthy, or a missing one as idle, is worse than no
// table at all — it is the "two states reported as one" shape this project keeps paying for.
import { test } from "node:test";
import assert from "node:assert/strict";

import { stateOf, activityOf, summarise, degradedAdvice, fleetVerdict } from "./fleet-status.mjs";
import { fleetConsistency } from "../../worker-fleet/src/fleet-consistency.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ready = { name: "w1", url: "http://REDACTED-INTERNAL-ADDRESS:8765", reachable: true, health: { ready: true, busy: false }, progress: { busy: false, capturing: null } };

test("the four worker states are distinct", () => {
  assert.equal(stateOf(ready), "ready");
  assert.equal(stateOf({ ...ready, health: { ready: true, busy: true } }), "busy");
  assert.equal(stateOf({ ...ready, health: { ready: false, busy: false } }), "warming");
  assert.equal(stateOf({ name: "w", url: "u", reachable: false }), "unreachable");
});

test("a worker with no `ready` field is ready, not warming", () => {
  // Same rule as workerIsUsable: `ready` is newer than some deployed guests, and calling an older one
  // "warming" forever would be a report about our own field history rather than about the machine.
  assert.equal(stateOf({ ...ready, health: { busy: false } }), "ready");
});

test("a busy worker says what it is doing and for how long", () => {
  // The answer the whole command exists for. `/progress` has been served by every worker since a capture
  // that hung for five minutes could only tell you it had died — and until now nothing read it.
  const activity = activityOf({
    ...ready,
    progress: {
      busy: true,
      capturing: "http://REDACTED-INTERNAL-ADDRESS:5050/form-error-silent/bad.html",
      elapsedMs: 95_000,
      lastPhase: "sweep",
    },
  });
  assert.match(activity, /^1m35s @sweep/, "elapsed time and the phase it is IN identify a hang");
  assert.match(activity, /form-error-silent\/bad\.html/, "and which case it is on");
});

test("an idle worker reports no activity rather than a stale one", () => {
  assert.equal(activityOf(ready), "");

  // THE CASE THIS TEST WAS NAMED FOR AND DID NOT COVER. `/progress` keeps the last capture's record after
  // it completes, so the probe that matters is an idle worker WITH a progress record, not one without.
  // Observed on a11y-worker-2: `ready`, and reported as `36m41s @browserKeptAlive` on a case that had
  // finished half an hour earlier.
  //
  // `elapsedMs` keeps growing while the box sits idle, so the stale line reads as an ever-worsening hang —
  // indistinguishable from the fault this column exists to detect, and the reason the name was written
  // before the behaviour existed.
  const finished = {
    ...ready,
    health: { ...ready.health, busy: false },
    // Copied from a real /progress on a11y-worker-2, 42 minutes after the capture ended: `busy` had
    // cleared, `capturing` had not, and `elapsedMs` was still growing.
    progress: {
      busy: false,
      capturing: "http://203.0.113.79:5050/table-unassociated-hilltown/bad.html",
      elapsedMs: 2_526_239,
      lastPhase: "browserKeptAlive",
    },
  };
  assert.equal(activityOf(finished), "",
    "a finished capture must not render identically to one that is still running");
});

test("a degraded worker is surfaced even though every capture is succeeding", () => {
  // The fault that produced ZERO failures: one guest's NVDA needed a recovery on every capture, the
  // worker's retry absorbed them all, and it ran at 122.9s against a healthy peer's 40.6s. `failures`
  // stayed 0, so no eviction rule could fire. The recovery RATE is the only number that moves.
  const [row] = summarise([{
    ...ready,
    health: { ready: true, busy: false, code: "abc", vitals: { captures: 50, recoveries: 48, failures: 0 } },
  }]);
  assert.equal(row.state, "ready", "it is still serving — degraded is not unhealthy");
  assert.equal(row.degraded, true);
  assert.match(row.degradedReason ?? "", /96%/);
});

test("an unreachable worker carries its error instead of looking idle", () => {
  const [row] = summarise([{ name: "w3", url: "http://REDACTED-INTERNAL-ADDRESS:8765", reachable: false, error: "connect ECONNREFUSED" }]);
  assert.equal(row.state, "unreachable");
  assert.equal(row.captures, null, "no vitals is 'we never heard', not 'it has done no work'");
  assert.match(row.error ?? "", /ECONNREFUSED/);
});

test("a healthy worker's row carries the code, so a stale box is visible here too", () => {
  const [row] = summarise([{
    ...ready,
    health: { ready: true, busy: false, code: "22822b7a3a08969c", vitals: { captures: 9, recoveries: 0, failures: 0 } },
  }]);
  assert.equal(row.code, "22822b7a3a08969c");
  assert.equal(row.degraded, false);
});

test("the summary says WHICH channel it probed, never an unqualified 'reachable'", () => {
  // This probes one channel — HTTP :8765 — and a worker can serve it perfectly while being unmanageable.
  // On 2026-08-23 all four reported reachable and CONSISTENT while `ansible-playbook deploy.yml` answered
  // UNREACHABLE on every one, because the tailnet ACL grants tcp:8765 and not tcp:22. The tool measured
  // exactly what it said; the WORD invited a conclusion it does not support, and an afternoon went into
  // diagnosing a fleet that was healthy.
  const source = readFileSync(
    fileURLToPath(new URL("./fleet-status.mjs", import.meta.url)), "utf8");
  assert.ok(!/\$\{status\.reachable\}\/\$\{status\.total\} reachable/.test(source),
    "the summary claims bare 'reachable' again; name the channel, because a reader will infer 'usable'");
  assert.match(source, /serving \/health/, "the summary must name the channel it actually probed");
  assert.match(source, /whether you can DEPLOY/,
    "it must say what it does NOT cover — deployability is a different channel with different access");
});

test("a degraded worker gets a REMEDY, not just the word DEGRADED", () => {
  // The row this closes: `fleet:status` reported state a reader had to interpret. DEGRADED is the worst
  // case for that, because it is the fault that produces ZERO failures -- the worker's own retry absorbs
  // it, captures keep succeeding, and the eviction rule (three consecutive FAILURES) can never fire.
  const out = degradedAdvice([{ name: "a11y-worker-6 REDACTED-INTERNAL-ADDRESS:8765", degraded: true }]);
  assert.match(out, /a11y-worker-6/, "it must name WHICH box");
  assert.match(out, /fleet:provision -- --limit=/, "it must name the repair command");
  assert.match(out, /worker:compare/, "and how to confirm the repair worked");
  assert.match(out, /failures` stays 0/,
    "and WHY it hides — a reader who thinks zero failures means healthy will skip the line");
  assert.doesNotMatch(out, /\bundefined\b/, "no unresolved interpolation");
});

test("no degraded worker produces NO advice — never an empty heading", () => {
  // An empty "0 worker(s) DEGRADED" line trains readers to skim the section that matters most.
  assert.equal(degradedAdvice([{ name: "a11y-worker-2 1.2.3.4", degraded: false }]), "");
  assert.equal(degradedAdvice([]), "");
  assert.equal(degradedAdvice(undefined as never), "");
});

test("every degraded worker is named, not just the first", () => {
  // Two degraded boxes and one line naming one of them is the count-based check in a new costume.
  const out = degradedAdvice([
    { name: "a11y-worker-6 x", degraded: true },
    { name: "a11y-worker-9 y", degraded: true },
    { name: "a11y-worker-2 z", degraded: false },
  ]);
  assert.match(out, /2 worker\(s\) DEGRADED/);
  assert.match(out, /a11y-worker-6, a11y-worker-9/);
  assert.doesNotMatch(out, /a11y-worker-2/, "a healthy box must not be named as degraded");
});

/**
 * THE VERDICT CARRIES ITS DENOMINATOR, AND IS NEVER "CONSISTENT" OVER A SUBSET — #920.
 *
 * `fleet:status` compared only the boxes that answered and printed `fleet CONSISTENT` over them. Measured:
 * it said so over nine boxes while the tenth — excluded for not answering — was `a11y-worker-4` on Windows
 * `10.0.26200`, the other nine on `10.0.22631`. The OS is a capture-cache key, so the fleet was not one
 * fleet, and five captures were taken on the divergent box before anyone noticed.
 *
 * Driven through the REAL `fleetConsistency`, not a stub: the defect this row found is a predicate that
 * filters before it counts, and a stub would take the filtering out of the test along with the defect.
 */
// The REAL `MUST_MATCH` field names. The first version of this fixture wrote `os` for the Windows build,
// which `fleetConsistency` does not compare — so a box on a different build read as agreeing and two
// tests failed. That failure was the fixture being wrong, and it is exactly the shape of the defect: a
// field nobody compares is a difference nobody sees.
const env = (windowsVersion: string) => ({
  browserVersion: "151.0.0", screenReaderVersion: "2024.4", windowsVersion, architecture: "x64",
  captureProtocol: 12,
});
const box = (n: number, os = "10.0.22631") => ({ worker: `http://a11y-worker-${n}:8765`, environment: env(os) });

/** The verdict `fleetStatus` would print over these guests, out of an inventory of `total`. */
const verdictOver = (guests: ReturnType<typeof box>[], total: number) => {
  const { consistent, mismatches, compared } = fleetConsistency(guests);
  return fleetVerdict({ consistent, compared, total, mismatches });
};

test("YESTERDAY, EXACTLY: nine agreeing boxes and one that did not answer is NOT consistent", () => {
  const nineOfTen = [2, 3, 5, 6, 7, 8, 9, 10, 11].map((n) => box(n));
  const verdict = verdictOver(nineOfTen, 10);
  assert.notEqual(verdict.state, "CONSISTENT",
    "an unreachable box that has drifted reads exactly like one that agrees — this is the assertion the "
    + "row exists for");
  assert.equal(verdict.state, "UNKNOWN");
});

test("the verdict line carries its denominator, asserted on the RENDERED text", () => {
  // The counts already existed in the return value. The defect was that nothing joined them to the word,
  // so the assertion is on the sentence a reader sees, never on the fields.
  const all = verdictOver([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => box(n)), 10);
  assert.match(all.line, /^fleet CONSISTENT across 10 of 10 — /);
  const some = verdictOver([2, 3, 5, 6, 7, 8, 9, 10, 11].map((n) => box(n)), 10);
  assert.match(some.line, /9 compared agree, and 1 of 10 could not be compared/);
  assert.doesNotMatch(some.line, /CONSISTENT/, "not even as a substring — the word is the verdict");
});

test("UNKNOWN and INCONSISTENT are different states, with a fixture for each", () => {
  // "Nine agree and one did not answer" is a box to reach. "They disagree" is a fleet to re-provision.
  const unanswered = verdictOver([2, 3, 5].map((n) => box(n)), 4);
  const diverged = verdictOver([box(2), box(3), box(4, "10.0.26200"), box(5)], 4);
  assert.equal(unanswered.state, "UNKNOWN");
  assert.equal(diverged.state, "INCONSISTENT");
  assert.match(diverged.line, /^fleet INCONSISTENT across 4 of 4 — /);
});

test("TEN OF TEN AGREEING STILL PRINTS CONSISTENT", () => {
  // Both directions, or a verdict that is never CONSISTENT would pass every other assertion here.
  assert.equal(verdictOver([2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => box(n)), 10).state, "CONSISTENT");
});

test("a disagreement among the boxes that answered is INCONSISTENT, whatever the missing one says", () => {
  // The absent box cannot rescue a fleet that already disagrees, so this is not UNKNOWN.
  const verdict = verdictOver([box(2), box(3, "10.0.26200"), box(5)], 10);
  assert.equal(verdict.state, "INCONSISTENT");
  assert.match(verdict.line, /across 3 of 10/, "and it still says how many it was about");
});

test("THE SAME DEFECT ONE LEVEL DOWN: a box that answers but reports no environment is not compared", () => {
  // `fleetConsistency` drops a guest with no `environment` before comparing. Denominating by the number
  // of boxes that ANSWERED would have fixed the instance and left the class: four answered, three were
  // compared, and the verdict is about three.
  const answeredButEmpty = { worker: "http://a11y-worker-4:8765", environment: undefined };
  const { consistent, mismatches, compared } = fleetConsistency([box(2), box(3), answeredButEmpty as never, box(5)]);
  assert.equal(compared, 3, "fleetConsistency must say how many it actually compared");
  const verdict = fleetVerdict({ consistent, compared, total: 4, mismatches });
  assert.equal(verdict.state, "UNKNOWN", "a box that answered with nothing to compare is not agreement");
});

test("nothing to compare is UNKNOWN, never a vacuous CONSISTENT", () => {
  assert.equal(fleetVerdict({ consistent: true, compared: 0, total: 10 }).state, "UNKNOWN");
});
