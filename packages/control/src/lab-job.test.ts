/**
 * Does `lab:job` refuse a CAPTURE-BEARING job before dispatching to the lab at all?
 *
 * The fault being closed: `npm run lab:job -- -e job=capture-acceptance` used to be a bare
 * `ansible-playbook` call. It dispatches over the lab's own SSH key, the lab starts the job, and the
 * job's own script runs `assertFleetRunsThisCheckout` — THIRTY SECONDS LATER, telling you to run
 * `fleet:deploy`. Correct and one round trip too late.
 *
 * These tests deliberately never call `run()` in a way that reaches a real fleet, a real
 * `ansible-playbook`, or a real `process.exit` — the same discipline `worker-code-check.test.ts` states
 * for the identical reason: a function built to be asserted on cannot let the test runner die with it.
 * `checkFleet` and `dispatch` are swapped for fakes throughout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { captureBearingJobs, extraVars, run } from "./lab-job.mjs";

const CATALOGUE = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");

test("-e job=<name> is read regardless of what else is on the line", () => {
  assert.deepEqual(extraVars(["-e", "job=train"]), { job: "train" });
  assert.deepEqual(extraVars(["-e", "job=capture-only", "-e", "only=route-title-stale+"]),
    { job: "capture-only", only: "route-title-stale+" });
  assert.deepEqual(extraVars(["--extra-vars", "job=stability", "-e", "worker=a11y-worker-2"]),
    { job: "stability", worker: "a11y-worker-2" });
});

test("no -e job= at all reads as no job — the same malformed invocation lab-job.yml already refuses", () => {
  assert.deepEqual(extraVars([]), {});
  assert.deepEqual(extraVars(["-e"]), {});
  assert.deepEqual(extraVars(["--allow-stale-workers"]), {});
});

test("the capture-bearing jobs are exactly these, against the real catalogue", () => {
  // Pinned by MEMBERSHIP, not just count — the same reasoning `asserting-subtypes.test.ts` gives: two
  // numbers can stay right while the wrong job moves into or out of the set, and this is the strongest
  // claim this file makes (which job gets a fleet check before it can waste a lab dispatch).
  assert.deepEqual([...captureBearingJobs(CATALOGUE)].sort(), [
    "capture", "capture-acceptance", "capture-acceptance-2", "capture-only", "capture-real-pages",
    "everything", "retrain",
  ].sort(),
  "the set of jobs that dispatch real captures across the fleet changed. Each one runs "
    + "capture-real-pages.mjs or capture-screenreader-dataset.mjs, directly or through its own chain "
    + "(retrain -> training:capture, everything -> retrain) -- update this list with the reason, not just "
    + "the membership.");
});

test("stability, gate-stability and evidence-check are NOT capture-bearing — they are diagnostics", () => {
  // The asymmetry `worker-code-check.test.ts` already states: "a diagnostic must NEVER be the thing that
  // takes the pool offline." A stale worker under one of these costs a wrong verdict on one invocation; a
  // stale worker under a corpus writer costs 2,122 captures indistinguishable from current ones for ever.
  // Refusing these too would make every developer typing `-e job=stability` need a healthy ten-box fleet
  // for a gate that only ever touches ONE named worker -- exactly the over-broad guard that gets routed
  // around until the override is the habit.
  const jobs = captureBearingJobs(CATALOGUE);
  for (const name of ["stability", "gate-stability", "evidence-check", "gate-probe-order"]) {
    assert.ok(!jobs.includes(name), `${name} must not be classified as capture-bearing`);
  }
});

test("an ordinary job the fleet never touches is unaffected", () => {
  const jobs = captureBearingJobs(CATALOGUE);
  for (const name of ["train", "sweep", "rules-gate", "rules-coverage", "promote", "check-signals"]) {
    assert.ok(!jobs.includes(name), `${name} does not touch a worker and must not be gated`);
  }
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  assert.ok(captureBearingJobs(CATALOGUE).length >= 5,
    "found too few capture-bearing jobs; the indentation scan is broken, not the catalogue empty");
});

test("a renamed setenv key or a re-indented catalogue is refused, not silently read as empty", () => {
  // MUTATION CHECK on the ARTEFACT this derivation depends on, not the doc: rename the fact it looks for,
  // and confirm the scan notices rather than quietly returning zero.
  // RENAME THE FACT, not one spelling of it. This replaced the verbatim `A11Y_WORKERS={{ lab_fleet_workers
  // }}` only, so a job computing its pool FROM the fleet -- `capture-only` slicing it for a `workers` cap --
  // survived the rename and the mutation reported the derivation broken when it was the mutation that was
  // narrow. The derivation keys on the fact appearing inside an `A11Y_WORKERS=` template; so must this.
  const renamed = CATALOGUE.replace(/lab_(fleet|selected)_workers/g, "pool");
  assert.deepEqual(captureBearingJobs(renamed), [],
    "renaming the fact every entry keys on must drop every job, or this scan is reading something else");

  const reindented = CATALOGUE.replace(/\n {6}capture:\n/, "\n        capture:\n");
  assert.ok(!captureBearingJobs(reindented).includes("capture"),
    "re-indenting one job's header must drop it from the set rather than silently keep matching");
});

test("the catalogue boundary markers are load-bearing, and their absence is refused loudly", () => {
  assert.throws(() => captureBearingJobs("no catalogue markers here at all"),
    /could not find lab_jobs/, "an unrecognisable file must throw, not return an empty or partial list");
});

test("a capture-bearing job checks the fleet BEFORE dispatching, with the pool it will actually use", () => {
  const seen: { checked?: unknown[]; dispatched?: unknown[] } = {};
  const order: string[] = [];
  return run(["-e", "job=capture-only", "-e", "only=route-title-stale+"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765", "http://203.0.113.59:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async (expected, workers, options) => {
      order.push("checked");
      seen.checked = [expected, workers, options];
    },
    dispatch: (forwarded) => {
      order.push("dispatched");
      seen.dispatched = forwarded;
    },
  }).then(() => {
    assert.deepEqual(order, ["checked", "dispatched"], "the fleet must be checked before anything dispatches");
    assert.equal(seen.checked?.[0], "deadbeefdeadbeef");
    assert.deepEqual(seen.checked?.[1], ["http://203.0.113.107:8765", "http://203.0.113.59:8765"]);
    assert.equal((seen.checked?.[2] as { when?: string })?.when, "before dispatching to the lab");
    assert.deepEqual(seen.dispatched, ["-e", "job=capture-only", "-e", "only=route-title-stale+"]);
  });
});

test("a refusing check stops the job from ever reaching dispatch", () => {
  // Simulates what `assertWorkersServe` does for real: it exits the process on refusal, which never
  // returns. A fake that THROWS is the safe proxy for "does not return normally" — real `process.exit`
  // cannot be exercised here without risking the test runner, the same reason worker-code-check.test.ts
  // never calls the exiting function directly.
  let dispatched = false;
  return run(["-e", "job=capture"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async () => { throw new Error("FLEET IS NOT RUNNING THIS CHECKOUT"); },
    dispatch: () => { dispatched = true; },
  }).then(
    () => assert.fail("run() must propagate a refusing check rather than continuing to dispatch"),
    (error: Error) => {
      assert.match(error.message, /FLEET IS NOT RUNNING THIS CHECKOUT/);
      assert.equal(dispatched, false, "dispatch must never run after the check refuses");
    },
  );
});

test("a non-capture-bearing job never checks the fleet at all, and dispatches unaffected", () => {
  let checked = false;
  let dispatched: string[] | undefined;
  return run(["-e", "job=train", "-e", "out=varied"], {
    catalogueText: CATALOGUE,
    workers: [],
    expected: "irrelevant",
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false, "train touches no worker and must never trigger a fleet check");
    assert.deepEqual(dispatched, ["-e", "job=train", "-e", "out=varied"]);
  });
});

test("-e describe=1 skips the fleet check too — nothing is about to run", () => {
  let checked = false;
  return run(["-e", "job=capture", "-e", "describe=1"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async () => { checked = true; },
    dispatch: () => {},
  }).then(() => {
    assert.equal(checked, false,
      "-e describe=1 ends the play before anything runs, so checking ten boxes over HTTP first answers "
      + "nothing the operator asked for");
  });
});

test("--allow-stale-workers reaches the check as `allow: true` and is stripped before dispatch", () => {
  let allow: unknown;
  let dispatched: string[] | undefined;
  return run(["-e", "job=capture", "--allow-stale-workers"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async (_expected, _workers, options: { allow?: boolean }) => { allow = options.allow; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(allow, true);
    // `ansible-playbook` does not recognise this flag and would refuse the whole command line with it
    // still attached, so it must never reach the forwarded argv.
    assert.deepEqual(dispatched, ["-e", "job=capture"]);
  });
});

test("a non-capture job never reads the real inventory or hashes the worker source", () => {
  // `workers`/`expected` are left undefined in `run`'s defaults deliberately -- resolving either costs a
  // real `inventory.yml` read or a real directory hash, and `train` should not pay for either. Calling
  // this with NEITHER `workers` NOR `expected` supplied proves it: if `run` fell back to computing them
  // eagerly, this would hit the real filesystem/hash unconditionally rather than skip it.
  let checked = false;
  let dispatched: string[] | undefined;
  return run(["-e", "job=train", "-e", "out=varied"], {
    catalogueText: CATALOGUE,
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false);
    assert.deepEqual(dispatched, ["-e", "job=train", "-e", "out=varied"]);
  });
});

test("no -e job= at all runs straight to dispatch — the same as no job was ever passed", () => {
  let checked = false;
  let dispatched: string[] | undefined;
  return run([], {
    catalogueText: CATALOGUE,
    workers: [],
    expected: "irrelevant",
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false);
    assert.deepEqual(dispatched, []);
  });
});
