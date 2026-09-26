/**
 * #2655: does a job that puts a capture on a worker WAKE exactly the workers it needs, and wait for them,
 * before it dispatches?
 *
 * The seam is `lab-job.mjs`'s `run`, which every path that reaches the lab goes through: `lab:pipeline`
 * shells to `npm run lab:job`, and the gates' `dispatchUnlessLocal` does too. Nothing here reads a network
 * or a control plane: `wake`, `checkFleet`, `readFleet` and `dispatch` are all fakes, and `process.exit` is
 * replaced for the refusals so the test runner cannot die with the function under test.
 *
 * THE PATHS THAT PUT A CAPTURE ON A WORKER, read from the code (the row carries the full table):
 *   through `lab:job` (wakes now):   every catalogue job that names a worker -- the fleet jobs, `capture-only`
 *                                     with a selection, and the diagnostics `stability`/`gate-stability`/
 *                                     `capture-check`/`evidence-check`
 *   NOT through `lab:job` (routed):   a `--local` gate run, `training:capture` and `capture-real-pages` run by
 *                                     hand, and `witness`'s own worker; none of them is in this file's Region
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readControlPlaneFleet } from "./control-plane-fleet.mjs";
import { captureBearingJobs, neededWorkers, run, wakeNeeded, wakeRefusal, workerDemand } from "./lab-job.mjs";

const CATALOGUE = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");
const LAB_JOB_SOURCE = readFileSync(fileURLToPath(new URL("./lab-job.mjs", import.meta.url)), "utf8");

const FLEET = ["a11y-worker-2", "a11y-worker-3", "a11y-worker-4", "a11y-worker-5", "a11y-worker-6"]
  .map((name, i) => ({ name, url: `http://192.0.2.${i + 2}:8765` }));
const state = (name: string, s: string) => ({ name, host: name, state: s });

/** Run `run()` with every dependency faked; returns what happened in order. `process.exit` is captured. */
async function drive(argv: string[], wakeStates: (needed: { name: string }[]) => { name: string; host: string; state: string }[]) {
  const events: string[] = [];
  let woken: string[] = [];
  let checkedPool: string[] = [];
  let exited: number | undefined;
  const realExit = process.exit;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exit = ((code: number) => { exited = code; throw new Error(`exit ${code}`); }) as typeof process.exit;
  try {
    await run(argv, {
      catalogueText: CATALOGUE, expected: "deadbeefdeadbeef",
      readFleet: () => ({ refusal: null, workers: FLEET }),
      wake: async (needed) => { events.push("wake"); woken = needed.map((w) => w.name); return wakeStates(needed); },
      checkFleet: async (_expected, pool) => { events.push("check"); checkedPool = pool as string[]; },
      dispatch: () => { events.push("dispatch"); },
    });
  } catch (error) {
    if (!/^exit \d$/.test((error as Error).message)) throw error;
  } finally {
    process.exit = realExit;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { events, woken, checkedPool, exited };
}
const allUp = (needed: { name: string }[]) => needed.map((w) => state(w.name, "woken"));

test("workerDemand is DERIVED from the catalogue, and finds every job that names a worker (positive control included)", () => {
  const demanding = ["capture", "capture-only", "capture-real-pages", "evidence-check", "capture-check", "stability", "gate-stability"];
  for (const job of demanding) assert.notEqual(workerDemand(CATALOGUE, job), null, `${job} puts captures on workers`);
  for (const job of ["train", "rules-gate", "export", "inventory"]) {
    assert.equal(workerDemand(CATALOGUE, job), null, `${job} touches no worker, so it must not wake any`);
  }
  // Every job the staleness check protects is one a wake protects, or a stale-checked job could find a dark pool.
  for (const job of captureBearingJobs(CATALOGUE)) assert.notEqual(workerDemand(CATALOGUE, job), null, job);
  // The whole real table, pinned: a comment naming `lab_fleet_workers` is not demand (the review of #2681).
  const table = Object.fromEntries(["capture-real-pages", "capture-only", "capture", "retrain", "capture-acceptance",
    "capture-acceptance-2", "stability", "everything", "gate-stability", "capture-check", "evidence-check"]
    .map((job) => [job, workerDemand(CATALOGUE, job)]));
  const F = { fleet: true, selectable: false, named: false };
  assert.deepEqual(table, {
    "capture-real-pages": F, "capture-only": { fleet: false, selectable: true, named: false }, capture: F, retrain: F,
    "capture-acceptance": F, "capture-acceptance-2": F, everything: F,
    stability: { fleet: false, selectable: false, named: true }, "gate-stability": { fleet: false, selectable: false, named: true },
    "capture-check": { fleet: false, selectable: false, named: true }, "evidence-check": { fleet: true, selectable: false, named: true },
  });
});

test("neededWorkers: a count wakes the FIRST N in inventory order, names wake those names, nothing wakes the fleet", () => {
  const demand = { fleet: true, selectable: true, named: false };
  const three = neededWorkers(demand, { workers: "3" }, FLEET);
  assert.deepEqual(three.refusal === null && three.needed.map((w) => w.name), FLEET.slice(0, 3).map((w) => w.name));
  const named = neededWorkers(demand, { workers: "a11y-worker-5, a11y-worker-2" }, FLEET);
  assert.deepEqual(named.refusal === null && named.needed.map((w) => w.name), ["a11y-worker-2", "a11y-worker-5"]);
  const all = neededWorkers(demand, {}, FLEET);
  assert.equal(all.refusal === null && all.needed.length, FLEET.length);
  for (const bad of [{ workers: "0" }, { workers: "6" }, { workers: "a11y-worker-99" }, { workers: "," }]) {
    assert.notEqual(neededWorkers(demand, bad, FLEET).refusal, null, `${JSON.stringify(bad)} names a pool the fleet cannot give`);
  }
  const one = neededWorkers({ fleet: false, selectable: false, named: true }, { worker: "a11y-worker-4" }, FLEET);
  assert.deepEqual(one.refusal === null && one.needed.map((w) => w.name), ["a11y-worker-4"]);
  const none = neededWorkers({ fleet: false, selectable: false, named: true }, {}, FLEET);
  assert.deepEqual(none.refusal === null && none.needed, [], "a required `worker=` that is missing is the playbook's refusal to make");
});

test("a job needing THREE workers wakes three, BEFORE the staleness check, and checks that same pool", async () => {
  const seen = await drive(["-e", "job=capture-only", "-e", "workers=3", "-e", "only=x"], allUp);
  assert.deepEqual(seen.events, ["wake", "check", "dispatch"], "wake first, then check, then dispatch");
  assert.deepEqual(seen.woken, FLEET.slice(0, 3).map((w) => w.name), "three woken, not the fleet");
  assert.deepEqual(seen.checkedPool, FLEET.slice(0, 3).map((w) => w.url), "the check reads the pool the job will use");
});

test("a whole-fleet job wakes the whole fleet", async () => {
  const seen = await drive(["-e", "job=capture", "-e", "only=x"], allUp);
  assert.equal(seen.woken.length, FLEET.length);
});

test("a diagnostic still wakes its worker, but is not STALENESS-checked (a stale one must not stop it)", async () => {
  const seen = await drive(["-e", "job=capture-check", "-e", "worker=a11y-worker-4"], allUp);
  assert.deepEqual(seen.events, ["wake", "dispatch"]);
  assert.deepEqual(seen.woken, ["a11y-worker-4"]);
});

test("a REQUIRED `worker=` that is missing wakes NOTHING: the playbook refuses it, and its header comment naming the fleet is not demand", async () => {
  for (const job of ["capture-check", "stability", "gate-stability"]) {
    const seen = await drive(["-e", `job=${job}`], allUp);
    assert.deepEqual(seen.woken, [], `${job} with no worker= must not wake the fleet`);
  }
});

test("a job that touches no worker wakes none and reads no fleet; describe-only wakes none", async () => {
  assert.deepEqual((await drive(["-e", "job=train", "-e", "out=varied"], allUp)).events, ["dispatch"]);
  assert.deepEqual((await drive(["-e", "job=capture", "-e", "describe=1"], allUp)).events, ["dispatch"]);
});

test("a job that NAMED its pool is refused when one of them did not come up, and never dispatches", async () => {
  const seen = await drive(["-e", "job=capture-only", "-e", "workers=3", "-e", "only=x"],
    (needed) => needed.map((w, i) => state(w.name, i === 1 ? "no-answer" : "woken")));
  assert.equal(seen.exited, 3);
  assert.deepEqual(seen.events, ["wake"], "neither the check nor the dispatch may run after the refusal");
});

test("a whole-fleet job PROCEEDS with the workers that came up, and refuses only when none did", async () => {
  const some = await drive(["-e", "job=capture", "-e", "only=x"],
    (needed) => needed.map((w, i) => state(w.name, i === 0 ? "no-mac" : "already-up")));
  assert.equal(some.exited, undefined);
  assert.deepEqual(some.events, ["wake", "check", "dispatch"]);
  const none = await drive(["-e", "job=capture", "-e", "only=x"], (needed) => needed.map((w) => state(w.name, "no-answer")));
  assert.equal(none.exited, 3);
  assert.deepEqual(none.events, ["wake"]);
});

test("wakeRefusal: a busy worker is fine, and the refusal names each worker that did not come", () => {
  assert.equal(wakeRefusal([state("a", "busy"), state("b", "already-up"), state("c", "came-up")], true), null);
  const refusal = wakeRefusal([state("a", "woken"), state("b", "never-ready"), state("c", "no-mac")], true);
  assert.match(String(refusal), /2 of the 3/);
  assert.match(String(refusal), /\bb\b[\s\S]*\bc\b/);
});

test("with no `wake` handed to run() nothing is woken -- only the command-line entry wires the real one", async () => {
  const events: string[] = [];
  await run(["-e", "job=capture", "-e", "only=x"], {
    catalogueText: CATALOGUE, expected: "deadbeefdeadbeef",
    readFleet: () => ({ refusal: null, workers: FLEET }),
    checkFleet: async () => { events.push("check"); }, dispatch: () => { events.push("dispatch"); },
  });
  assert.deepEqual(events, ["check", "dispatch"]);
  // ...and the real entry DOES wire it. This pin is the positive control for the test above.
  assert.match(LAB_JOB_SOURCE, /await run\(process\.argv\.slice\(2\), \{ wake: wakeNeeded \}\)/);
});

test("wakeNeeded hands the wake the mac each worker CARRIES, and null for one whose inventory entry declares none", async () => {
  let targets: unknown[] = [];
  await wakeNeeded([{ ...FLEET[0], mac: "aa:bb:cc:dd:ee:01" }, { name: "stranger", url: "http://198.51.100.9:8765" }], {
    wake: async (t) => { targets = t; return []; },
  });
  assert.deepEqual(targets, [
    { name: "a11y-worker-2", host: "192.0.2.2", mac: "aa:bb:cc:dd:ee:01" },
    { name: "stranger", host: "198.51.100.9", mac: null },
  ]);
});

test("the mac reaches the wake through the ONE inventory read: readControlPlaneFleet carries it, and a run never reads a second inventory", () => {
  const inventory = ["all:", "  children:", "    a11y_workers:", "      hosts:",
    "        a11y-worker-2:", "          ansible_host: 192.0.2.2", "          mac: AA-BB-CC-DD-EE-01",
    "        a11y-worker-3:", "          ansible_host: 192.0.2.3"].join("\n") + "\n";
  let reads = 0;
  const { workers } = readControlPlaneFleet({
    ansibleCfgText: "[defaults]\ninventory = /etc/a11ign/inventory.yml\n", groupVarsText: "a11y_port: 8765\n",
    readInventories: (sources) => { reads += 1; return [{ path: sources[0], text: inventory }]; },
  });
  assert.equal(reads, 1);
  assert.deepEqual(workers, [
    { name: "a11y-worker-2", url: "http://192.0.2.2:8765", mac: "aa:bb:cc:dd:ee:01" },
    { name: "a11y-worker-3", url: "http://192.0.2.3:8765" },
  ]);
  assert.doesNotMatch(LAB_JOB_SOURCE, /sshToControlPlane|inventoryReadScript/, "no second read of the inventory in lab-job.mjs");
});
