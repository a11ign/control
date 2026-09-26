// `fleet:status` answers "what are my boxes doing", so the tests are about the states it must keep
// APART. A status table that shows a dying worker as healthy, or a missing one as idle, is worse than no
// table at all — it is the "two states reported as one" shape this project keeps paying for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { stateOf, activityOf, summarise, degradedAdvice, warmingAdvice, consistencyVerdict, fleetStatus, LINK,
  linkVerdictOf, readLinkLayer, neighbourScript, renderHead, failedRead, fleetToProbe, inconsistentAdvice } from "./fleet-status.mjs";
import { fleetConsistency, MUST_MATCH, REPORTED_ONLY }
  from "../../worker-fleet/src/fleet-consistency.mjs";
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

test("a warming worker's `/health.readiness` reaches the row -- the row this closes", () => {
  // Before this, `stateOf` said "warming" and stopped: `/health.readiness` already carries the failed
  // check and, for a dialog, its own text, and nothing here read it. Row #44's own acceptance: name the
  // fault and the fix, not a state the reader has to interpret.
  const [row] = summarise([{
    name: "w4", url: "http://REDACTED-INTERNAL-ADDRESS:8765", reachable: true,
    health: { ready: false, busy: false,
      readiness: { reason: "not ready: noBlockingDialog", blockingDialogs: [{ message: "PhoneExperienceHost" }] } },
  }]);
  assert.equal(row.state, "warming");
  assert.equal(row.readiness?.reason, "not ready: noBlockingDialog");
});

test("a worker blocked by a dialog is told to RESTART IT, not to visit a console", () => {
  // THE ADVICE WAS "log in at the console" AND IT COST REAL DAYS. True when written; then #1733 made
  // `prepareDesktop` clear a blocker instead of only recording it -- but that self-heal runs AT THE
  // START OF A CAPTURE, and a blocked worker reports `not ready`, so it is never dispatched one. The
  // fix is gated behind the fault it fixes, and only a restart escapes that.
  const out = warmingAdvice([{ name: "a11y-worker-4 1.2.3.4", state: "warming",
    readiness: { reason: "not ready: noBlockingDialog", blockingDialogs: [{ message: "PhoneExperienceHost" }] } }]);
  assert.match(out, /a11y-worker-4/, "it must name WHICH box");
  assert.match(out, /PhoneExperienceHost/, "and quote the dialog's own text, not just that one exists");
  assert.match(out, /fleet:recover/, "the remedy must be a command, over SSH, that a session can run");
});

test("a worker stuck on ForegroundLockTimeout is pointed at the fix script", () => {
  const out = warmingAdvice([{ name: "a11y-worker-2 x", state: "warming",
    readiness: { reason: "not ready: foregroundLockTimeout" } }]);
  assert.match(out, /apply-foreground-lock-timeout\.ps1/,
    "the runbook's named fix for the row's dominant cause (row 226) must be the command printed");
});

test("a foreground holder names WHO holds it and the command that clears it", () => {
  const out = warmingAdvice([{ name: "a11y-worker-2 x", state: "warming",
    readiness: { reason: "not ready: noForegroundBlocker", foregroundBlockedBy: "explorer.exe" } }]);
  assert.match(out, /explorer\.exe/, "WHO holds the foreground, not just that something does");
  assert.match(out, /fleet:recover -- --limit=a11y-worker-2/,
    "and the limit must name THIS box, so the reader never has to compose the command");
});

/**
 * THE REMEDY MUST BE RUNNABLE BY THE SESSION READING IT -- measured three times, all the same toast.
 *
 * `a11y-worker-4` held 4.9 days. `a11y-worker-10` 4.6 days, withdrawn from the fleet on a note claiming
 * it answered neither /health nor SSH nor ICMP -- two of those three were false. `a11y-worker-3` on
 * 2026-09-20, cleared in 53 seconds by `fleet:recover --limit=a11y-worker-3`.
 *
 * THE THIRD ONE WAS COST BY THIS FUNCTION. `orchestrator` diagnosed it correctly, read the old sentence
 * out of `fleet:status`, and told the chairman the box "needs a console login" -- so nine healthy
 * workers idled behind a remedy the session already had permission to run.
 */
test("no warming remedy sends a session to a console before trying the command it can run", () => {
  const cases = [
    { reason: "not ready: noForegroundBlocker", foregroundBlockedBy: "ShellExperienceHost" },
    { reason: "not ready: noBlockingDialog", blockingDialogs: [{ message: "New notification" }] },
  ];
  for (const readiness of cases) {
    const out = warmingAdvice([{ name: "a11y-worker-3 x", state: "warming", readiness }]);
    assert.match(out, /fleet:recover/, `${readiness.reason} must name the runnable remedy`);
    assert.doesNotMatch(out, /^[^]*log in at the console[^]*fleet:recover/,
      "the console must never be offered BEFORE the command that works over SSH");
  }
});

test("a browser misconfiguration quotes the worker's own error, not just the check name", () => {
  const out = warmingAdvice([{ name: "a11y-worker-2 x", state: "warming",
    readiness: { reason: "not ready: browserConfigured", browserConfigError: "A11Y_BROWSER=chrome is not supported" } }]);
  assert.match(out, /A11Y_BROWSER=chrome is not supported/);
});

test("an unmatched reason still points at the runbook rather than saying nothing", () => {
  const out = warmingAdvice([{ name: "a11y-worker-2 x", state: "warming",
    readiness: { reason: "not ready: someFutureCheck" } }]);
  assert.match(out, /docs\/nvda-worker-runbook\.md/);
  assert.match(out, /someFutureCheck/);
});

test("no warming advice for a ready, busy or unreachable worker -- state gates it, not the presence of a reason", () => {
  // The mutation this guards: dropping the `state === "warming"` filter would fire on any row that
  // happens to carry a stale `readiness.reason` object, e.g. one left over from before a box recovered.
  const out = warmingAdvice([
    { name: "a11y-worker-2 x", state: "ready", readiness: { reason: "not ready: noBlockingDialog" } },
    { name: "a11y-worker-3 y", state: "busy", readiness: { reason: "not ready: noBlockingDialog" } },
  ]);
  assert.equal(out, "");
});

test("no warming advice when there is nothing to advise -- never an empty heading", () => {
  assert.equal(warmingAdvice([{ name: "a11y-worker-2 x", state: "warming", readiness: null }]), "");
  assert.equal(warmingAdvice([]), "");
  assert.equal(warmingAdvice(undefined as never), "");
});

