// `fleet:status` answers "what are my boxes doing", so the tests are about the states it must keep
// APART. A status table that shows a dying worker as healthy, or a missing one as idle, is worse than no
// table at all — it is the "two states reported as one" shape this project keeps paying for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { stateOf, activityOf, summarise, degradedAdvice, consistencyVerdict, fleetStatus, LINK, linkVerdictOf,
  readLinkLayer, neighbourScript, renderHead, failedRead, fleetToProbe } from "./fleet-status.mjs";
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

/**
 * The verdict `fleetStatus` would print over these guests, out of an inventory of `total`.
 *
 * `rows` is supplied all-ready because these cases are about the ENVIRONMENT comparison; #1029 made a
 * missing `rows` UNKNOWN rather than CONSISTENT, so passing it is what keeps these tests about the thing
 * they are about instead of about readiness.
 */
const verdictOver = (guests: ReturnType<typeof box>[], total: number) => {
  const { consistent, mismatches, compared } = fleetConsistency(guests);
  const rows = guests.map((g) => ({ name: g.worker, state: "ready" }));
  return consistencyVerdict({ consistent, compared, total, mismatches, rows });
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

const ENVIRONMENT = { windows: "10.0.26100", arch: "x64", nvda: "2024.4", edge: "152.0.1", provisionRevision: "r7" };

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

const driveFleet = (states: ("ready" | "busy" | "warming" | "unreachable")[]) => {
  const workers = states.map((_, i) => ({ name: `a11y-worker-${i + 2}`, url: `http://a11y-worker-${i + 2}:8765` }));
  return fleetStatus({
    workers: () => workers,
    probe: async (w) => fakeProbe(w.name, states[workers.indexOf(w)]),
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
  assert.equal(consistencyVerdict({ consistent: true, compared: 4, total: 4, rows: [] }).state, "CONSISTENT",
    "and an EXPLICIT empty list is a different statement from no list at all: it says the caller asked "
    + "and found nobody blocked, which is exactly the distinction `undefined` versus `[]` exists to make");
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