test("every warming worker is named, not just the first", () => {
  const out = warmingAdvice([
    { name: "a11y-worker-6 x", state: "warming", readiness: { reason: "not ready: noBlockingDialog" } },
    { name: "a11y-worker-9 y", state: "warming", readiness: { reason: "not ready: foregroundLockTimeout" } },
    { name: "a11y-worker-2 z", state: "ready", readiness: { reason: "not ready: noBlockingDialog" } },
  ]);
  assert.match(out, /a11y-worker-6/);
  assert.match(out, /a11y-worker-9/);
  assert.doesNotMatch(out, /a11y-worker-2\b/, "a ready box must not be named as warming");
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
// The REAL `MUST_MATCH` field names, DERIVED. The first version of this fixture wrote `os` for the Windows
// build, which `fleetConsistency` does not compare — so a box on a different build read as agreeing and
// two tests failed. That failure was the fixture being wrong, and it is exactly the shape of the defect:
// a field nobody compares is a difference nobody sees.
//
// #1997 is that lesson one step further in. The hand-written version named FIVE of the ten `MUST_MATCH`
// fields, so every guest here reported none of the other five and the verdict called them interchangeable
// anyway — the defect under test, sitting in the fixture of the test that was supposed to catch it.
// Derived from the list, a field added there is reported by these guests without editing this line, and
// a fleet that reports nothing cannot be mistaken for one that agrees.
const env = (windowsVersion: string) => ({
  ...Object.fromEntries(MUST_MATCH.map(({ path }) => [path, `same-${path}`])),
  windowsVersion, architecture: "x64", captureProtocol: 12,
});
const box = (n: number, os = "10.0.22631") => ({ worker: `http://a11y-worker-${n}:8765`, environment: env(os) });

/**
 * The field coverage a fully-reporting fleet yields — every `MUST_MATCH` field compared, none unchecked.
 *
 * For the cases below that drive `consistencyVerdict` DIRECTLY rather than through `fleetConsistency`:
 * #1997 gave `fields` no default for the same reason #1029 gave `rows` none, so a case that omits it is
 * UNKNOWN about coverage and can no longer assert anything about readiness or agreement.
 *
 * #2019 made it take the GUEST COUNT, because the coverage now carries how many guests reported each
 * field and a hand-written number would be a second place for that to be wrong. `guests` in and `guests`
 * out per field is the statement "every compared guest reported every field", which is what this fixture
 * has always meant and could not previously say.
 */
const comparedEverything = (guests: number) => ({
  compared: MUST_MATCH.map(({ path }) => path),
  unchecked: [],
  coverage: MUST_MATCH.map(({ path }) => ({ field: path, reported: guests, asked: guests })),
});

/**
 * The verdict `fleetStatus` would print over these guests, out of an inventory of `total`.
 *
 * `rows` is supplied all-ready because these cases are about the ENVIRONMENT comparison; #1029 made a
 * missing `rows` UNKNOWN rather than CONSISTENT, so passing it is what keeps these tests about the thing
 * they are about instead of about readiness.
 */
const verdictOver = (guests: ReturnType<typeof box>[], total: number) => {
  const { consistent, mismatches, compared, fields } = fleetConsistency(guests);
  const rows = guests.map((g) => ({ name: g.worker, state: "ready" }));
  // `fields` for the same reason `rows` is here (#1997): the verdict has no default for either, so a
  // helper that omitted it would make every case below UNKNOWN about coverage instead of about its own
  // subject.
  return consistencyVerdict({ consistent, compared, total, mismatches, rows, fields });
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
  const verdict = consistencyVerdict({ consistent, compared, total: 4, mismatches, rows: [] });
  assert.equal(verdict.state, "UNKNOWN", "a box that answered with nothing to compare is not agreement");
});

test("nothing to compare is UNKNOWN, never a vacuous CONSISTENT", () => {
  assert.equal(consistencyVerdict({ consistent: true, compared: 0, total: 10, rows: [] }).state, "UNKNOWN");
});

test("the deprecated `consistent` field carries the CORRECTED answer, never the old misreading", () => {
  // Kept one release for scripts outside the repo, because removing it fails silently: `undefined` is
  // falsy. But aliasing `comparedAgree` would keep #920's defect in the one field a legacy script reads,
  // so it mirrors the verdict instead. Asserted on the SOURCE because `fleetStatus` probes real workers.
  const source = readFileSync(fileURLToPath(new URL("./fleet-status.mjs", import.meta.url)), "utf8");
  assert.match(source, /consistent: verdict\.state === "CONSISTENT"/,
    "the legacy field must be true only when the whole inventory was compared and agrees");
  assert.doesNotMatch(source, /consistent: comparedAgree|consistent: consistent\b/,
    "aliasing the compared-set agreement would hand a legacy script the exact misreading this fixes");
});

// --- #1029: a clean environment comparison is not a usable fleet ---

// DERIVED from `MUST_MATCH`, and it used to be five keys of which exactly ONE (`provisionRevision`) was a
// field this compares -- `windows`, `arch`, `nvda` and `edge` are not `MUST_MATCH` paths, so these guests
// reported 1 of 10 fields and the verdict below still read CONSISTENT. #1997's fix turns that into
// UNKNOWN, which is how a fixture that had been describing a fleet nobody could compare was found.
// EVERY COMPARED FIELD, FROM BOTH CHANNELS, DERIVED. A hand-written list is what silently decays --
// `capture-fleet-guard.test.ts` records its own version of this, where the six fields that existed the
// day it was typed turned every fixture in the file into a coverage gap nothing noticed. Deriving means
// a field added tomorrow joins these fixtures on its own.
//
// `REPORTED_ONLY` is in here for a sharper reason than symmetry (#2063): a fixture that omitted those
// fields would make EVERY case in this file read as a fleet with a reported-only gap, so every verdict
// line would carry a drift clause and each case would quietly stop being about its own subject.
const ENVIRONMENT = Object.fromEntries(
  [...MUST_MATCH, ...REPORTED_ONLY].map(({ path }) => [path, `same-${path}`]));

/** A probe as `probeWorker` returns one, with only the readiness dial to turn. */
const fakeProbe = (name: string, state: "ready" | "busy" | "warming" | "unreachable") =>
  (state === "unreachable"
    ? { name, url: `http://${name}:8765`, reachable: false, error: "ECONNREFUSED" }
    : {
      name, url: `http://${name}:8765`, reachable: true,
      health: { ok: true, ready: state !== "warming", busy: state === "busy", environment: ENVIRONMENT,
        code: "abc1234", vitals: { captures: 3, recoveries: 0 } },
      progress: {},
    });

// #2019: `environment` also takes a FUNCTION OF THE GUEST INDEX, because the reading this row is about --
// one guest of ten reporting a field and the rest not -- cannot be expressed by one environment shared by
// every guest, which is the only shape #1997 needed.
type GuestEnvironment = Record<string, unknown> | ((index: number) => Record<string, unknown>);
const driveFleet = (states: ("ready" | "busy" | "warming" | "unreachable")[],
  environment: GuestEnvironment = ENVIRONMENT) => {
  const envFor = (index: number) => (typeof environment === "function" ? environment(index) : environment);
  const workers = states.map((_, i) => ({ name: `a11y-worker-${i + 2}`, url: `http://a11y-worker-${i + 2}:8765` }));
  return fleetStatus({
    workers: () => workers,
    probe: async (w) => {
      const probe = fakeProbe(w.name, states[workers.indexOf(w)]);
      // #1997: the ONE dial this adds, so a case can drive the REAL `fleetStatus` over guests that do not
      // report a field. The defect was never inside `consistencyVerdict` -- coverage was computed in
      // `fleetStatus` and never crossed to the verdict, which is #1029's lesson verbatim, so a case that
      // drove only the pure function would hold the function and leave the CALL unheld.
      return probe.health
        ? { ...probe, health: { ...probe.health, environment: envFor(workers.indexOf(w)) } }
        : probe;
    },
    // #1311 review: injected so a test that ever drives an "unreachable" box here fails loudly rather than
    // ssh-ing to the real control plane from a shell that knows where it is -- structural, not a URL's spelling.
    linkRead: () => { throw new Error("a unit test reached the real layer-2 read: inject linkRead"); },
  });
};

test("#1029: a fleet whose environments agree but whose box is WARMING does not read CONSISTENT", async () => {
  // `a11y-worker-4` sat warming behind a PhoneExperienceHost dialog for ~19.7 hours while this line read
  // `fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for capture`. They were not.
  const status = await driveFleet(["ready", "ready", "warming", "ready"]);
  assert.equal(status.verdict.state, "BLOCKED");
  assert.match(status.verdict.line, /a11y-worker-4, warming/,
    "NAMED, never counted -- 'blocked' sends a reader back to fleet:status, 'blocked on a11y-worker-4, "
    + "warming' sends them to a box");
  assert.match(status.verdict.line, /environments agree across 4 of 4/,
    "and the consistency fact SURVIVES: this row makes the verdict pessimistic, it does not delete a "
    + "measurement a reader still needs");
  assert.equal(status.comparedAgree, true, "the underlying comparison is untouched and still true");
  assert.equal(status.consistent, false,
    "and the deprecated compatibility field carries the corrected answer, so an outside script reading "
    + "`fleet:status --json` gets the fix without changing a line");
});

test("#1029: BUSY is not a fault -- a fleet mid-capture still reads CONSISTENT", async () => {
  // The easy wrong fix refuses a healthy fleet under load. Asserted in both directions against the same
  // driver, so the two cases differ by one worker's state and nothing else.
  const busy = await driveFleet(["ready", "busy", "busy", "ready"]);
  assert.equal(busy.verdict.state, "CONSISTENT");
  const warming = await driveFleet(["ready", "busy", "warming", "ready"]);
  assert.equal(warming.verdict.state, "BLOCKED",
    "and the SAME fleet with one box warming instead of busy is blocked -- the two states are read "
    + "differently, which is the whole point of `stateOf` keeping four of them");
});

test("#1029: the existing verdicts are unchanged -- this is an addition, not a re-decision", () => {
  const rows = [{ name: "a", state: "warming" }];
  assert.equal(consistencyVerdict({ consistent: false, compared: 4, total: 4, mismatches: [], rows }).state,
    "INCONSISTENT", "a real mismatch still outranks readiness: the environments disagreeing is the worse "
    + "fact and the one that must be reported");
  assert.equal(consistencyVerdict({ consistent: true, compared: 0, total: 10, rows }).state, "UNKNOWN");
  assert.equal(consistencyVerdict({ consistent: true, compared: 9, total: 10, rows }).state, "UNKNOWN");
  assert.equal(consistencyVerdict({
    consistent: true, compared: 4, total: 4, rows: [{ name: "a", state: "ready" }],
    fields: comparedEverything(4),
  }).state, "CONSISTENT", "and an all-ready, all-agreeing fleet still reads CONSISTENT");
});

test("#1029: a caller that supplies NO readiness gets UNKNOWN, never a permissive CONSISTENT", () => {
  // worker-judge's tiebreak on #1048, and the argument I made on their #1033 four hours earlier turned
  // back on me: "nobody told me the readiness" is CANNOT ASK, not "all ready". A default that silently
  // answers the permissive way is the 19.7 hours in miniature -- the whole defect was this function
  // answering a question it had not been given the inputs for.
  const verdict = consistencyVerdict({ consistent: true, compared: 4, total: 4 });
  assert.equal(verdict.state, "UNKNOWN");
  assert.match(verdict.line, /no readiness was supplied/,
    "and it says WHICH question went unasked, so the caller knows what to pass rather than what to retry");
  assert.match(verdict.line, /environments agree across 4 of 4/,
    "while still reporting the fact it DID measure -- refusing to answer is not refusing to report");
  assert.equal(consistencyVerdict({ consistent: true, compared: 4, total: 4, rows: [],
    fields: comparedEverything(4) }).state, "CONSISTENT",
  "and an EXPLICIT empty list is a different statement from no list at all: it says the caller asked "
  + "and found nobody blocked, which is exactly the distinction `undefined` versus `[]` exists to make");
});

// --- #1997: a MUST_MATCH field NO guest reports is CANNOT ASK, not ALL AGREE ---

/** The same environment, with one field deleted -- the only difference between the pair below. */
const reportingAllBut = (field: string) => {
  const { [field]: removed, ...rest } = ENVIRONMENT;
  assert.equal(typeof removed, "string", `the fixture must HOLD ${field} for deleting it to mean anything`);
  return rest;
};

test("#1997: THE PAIR -- a field every guest agrees on and a field NO guest reports read differently", async () => {
  // Measured 2026-09-22T20:09Z on the live fleet, at `3ae7846f8` (the merge of #1953, which added
  // `displayMode` to MUST_MATCH): nine fields at 10/10 guests, `displayMode` at 0/10, and this line read
  // `fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for capture`. The display was
  // still not compared, and it was the same sentence #1953 was filed about. `compared` counts GUESTS,
  // never FIELDS, so nothing in the verdict could see it.
  //
  // BOTH HALVES ARE `comparedAgree: true` OVER THE SAME FOUR GUESTS. That is why one assertion is not
  // enough: the defect is that these two fleets produced the IDENTICAL verdict, so a case that drove
  // either one alone passed with the defect present.
  const everything = await driveFleet(["ready", "ready", "ready", "ready"]);
  const blind = await driveFleet(["ready", "ready", "ready", "ready"], reportingAllBut("displayMode"));

  assert.equal(everything.verdict.state, "CONSISTENT");
  assert.match(everything.verdict.line, /^fleet CONSISTENT across 4 of 4 — /);

  assert.equal(blind.comparedAgree, true, "the comparison itself is untouched -- absent is still not a mismatch");
  assert.equal(blind.verdict.state, "UNKNOWN", "but a field compared on nobody is not agreement about it");
  assert.match(blind.verdict.line, /displayMode/,
    "NAMED, never counted: '1 field was not compared' sends a reader back to fleet:status, and "
    + "'displayMode was not compared' sends them to the deploy that would report it");
  assert.doesNotMatch(blind.verdict.line, /CONSISTENT/,
    "not even as a substring -- #920's rule, because the word is what a reader takes away");
  assert.equal(blind.consistent, false,
    "and the deprecated compatibility field follows the verdict, so a script reading `--json` gets it too");
});

test("#1997: the coverage reaches the JSON, with both lists, so a caller can act on which field it was", async () => {
  // A conclusion that changes what happens next belongs in a field, not only in a sentence: the remedy for
  // this state is a deploy of one named field, and a reader parsing `--json` cannot grep a prose line for
  // which one.
  const blind = await driveFleet(["ready", "ready"], reportingAllBut("displayMode"));
  assert.deepEqual(blind.fields.unchecked, ["displayMode"]);
  assert.ok(blind.fields.compared.includes("browserVersion"),
    "and WHAT WAS compared is named too -- the positive control for the list above, which would otherwise "
    + "be satisfied by a reading that compared nothing at all");
});

test("#1997: a caller that supplies NO coverage gets UNKNOWN, never a permissive CONSISTENT", () => {
  // The same tiebreak #1029 settled for `rows`, one door over: "nobody told me which fields were
  // compared" is CANNOT ASK, not "all of them". There is exactly one production caller and it passes
  // `fields`, so this changes no real verdict -- it closes the door through which #1997 walked in.
  const verdict = consistencyVerdict({ consistent: true, compared: 4, total: 4, rows: [] });
  assert.equal(verdict.state, "UNKNOWN");
  assert.match(verdict.line, /no field coverage was supplied/,
    "and it says WHICH question went unasked, so the caller knows what to pass rather than what to retry");
  assert.match(verdict.line, /environments agree across 4 of 4/,
    "while still reporting what it DID measure -- refusing to answer is not refusing to report");
});

test("#1997: the UNKNOWN line names the deploy that closes it, and its denominator", () => {
  // A verdict a reader cannot act on gets read once. The remedy is the deploy that makes the guests report
  // the field -- or dropping the field -- and both are one command or one decision, not a runbook.
  const { state, line } = consistencyVerdict({
    consistent: true, compared: 10, total: 10, rows: [],
    fields: {
      compared: MUST_MATCH.slice(1).map(({ path }) => path),
      unchecked: [MUST_MATCH[0].path],
      // #2019: the coverage the two lists are derived from -- nine fields on every guest, the tenth on
      // none. Spelled out rather than defaulted, because a `fields` that cannot say HOW MANY reported
      // each field is now its own cannot-ask and would make this case UNKNOWN about the wrong question.
      coverage: MUST_MATCH.map(({ path }, i) => ({ field: path, reported: i === 0 ? 0 : 10, asked: 10 })),
    },
  });
  assert.equal(state, "UNKNOWN");
  // DERIVED, like the fixture three lines up -- #1561. The fixture is `MUST_MATCH.slice(1)` against
  // `MUST_MATCH[0]`, so it already grows with the list; this denominator was typed out as `9 of 10` and so
  // did not, and adding an eleventh field turned a passing assertion red for a reason unconnected to what
  // it is about. Re-typing the new number would rebuild the same trap one field later.
  assert.match(line, new RegExp(`${MUST_MATCH.length - 1} of ${MUST_MATCH.length} fields`),
    "the FIELD denominator, beside the guest one -- #920's shape, one axis over");
  assert.match(line, /fleet:deploy/);
});

// --- #2019: a MUST_MATCH field SOME compared guests do not report is the same cannot-ask, one threshold in ---

/**
 * Field coverage where `displayMode` was reported by `reporters` of `guests`, everything else by all.
 *
 * ONE VARIABLE between the readings below: the reporter count on one field. Anything else different and
 * the pair stops being a control for the threshold and becomes a control for the axis.
 */
const displayReportedBy = (reporters: number, guests: number) => ({
  ...comparedEverything(guests),
  coverage: comparedEverything(guests).coverage.map((entry) => (
    entry.field === "displayMode" ? { ...entry, reported: reporters } : entry)),
});

test("#2019: THE PAIR -- a field every guest reports and a field ONE guest of ten reports read differently", () => {
  // THE DEFECT, VERBATIM. Measured 2026-09-22 at `2c34bd8db` with #1997 in the tree: ten guests, one
  // reporting `displayMode` and nine reporting none of it, `fields.unchecked` empty, and the headline
  // `fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for capture`. One guest's
  // display was read, nine were not, and the line said interchangeable.
  //
  // BOTH HALVES ARE `consistent: true` OVER THE SAME TEN GUESTS WITH THE SAME `compared` LIST -- which is
  // exactly why the verdict could not tell them apart, and why an assertion on either one alone passes
  // with the defect present.
  const everybody = consistencyVerdict({
    consistent: true, compared: 10, total: 10, rows: [], fields: displayReportedBy(10, 10),
  });
  const oneOfTen = consistencyVerdict({
    consistent: true, compared: 10, total: 10, rows: [], fields: displayReportedBy(1, 10),
  });

  assert.equal(everybody.state, "CONSISTENT", "the positive control: full coverage still reads CONSISTENT");
  assert.match(everybody.line, /^fleet CONSISTENT across 10 of 10 — /);

  assert.equal(oneOfTen.state, "UNKNOWN",
    "`product-manager`'s ruling, 2026-09-22: the guest axis calls nine agreeing and one unasked UNKNOWN "
    + "(#920), and a field 1 of 10 guests reports is that sentence one axis over");
  assert.doesNotMatch(oneOfTen.line, /CONSISTENT/,
    "not even as a substring -- #920 refused a caveat under the word for this same reason, and answer 2 "
    + "was refused here on that precedent");
  assert.match(oneOfTen.line, /displayMode \(1 of 10 reported it\)/,
    "NAMED WITH ITS COUNT: '1 field was partly reported' sends a reader back to this command, and "
    + "'displayMode, 1 of 10' tells them nine boxes owe an answer");
  assert.match(oneOfTen.line, /fleet:deploy/, "and the converge that closes it");
});

test("#2019: `k of N` and `0 of N` are DIFFERENT LINES in the same state, because the remedies differ", () => {
  // Done-when 5. `0 of N` is nobody could be asked -- it sends a reader to the FIELD (deploy it, or drop
  // it from MUST_MATCH). `k of N` is some boxes did not report it -- it sends them to the BOXES. #920's
  // own reason for splitting CONSISTENT from UNKNOWN is this reason, and collapsing the two lines would
  // lose it while keeping the state.
  const nobody = consistencyVerdict({
    consistent: true, compared: 10, total: 10, rows: [], fields: displayReportedBy(0, 10),
  });
  const some = consistencyVerdict({
    consistent: true, compared: 10, total: 10, rows: [], fields: displayReportedBy(3, 10),
  });
  assert.equal(nobody.state, "UNKNOWN");
  assert.equal(some.state, "UNKNOWN", "the same state -- this is a line distinction, not a fifth state");
  assert.match(nobody.line, /compared on NO guest/);
  assert.doesNotMatch(nobody.line, /reported it/,
    "a field nobody reported must not also be reported as a partial count: it is on ONE of the two lines");
  assert.match(some.line, /reported by only SOME of the compared guests/);
  assert.doesNotMatch(some.line, /compared on NO guest/);

  // BOTH AT ONCE IS BOTH LINES, not the first one found. A converge that half-reached one field while
  // never reaching another is two different repairs, and a reader who acts on one has not finished.
  const both = consistencyVerdict({
    consistent: true,
    compared: 10,
    total: 10,
    rows: [],
    fields: {
      compared: MUST_MATCH.slice(1).map(({ path }) => path),
      unchecked: [MUST_MATCH[0].path],
      coverage: MUST_MATCH.map(({ path }, i) => (
        { field: path, reported: i === 0 ? 0 : i === 1 ? 2 : 10, asked: 10 })),
    },
  });
  assert.equal(both.state, "UNKNOWN");
  assert.match(both.line, /compared on NO guest/);
  assert.match(both.line, new RegExp(`${MUST_MATCH[1].path} \\(2 of 10 reported it\\)`));
});

test("#2019: a `fields` that cannot say HOW MANY reported each field is a cannot-ask, not a pass", () => {
  // The same tiebreak #1029 settled for `rows` and #1997 for `fields`, a third time: a caller carrying
  // the pre-#2019 shape has answered "did anybody report it" and not "how many", so it cannot rule out
  // the 1-of-10 reading this row exists for. Answering the permissive way is how both earlier rows
  // happened, and there is exactly one production caller -- it passes the whole object.
  const verdict = consistencyVerdict({
    consistent: true, compared: 4, total: 4, rows: [],
    fields: { compared: MUST_MATCH.map(({ path }) => path), unchecked: [] },
  });
  assert.equal(verdict.state, "UNKNOWN");
  assert.match(verdict.line, /by HOW MANY guests/,
    "and it says WHICH question went unasked, so the caller knows what to pass rather than what to retry");
});

test("#2019: the reporter counts reach the JSON, so a caller acts on the count and not on a sentence", async () => {
  // A conclusion that changes what happens next belongs in a field, not only in a sentence (the chairman's
  // 2026-09-19 direction). The remedy here is a converge aimed at the boxes that did NOT report the field,
  // and a reader parsing `--json` cannot grep a prose line for the count.
  // ONE guest of the four keeps its display; the other three lost it -- the row's own reading, at four.
  const partial = await driveFleet(["ready", "ready", "ready", "ready"],
    (i) => (i === 0 ? ENVIRONMENT : reportingAllBut("displayMode")));
  const display = partial.fields.coverage.find((f: { field: string }) => f.field === "displayMode");
  assert.deepEqual(display, { field: "displayMode", reported: 1, asked: 4 });
  assert.equal(partial.verdict.state, "UNKNOWN");
  // The positive control for the line above, which a reading that reported 1-of-4 for EVERY field would
  // otherwise satisfy.
  const browser = partial.fields.coverage.find((f: { field: string }) => f.field === "browserVersion");
  assert.deepEqual(browser, { field: "browserVersion", reported: 4, asked: 4 });
});

// --- #1298: a box that does not answer /health says FIRST, in words, whether it is on the network ---

/** `ip neigh show <address>` in the shapes the control plane printed on 2026-09-13; "" is no entry at all. */
const neigh = (address: string, state: string) => {
  if (state === "") return "";
  if (state === "FAILED" || state === "INCOMPLETE") return `${address} dev eth0 ${state}`;
  return `${address} dev eth0 lladdr 02:00:5e:00:53:01 ${state}`;
};

/**
 * A control plane whose neighbour table reads `script[address]` over the polls, interleaved per poll the
 * way `neighbourScript` prints it, recording every command it was asked to run.
 */
const controlPlaneReading = (script: Record<string, string[]>) => {
  const calls: string[][] = [];
  const run = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const addresses = Object.keys(script);
    const polls = Math.max(0, ...addresses.map((a) => script[a].length));
    const stdout = Array.from({ length: polls }, (_, i) =>
      addresses.map((a) => `${a}|${neigh(a, script[a][i] ?? "")}`)).flat().join("\n");
    return { status: 0, stdout };
  }) as unknown as typeof spawnSync;
  return { run, calls, controlPlane: () => ({ host: "control.invalid", key: "/nonexistent/key" }) };
};

/** A box as the inventory names it: `<inventory name>  <address>:<port>`, on a documentation address. */
const inventoryBox = (n: number) => ({ name: `a11y-worker-${n}  192.0.2.${n}:8765`, url: `http://192.0.2.${n}:8765` });

/** `fleetStatus` over boxes that answer and boxes that do not, the silent ones reading `silent[n]` at layer 2. */
const driveLinks = (answering: number[], silent: Record<number, string[]>,
  plane: { run?: typeof spawnSync, controlPlane?: () => { host: string, key: string } } = {}) => {
  const reading = controlPlaneReading(Object.fromEntries(
    Object.entries(silent).map(([n, states]) => [`192.0.2.${n}`, states])));
  const workers = [...answering, ...Object.keys(silent).map(Number)].map(inventoryBox);
  return fleetStatus({
    workers: () => workers,
    probe: async (w) => (answering.some((n) => w.url === `http://192.0.2.${n}:8765`)
      ? { ...fakeProbe(w.name, "ready"), url: w.url }
      : { name: w.name, url: w.url, reachable: false, error: "EHOSTDOWN" }),
    linkRead: (rows) => readLinkLayer(rows, {
      run: plane.run ?? reading.run, controlPlane: plane.controlPlane ?? reading.controlPlane }),
  });
};

const STATE_LINE = /^(OFF THE NETWORK|ON THE NETWORK|unknown)/;

test("#1298: only REACHABLE and FAILED are layer-2 answers, and the last one seen is the one reported", () => {
  const a = "192.0.2.7";
  const read = (...states: string[]) => linkVerdictOf(states.map((s) => neigh(a, s)));
  assert.equal(read("INCOMPLETE", "FAILED").verdict, LINK.OFF);
  assert.equal(read("STALE", "DELAY", "PROBE", "REACHABLE").verdict, LINK.ON);
  assert.equal(read("REACHABLE", "FAILED").verdict, LINK.OFF,
    "the question is whether it is on the wire NOW, so a later FAILED outranks an earlier REACHABLE");
  const stale = read("STALE", "STALE", "DELAY");
  assert.equal(stale.verdict, LINK.NO_VERDICT,
    "8 of 10 HEALTHY boxes read STALE after a probe on 2026-09-13 -- a cached entry is not an answer");
  assert.match(stale.detail, /DELAY, a cached entry that never settled/);
  const never = read("", "", "");
  assert.equal(never.verdict, LINK.NO_VERDICT, "never in the table means never resolved from there: not seen is not absent");
  assert.match(never.detail, /not on its segment/);
});

test("#1298: OFF THE NETWORK, ON THE NETWORK and no verdict are different lines, one per box, printed before the table", async () => {
  const status = await driveLinks([2], { 3: ["INCOMPLETE", "FAILED"], 4: ["STALE", "REACHABLE"], 5: ["STALE", "STALE"] });
  const lines = status.linkLayer.lines;
  const shown = lines.join("\n");
  assert.ok(lines.includes("OFF THE NETWORK (no layer-2 answer from a11y-worker-3: check cable and power)"), shown);
  assert.ok(lines.some((l) => l.startsWith("ON THE NETWORK, worker not answering (a11y-worker-4 ")), shown);
  assert.ok(lines.some((l) => /^unknown \(no layer-2 verdict for a11y-worker-5: last read STALE/.test(l)), shown);
  assert.ok(!lines.some((l) => l.includes("a11y-worker-2")), "a box that answered /health is not asked about, and not named");
  for (const box of ["a11y-worker-3", "a11y-worker-4", "a11y-worker-5"]) {
    assert.equal(lines.filter((l) => STATE_LINE.test(l) && l.includes(`${box} `) || STATE_LINE.test(l) && l.includes(`${box}:`)).length, 1,
      `${box} is on exactly one state line, and no line carries two boxes' states`);
  }
  assert.ok(lines.some((l) => /fleet:wake -- <name>/.test(l)), "an OFF box gets the one cheap thing to try before the walk");
  const head = renderHead(status);
  const firstState = head.findIndex((l) => l.includes("OFF THE NETWORK"));
  const tableHeader = head.findIndex((l) => /^\s+worker\s+state\s+code/.test(l));
  assert.ok(firstState >= 0 && tableHeader > firstState, `printed FIRST, before the table:\n${head.join("\n")}`);
});

test("#1298 MUTATION: swap two boxes' layer-2 inputs and the words follow the inputs, not the box", async () => {
  const before = (await driveLinks([], { 3: ["FAILED"], 4: ["REACHABLE"] })).linkLayer.lines;
  const after = (await driveLinks([], { 3: ["REACHABLE"], 4: ["FAILED"] })).linkLayer.lines;
  assert.ok(before.includes("OFF THE NETWORK (no layer-2 answer from a11y-worker-3: check cable and power)"), before.join("\n"));
  assert.ok(after.includes("OFF THE NETWORK (no layer-2 answer from a11y-worker-4: check cable and power)"), after.join("\n"));
  assert.ok(after.some((l) => l.startsWith("ON THE NETWORK, worker not answering (a11y-worker-3 ")), after.join("\n"));
  assert.ok(!after.some((l) => l.startsWith("OFF THE NETWORK") && l.includes("a11y-worker-3")));
});

test("#1298: a control plane that cannot be asked is `unknown (control plane unreachable)` for every silent box, never OFF", async () => {
  const refused = await driveLinks([2], { 3: ["FAILED"], 4: ["REACHABLE"] }, { run: (() => ({ status: 255, stdout: "" })) as unknown as typeof spawnSync });
  const shown = refused.linkLayer.lines.join("\n");
  for (const box of ["a11y-worker-3", "a11y-worker-4"]) {
    assert.ok(refused.linkLayer.lines.some((l) =>
      l.startsWith(`unknown (control plane unreachable) for ${box}: ssh exit 255, ssh's own connection failure`)), shown);
  }
  assert.ok(!refused.linkLayer.lines.some((l) => /^(OFF|ON) THE NETWORK/.test(l)),
    "the fixture's neighbour lines were never read, so neither answer may appear");
  const untold = await driveLinks([], { 3: ["FAILED"] }, {
    controlPlane: () => { throw new Error("A11Y_CONTROL_HOST is required and has no default -- see the README"); },
  });
  assert.match(untold.linkLayer.lines[0],
    /^unknown \(control plane unreachable\) for a11y-worker-3: this shell was never told where it is \(A11Y_CONTROL_HOST is required and has no default\)$/);
});

test("#1298 as amended: UNKNOWN holds a fleet write exactly as OFF does, and the hold names each list separately", async () => {
  const mixed = await driveLinks([2], { 3: ["FAILED"], 4: ["REACHABLE"], 5: ["STALE"] });
  assert.deepEqual(mixed.linkLayer.gate, { hold: true, off: ["a11y-worker-3"], unknown: ["a11y-worker-5"] });
  assert.ok(mixed.linkLayer.lines.includes("fleet write: HOLD — off the network: a11y-worker-3; unknown: a11y-worker-5"),
    mixed.linkLayer.lines.join("\n"));
  const unknownOnly = await driveLinks([], { 5: ["STALE"] });
  assert.deepEqual(unknownOnly.linkLayer.gate, { hold: true, off: [], unknown: ["a11y-worker-5"] }, "no verdict is not permission");
  const allOn = await driveLinks([2], { 4: ["REACHABLE"] });
  assert.deepEqual(allOn.linkLayer.gate, { hold: false, off: [], unknown: [] });
  assert.match(allOn.linkLayer.lines[allOn.linkLayer.lines.length - 1], /^fleet write: may proceed/);
});

test("#1298: a fleet where every box answers asks nothing at layer 2 and prints nothing new", async () => {
  let asked = 0;
  const status = await fleetStatus({
    workers: () => [inventoryBox(2), inventoryBox(3)],
    probe: async (w) => ({ ...fakeProbe(w.name, "ready"), url: w.url }),
    linkRead: () => { asked += 1; return new Map(); },
  });
  assert.equal(asked, 0, "the read costs an ssh and twelve seconds, so a healthy fleet must not pay it");
  assert.deepEqual(status.linkLayer, { lines: [], gate: null });
  assert.deepEqual(renderHead(status).slice(0, 1), [renderHead({ ...status, linkLayer: { lines: [] } })[0]]);
});

test("#1298: one ssh to the control plane with its own key and BatchMode, and only IPv4 addresses reach its shell", () => {
  const reading = controlPlaneReading({ "192.0.2.3": ["FAILED"], "192.0.2.4": ["REACHABLE"] });
  readLinkLayer([inventoryBox(3), inventoryBox(4)], reading);
  assert.equal(reading.calls.length, 1, "one connection for every silent box, not one each");
  const [command, ...args] = reading.calls[0];
  assert.equal(command, "ssh");
  assert.equal(args[args.indexOf("-i") + 1], "/nonexistent/key");
  assert.ok(args.includes("BatchMode=yes"), "an unauthorised key must fail, not wait on a prompt nobody sees");
  assert.ok(args.includes("root@control.invalid"));
  assert.match(args[args.length - 1], /for a in 192\.0\.2\.3 192\.0\.2\.4; do ping -c 1 -W 1/);
  assert.throws(() => neighbourScript(["192.0.2.1;reboot"]), /not IPv4 addresses, refusing/);

  let ran = 0;
  const byHostname = readLinkLayer([{ name: "a11y-worker-9", url: "http://a11y-worker-9:8765" }],
    { run: (() => { ran += 1; return { status: 0, stdout: "" }; }) as unknown as typeof spawnSync, controlPlane: reading.controlPlane });
  assert.equal(byHostname.get("a11y-worker-9")?.verdict, LINK.NO_VERDICT,
    "a hostname is in no neighbour table, so reading its absence as OFF would be a false walk");
  assert.equal(ran, 0, "and with nothing askable there is no ssh at all");
});

test("#1311 review: a control plane that ANSWERED and failed the read is no verdict, never `control plane unreachable`", async () => {
  const spawned = (result: object) => (() => ({ stdout: "", ...result })) as unknown as typeof spawnSync;
  const failedThere = await driveLinks([], { 3: ["FAILED"] }, { run: spawned({ status: 1 }) });
  assert.equal(failedThere.linkLayer.lines[0],
    "unknown (no layer-2 verdict for a11y-worker-3: the control plane answered, but the read failed there (remote exit 1))");
  assert.doesNotMatch(failedThere.linkLayer.lines.join("\n"), /control plane unreachable/,
    "it answered, so sending somebody to check its reachability is the wrong errand");
  assert.deepEqual(failedThere.linkLayer.gate, { hold: true, off: [], unknown: ["a11y-worker-3"] },
    "and the gate holds exactly as it did");

  const timedOut = await driveLinks([], { 3: ["FAILED"] }, {
    run: spawned({ status: null, error: Object.assign(new Error("spawnSync ssh ETIMEDOUT"), { code: "ETIMEDOUT" }) }) });
  assert.match(timedOut.linkLayer.lines[0], /^unknown \(no layer-2 verdict for a11y-worker-3: the read did not finish within 45 s/);
  const killed = await driveLinks([], { 3: ["FAILED"] }, { run: spawned({ status: null }) });
  assert.match(killed.linkLayer.lines[0], /^unknown \(no layer-2 verdict for a11y-worker-3: ssh was killed/);

  const neverStarted = await driveLinks([], { 3: ["FAILED"] }, {
    run: spawned({ status: null, error: Object.assign(new Error("spawnSync ssh ENOENT"), { code: "ENOENT" }) }) });
  assert.match(neverStarted.linkLayer.lines[0], /^unknown \(control plane unreachable\) for a11y-worker-3: ssh could not be started/,
    "ssh never starting is the one other case where the control plane was genuinely never asked");
  assert.equal(failedRead({ status: 0 }), null, "and a clean read is not a failure");
});

test("#1323: a child that STARTED but hit a real error -- output past maxBuffer -- is no verdict, never "
  + "`ssh could not be started`, though it carries an `error` the same as a spawn that never ran", () => {
  // A REAL spawnSync, not a hand-built error -- #1311's second verdict found the original mistake exactly
  // this way (5654132234): the other real results (ENOENT, ETIMEDOUT, exit 1, exit 255, SIGKILL, exit 0)
  // all read correctly, and only ENOBUFS -- a child that DID start -- was misread as "never started".
  const overflowed = spawnSync(process.execPath,
    ["-e", 'process.stdout.write("x".repeat(100000)); setTimeout(() => {}, 5000)'],
    { encoding: "utf8", maxBuffer: 1024 });
  assert.equal((overflowed.error as { code?: string } | undefined)?.code, "ENOBUFS", "the fixture must really overflow maxBuffer");
  assert.ok((overflowed.pid ?? 0) > 0, "a child that ran has a real pid, unlike a spawn that never started");

  const read = failedRead(overflowed);
  assert.equal(read?.verdict, LINK.NO_VERDICT, "ssh started, so this is not the control-plane-unreachable case");
  assert.match(read?.detail ?? "", /ssh started \(pid \d+\)/);
  assert.match(read?.detail ?? "", /ENOBUFS/, "it must name the code, not just say the read failed");
  assert.doesNotMatch(read?.detail ?? "", /could not be started/);

  // MUTATION TARGET (#1323): a spawn that genuinely never started (pid 0) must still read this way.
  const neverStarted = spawnSync("/definitely/not/a/real/command-1323", []);
  assert.equal(neverStarted.pid, 0, "the fixture must really never start");
  const neverStartedRead = failedRead(neverStarted);
  assert.equal(neverStartedRead?.verdict, LINK.UNASKED);
  assert.match(neverStartedRead?.detail ?? "", /ssh could not be started/);
});

// --- #1356: fleetToProbe asks the CONTROL PLANE's inventory, never a checkout's own inventory.yml ---

/** Saves/restores A11Y_WORKER(S) around `fn`, so this suite never depends on the ambient shell's env. */
function withNoConfiguredWorkers(fn: () => void) {
  const saved = { A11Y_WORKER: process.env.A11Y_WORKER, A11Y_WORKERS: process.env.A11Y_WORKERS };
  delete process.env.A11Y_WORKER;
  delete process.env.A11Y_WORKERS;
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("#1356: fleetToProbe asks the control plane's inventory, and pairs the inventory NAME with the address", () => {
  withNoConfiguredWorkers(() => {
    const workers = fleetToProbe({
      readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" }] }),
    });
    assert.deepEqual(workers, [{ name: "a11y-worker-2  192.0.2.2:8765", url: "http://192.0.2.2:8765" }]);
  });
});

test("#1356: fleetToProbe does not double the address when the inventory names none", () => {
  withNoConfiguredWorkers(() => {
    const workers = fleetToProbe({
      readFleet: () => ({ refusal: null, workers: [{ name: "192.0.2.2:8765", url: "http://192.0.2.2:8765" }] }),
    });
    assert.deepEqual(workers, [{ name: "192.0.2.2:8765", url: "http://192.0.2.2:8765" }],
      "controlPlaneFleet already falls back to the bare address as the name -- printing it twice would be new noise");
  });
});

test("#1356: fleetToProbe THROWS naming which of the three causes it was -- never a silently empty table, "
  + "and never a checkout's own inventory.yml", () => {
  withNoConfiguredWorkers(() => {
    assert.throws(
      () => fleetToProbe({ readFleet: () => ({ refusal: "no inventory exists at /etc/a11ign/inventory.yml on the control plane", workers: [] }) }),
      /No fleet to report on: A11Y_WORKERS is unset, and no inventory exists at \/etc\/a11ign\/inventory\.yml/);
    assert.throws(
      () => fleetToProbe({ readFleet: () => ({ refusal: "the control plane could not be reached (Connection timed out)", workers: [] }) }),
      /No fleet to report on: A11Y_WORKERS is unset, and the control plane could not be reached/);
  });
});

test("#1356: A11Y_WORKER(S) still wins first, and never even calls the control plane", () => {
  const saved = process.env.A11Y_WORKERS;
  process.env.A11Y_WORKERS = "http://REDACTED-INTERNAL-ADDRESS:8765";
  try {
    let called = false;
    const workers = fleetToProbe({ readFleet: () => { called = true; return { refusal: null, workers: [] }; } });
    assert.equal(called, false, "naming workers means you are managing them -- the control plane is not asked");
    assert.deepEqual(workers, [{ name: "REDACTED-INTERNAL-ADDRESS:8765", url: "http://REDACTED-INTERNAL-ADDRESS:8765" }]);
  } finally {
    if (saved === undefined) delete process.env.A11Y_WORKERS; else process.env.A11Y_WORKERS = saved;
  }
});

// --- #2063: THE REPORTED-ONLY CHANNEL, ON THE LINE A READER SEES ---

/**
 * THE REPORTED-ONLY FIELD THESE CASES ARE ABOUT, and it is `displayAdapter` because `nodeVersion` LEFT
 * this channel at #2170 -- step 3 of `ceo`'s ruling on #2063, taken once the fleet converged on the pin.
 * A case still driven by `nodeVersion` would assert that a runtime split leaves the state CONSISTENT,
 * which is now the opposite of what `fleet-consistency` does with it, and the ruling's exemption would be
 * guarded by nothing.
 *
 * ASSERTED to be in the list rather than read out of it by INDEX, which is what these cases used to do
 * (`REPORTED_ONLY[1].path`). An index silently re-points at a different field the day the list changes
 * length -- and #2170 is that day: it took the list from two members to one, so `[1]` became `undefined`
 * and the fixture destructured nothing.
 */
const ADAPTER = "displayAdapter";
const UHD = "Intel(R) UHD Graphics 630";
const HD = "Intel(R) HD Graphics 630";

test("#2063: the case subject is a REPORTED_ONLY field, not a name that used to be one", () => {
  assert.ok(REPORTED_ONLY.some(({ path }) => path === ADAPTER),
    `${ADAPTER} is not in REPORTED_ONLY, so every case below is testing the reported-only channel with a `
    + "field that does not travel it");
  // The positive control: the matcher has to be able to MISS, or the assertion above proves nothing.
  assert.ok(!REPORTED_ONLY.some(({ path }) => path === "displayAdapterThatIsNotReportedOnly"));
});

test("#2063: THE PAIR -- the headline over a reported-only split no longer claims interchangeability", async () => {
  // Measured on the live fleet 2026-09-23T06:55Z on `nodeVersion`, which was this case's original
  // subject: workers 2-6 on v24.19.0, workers 7-11 on v24.20.0, every other reported field identical, and
  // `npm run fleet:status` printed `fleet CONSISTENT across 10 of 10 -- these workers are interchangeable
  // for capture` over that split because the field it differed on was in no list `fleet-consistency` had.
  // The adapter split below is the live reading at 18:02Z the same day, on the field that stayed.
  //
  // DRIVEN THROUGH THE REAL `fleetStatus`, which is #1029's lesson and #1997's: the halves of this were
  // computed in `fleetStatus` and had to CROSS to the verdict, so a case that drove only the pure
  // function would hold the function and leave the crossing unheld.
  const split = await driveFleet(["ready", "ready", "ready", "ready"],
    (index) => ({ ...ENVIRONMENT, [ADAPTER]: index < 2 ? UHD : HD }));
  const agreed = await driveFleet(["ready", "ready", "ready", "ready"]);

  assert.match(agreed.verdict.line, /^fleet CONSISTENT across 4 of 4 — these workers are interchangeable/,
    "THE CONTROL: a fleet that agrees on every field still gets the plain sentence, so the rewrite below "
    + "is a reading of the guests rather than a line that always hedges");
  assert.doesNotMatch(split.verdict.line, /these workers are interchangeable for capture/,
    "not even as a substring -- #920's rule, because the word is what a reader takes away, and a caveat "
    + "appended after that clause leaves the claim in place");
  assert.match(split.verdict.line, /displayAdapter: .*UHD Graphics 630.*HD Graphics 630/,
    "NAMED with each guest's value: the drift is on the line, not merely counted on it");
  assert.ok(split.verdict.line.includes(
    `displayAdapter: a11y-worker-2=${UHD} a11y-worker-3=${UHD} a11y-worker-4=${HD} a11y-worker-5=${HD}`),
    "and LOCATED, every box of the four -- which box is on which adapter IS the remedy, and a line naming "
    + "only the two distinct VALUES would report drift without locating it");
});

test("#2063: THE RULING -- a reported-only split does NOT move the state", async () => {
  // `ceo`, 2026-09-23: report it, pin provisioning, and only then may it gate (#2170). `fieldCoverageGap`
  // turning the headline UNKNOWN is the sentence an operator reads as "do not start a run", so this
  // channel must not reach it either -- a drift that cannot refuse a capture through `capture-fleet-guard`
  // and does refuse it through the operator has only moved the gate to a human.
  const split = await driveFleet(["ready", "ready", "ready", "ready"],
    (index) => ({ ...ENVIRONMENT, [ADAPTER]: index < 2 ? UHD : HD }));
  assert.equal(split.verdict.state, "CONSISTENT", "the state is the gating channels' answer, and they agree");
  assert.equal(split.comparedAgree, true);
  assert.equal(split.consistent, true,
    "and the deprecated compatibility field follows it, so no script reading `--json` refuses either");
});

test("#2063: a reported-only field NOBODY reports reads as unknown on the line, and refuses nothing", async () => {
  // What `displayAdapter` read on every guest until the worker carrying it was deployed on 2026-09-23,
  // and what any field entering this channel reads on its first day -- clause 3 of #2063.
  // It must be neither a refusal nor silence: silence is the #1997 defect (compared on nobody reads as
  // agreed on by everybody) and a refusal would stop every capture in the project immediately.
  const { [ADAPTER]: removed, ...withoutAdapter } = ENVIRONMENT;
  assert.equal(typeof removed, "string", "the fixture must HOLD the adapter for deleting it to mean anything");
  const blind = await driveFleet(["ready", "ready", "ready", "ready"], withoutAdapter);

  assert.equal(blind.verdict.state, "CONSISTENT", "a field nobody reports in this channel gates nothing");
  assert.match(blind.verdict.line, /displayAdapter: not reported by any of 4 guests/,
    "and it is SAID, with its count -- the distinction #1997 drew for the gating channel");
  assert.doesNotMatch(blind.verdict.line, /these workers are interchangeable for capture/);
});

test("#2063: the channel reaches the JSON, so a caller can act on WHICH field and which box", async () => {
  // A conclusion that changes what happens next belongs in a field, not only in a sentence -- the same
  // argument #1997 made for `fields`. The remedy here is a provisioning converge of a named field on named
  // boxes, and a reader parsing `--json` cannot grep a prose line for it.
  const split = await driveFleet(["ready", "ready"],
    (index) => ({ ...ENVIRONMENT, [ADAPTER]: index === 0 ? UHD : HD }));
  assert.deepEqual(split.reportedOnly.map((d: { field: string, state: string }) => [d.field, d.state]),
    [[ADAPTER, "drifted"]]);
  assert.deepEqual(Object.values(split.reportedOnly[0].values), [UHD, HD]);

  // THE CONTROL: an agreeing fleet carries an empty list, so the field is a reading and not a constant.
  const agreed = await driveFleet(["ready", "ready"]);
  assert.deepEqual(agreed.reportedOnly, []);
});

test("#2063: an INCONSISTENT verdict keeps its own sentence and gains the drift as a clause", async () => {
  // The two findings must not be folded: INCONSISTENT says a run must not start, the drift clause says
  // the fleet is not identical and a run may proceed anyway. Appended rather than substituted here
  // because this line does not claim interchangeability in the first place -- there is nothing to retract.
  const both = await driveFleet(["ready", "ready"], (index) => ({
    ...ENVIRONMENT,
    browserVersion: index === 0 ? "152.0.4191.66" : "151.0.4129.59",
    [ADAPTER]: index === 0 ? UHD : HD,
  }));
  assert.equal(both.verdict.state, "INCONSISTENT");
  assert.match(both.verdict.line, /^fleet INCONSISTENT across 2 of 2 — browserVersion/,
    "the gating finding stays first and stays whole");
  assert.match(both.verdict.line, /Reported, never gated \(#2063\): displayAdapter/);
});

test("#2063: an omitted reportedOnly changes no verdict, which is the one default this file allows", () => {
  // `rows` and `fields` have no default because their absence is a GATING question left unasked, and
  // answering it permissively is how #1029 and #1997 happened. This channel is DEFINED as never gating,
  // so answering its absence pessimistically would hand a reported-only field the power over the verdict
  // that the ruling exists to withhold. Pinned, so the next reader does not "fix" the asymmetry.
  const input = { consistent: true, compared: 4, total: 4, rows: [], fields: comparedEverything(4) };
  assert.deepEqual(consistencyVerdict(input), consistencyVerdict({ ...input, reportedOnly: [] }));
  assert.equal(consistencyVerdict(input).state, "CONSISTENT");
});

// #2661 — the closing advice under INCONSISTENT depends on WHICH field disagreed. Driven through the REAL
// `fleetConsistency` and the real `inconsistentAdvice` `main` prints, not a copy of either string.
const mismatchesWhere = (field: string) => {
  const drifted = (n: number) => ({ ...box(n), environment: { ...box(n).environment, [field]: `differs-${n}` } });
  return fleetConsistency([box(2), drifted(3)]).mismatches;
};

test("only browserProfile differing: the advice does not say to re-provision, and names #2654", () => {
  const mismatches = mismatchesWhere("browserProfile");
  assert.deepEqual(mismatches.map((m) => m.field), ["browserProfile"], "the fixture must disagree on ONLY this");
  const advice = inconsistentAdvice(mismatches);
  assert.doesNotMatch(advice, /Re-provision/);
  assert.doesNotMatch(advice, /fleet:provision/);
  assert.match(advice, /differ by ORIGIN/);
  assert.match(advice, /cannot equalise/);
  assert.match(advice, /#2654/);
});

test("a field provisioning CAN converge differing: the advice is exactly what it always was", () => {
  const today = "  These guests are NOT interchangeable for capture, so a corpus run must not start: two\n"
    + "  workers on different values would share a cache key while producing different evidence.\n"
    + "  Re-provision the WHOLE fleet together — `npm run fleet:provision -- --serial=0`. Never one\n"
    + "  box alone: a lone re-provision splits the fleet rather than converging it.\n";
  for (const field of ["provisionRevision", "browserVersion"]) {
    const mismatches = mismatchesWhere(field);
    assert.deepEqual(mismatches.map((m) => m.field), [field], "the fixture must disagree on ONLY this");
    assert.equal(inconsistentAdvice(mismatches), today, field);
  }
});

test("browserProfile alongside a convergeable field keeps the re-provision advice", () => {
  // The convergeable part IS fixable by provisioning, so the profile must not silence the advice for it.
  const mismatches = [...mismatchesWhere("browserProfile"), ...mismatchesWhere("browserVersion")];
  assert.match(inconsistentAdvice(mismatches), /Re-provision the WHOLE fleet/);
});
