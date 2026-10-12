/**
 * THE COPIES IN `worker-fleet-carried.ts` ARE JUDGED AGAINST THEIR ORIGINALS, on the same inputs (a11ign#5184).
 *
 * `fleet-discover.ts`, `fleet-status.ts` and `with-control-plane-fleet.ts` no longer import `../../worker-fleet`, so the lab can load
 * `@a11ign/control/fleet-wake` from its own checkout. The price is a second copy of each helper, and a second copy is a second answer
 * the day one changes. `fleet-env.test.ts` in worker-fleet pins the same shape for its own `cli-flags` copy; this file does it for
 * control's, wherever the original is laid (control's CI lays it at `packages/worker-fleet`, and a checkout beside one has it too).
 *
 * THE ORIGINALS ARE IMPORTED HERE, in a test, which `control-has-no-dependencies.test.ts` does not walk: it follows the imports of
 * `src/*.ts` modules that ship to the control plane, and a test never does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as carried from "./worker-fleet-carried.ts";

const ORIGINALS = "../../worker-fleet/src/";
const original = async <T>(file: string): Promise<T> => import(`${ORIGINALS}${file}`) as Promise<T>;

const [http, env, flags, health, consistency] = await Promise.all([
  original<typeof import("../../worker-fleet/src/worker-http.ts")>("worker-http.ts"),
  original<typeof import("../../worker-fleet/src/fleet-env.ts")>("fleet-env.ts"),
  original<typeof import("../../worker-fleet/src/cli-flags.ts")>("cli-flags.ts"),
  original<typeof import("../../worker-fleet/src/worker-health.ts")>("worker-health.ts"),
  original<typeof import("../../worker-fleet/src/fleet-consistency.ts")>("fleet-consistency.ts"),
]);

test("the originals loaded and are the functions this file means to compare, so no test below compares nothing with nothing", () => {
  assert.equal(typeof http.requestJson, "function");
  assert.equal(typeof env.groupPerLine, "function");
  assert.equal(typeof flags.unknownFlags, "function");
  assert.equal(typeof health.assessWorker, "function");
  assert.equal(typeof consistency.fleetConsistency, "function");
  assert.notEqual(carried.requestJson, http.requestJson, "the copy IS the original: this module re-exports instead of carrying");
});

test("the three modules that carry no longer reach into worker-fleet, and each still imports something (the positive control)", () => {
  const modules = ["fleet-discover.ts", "fleet-status.ts", "with-control-plane-fleet.ts"];
  for (const module of modules) {
    const source = readFileSync(new URL(module, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((match) => match[1]);
    assert.ok(specifiers.some((specifier) => specifier.startsWith("./")), `${module}: no local import found, so the scan read nothing`);
    assert.deepEqual(specifiers.filter((specifier) => specifier.startsWith("../")), [], `${module} reaches out of this package`);
  }
});

test("the flag vocabulary: the same flags are unknown, the same one is suggested, the same value is read", () => {
  const known = ["--cidr=", "--port=", "--enroll", "--json"];
  const argvs = [
    ["--cidr=192.168.1", "--enroll"], ["--prot=1"], ["--enrol"], ["--", "--json", "-e", "x=1"],
    ["https://example.com", "--url=http://h?a=b"], [],
  ];
  for (const argv of argvs) {
    assert.deepEqual(carried.unknownFlags(argv, known), flags.unknownFlags(argv, known), JSON.stringify(argv));
    for (const flag of flags.unknownFlags(argv, known)) {
      assert.equal(carried.didYouMean(flag, known), flags.didYouMean(flag, known), flag);
    }
    assert.equal(carried.flagValue(argv, "url"), flags.flagValue(argv, "url"), JSON.stringify(argv));
  }
  assert.equal(carried.flagValue(["--url=http://h?a=b"], "url"), "http://h?a=b", "a value is kept whole at its own `=`");
});

test("worker health: the same verdict on the same vitals, at and either side of the judging threshold", () => {
  const vitals = [undefined, null, {}, { captures: 3, recoveries: 3 }, { captures: 4, recoveries: 2 }, { captures: 4, recoveries: 3 },
    { captures: 2, failures: 2, recoveries: 3 }];
  for (const v of vitals) assert.deepEqual(carried.assessWorker(v), health.assessWorker(v), JSON.stringify(v));
  for (const h of [undefined, null, {}, { busy: true }, { ready: false }, { busy: false, ready: true }]) {
    assert.equal(carried.workerIsUsable(h), health.workerIsUsable(h), JSON.stringify(h));
  }
  assert.equal(carried.assessWorker({ captures: 4, recoveries: 3 }).degraded, true, "the fixture does exercise the degraded branch");
});

test("fleet consistency: the same field lists and the same verdict on guests that differ", () => {
  assert.deepEqual(carried.MUST_MATCH, consistency.MUST_MATCH);
  assert.deepEqual(carried.REPORTED_ONLY, consistency.REPORTED_ONLY);
  assert.deepEqual(carried.POLICY_MUST_MATCH, consistency.POLICY_MUST_MATCH);
  const guests = [
    { worker: "http://10.0.0.2:8765", environment: { browserVersion: "150.0.1", windowsBuild: "26100.1" }, policy: { StartupBoostEnabled: 0 } },
    { worker: "http://10.0.0.3:8765", environment: { browserVersion: "151.0.2", windowsBuild: "26100.1" }, policy: { StartupBoostEnabled: 1 } },
    { worker: "http://10.0.0.4:8765" },
  ];
  // A dotted reported-only path (`edgeUpdaterGuard.state`, #5021) is read through the record, so a guard that differs shows and one that is
  // absent or not an object reads as "not reported".
  const guards = [
    { worker: "http://10.0.0.2:8765", environment: { edgeUpdaterGuard: { state: "disabled", checkedAt: "t1" } } },
    { worker: "http://10.0.0.3:8765", environment: { edgeUpdaterGuard: { state: "stale", checkedAt: "t2" } } },
    { worker: "http://10.0.0.4:8765", environment: { edgeUpdaterGuard: null } },
    { worker: "http://10.0.0.5:8765", environment: { edgeUpdaterGuard: "absent" } },
  ];
  for (const set of [guests, guests.slice(0, 1), guests.slice(0, 2), guards, guards.slice(2), []]) {
    const mine = carried.fleetConsistency(set);
    assert.deepEqual(mine, consistency.fleetConsistency(set), `${set.length} guests`);
    assert.deepEqual(carried.describeMismatches(mine.mismatches), consistency.describeMismatches(mine.mismatches));
    assert.deepEqual(carried.describeReportedOnly(mine.reportedOnly), consistency.describeReportedOnly(mine.reportedOnly));
  }
  assert.equal(carried.fleetConsistency(guests).consistent, false, "the fixture does exercise a mismatch");
  assert.ok(carried.fleetConsistency(guards).reportedOnly.some((entry) => entry.field === "edgeUpdaterGuard.state"),
    "the fixture does exercise the dotted path, so the reported-only list is not compared empty with empty");
});

test("the inventory group reader: the same group on every line, and the same group name", () => {
  assert.equal(carried.WORKER_GROUP, env.WORKER_GROUP);
  const inventory = [
    "all:", "  children:", "    a11y_workers:", "      hosts:", "        a11y-worker-2:", "          ansible_host: 10.0.0.2",
    "    lab:", "      hosts:", "        lab-1:", "          ansible_host: 10.0.0.9", "", "# a comment", "",
  ].join("\n");
  assert.deepEqual(carried.groupPerLine(inventory), env.groupPerLine(inventory));
  assert.ok(carried.groupPerLine(inventory).includes(carried.WORKER_GROUP), "the fixture does place a line in the worker group");
});

test("the environment's fleet and the address check: the same workers, and the same refusal text", () => {
  const saved = { workers: process.env.A11Y_WORKERS, worker: process.env.A11Y_WORKER };
  try {
    for (const [workers, worker] of [["http://10.0.0.2:8765/, http://10.0.0.3:8765", undefined], [undefined, "http://10.0.0.4:8765"], [undefined, undefined]]) {
      if (workers === undefined) delete process.env.A11Y_WORKERS; else process.env.A11Y_WORKERS = workers;
      if (worker === undefined) delete process.env.A11Y_WORKER; else process.env.A11Y_WORKER = worker;
      assert.deepEqual(carried.configuredWorkers(), env.configuredWorkers(), `${workers} / ${worker}`);
    }
    process.env.A11Y_WORKERS = "http://:8765";
    const refusal = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return undefined; };
    const mine = refusal(() => carried.configuredWorkers());
    assert.ok(mine, "an empty host is refused");
    assert.equal(mine, refusal(() => env.configuredWorkers()));
  } finally {
    if (saved.workers === undefined) delete process.env.A11Y_WORKERS; else process.env.A11Y_WORKERS = saved.workers;
    if (saved.worker === undefined) delete process.env.A11Y_WORKER; else process.env.A11Y_WORKER = saved.worker;
  }
  for (const value of ["http://10.0.0.2:8765/", "ftp://x", "", "nonsense"]) {
    const outcome = (assertWorkerUrl: typeof carried.assertWorkerUrl) => { try { return assertWorkerUrl(value); } catch (error) { return (error as Error).message; } };
    assert.equal(outcome(carried.assertWorkerUrl), outcome(http.assertWorkerUrl), JSON.stringify(value));
  }
});

/** One worker-shaped server: `/health` answers JSON, `/text` a non-JSON error page, `/stall` accepts and never answers. */
function listen(): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    if (request.url === "/stall") return;
    if (request.url === "/text") { response.writeHead(503, { "content-type": "text/plain" }); response.end("busy page"); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ busy: false, ready: true, method: request.method }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  }));
}

test("requestJson: the same status, ok flag, text and parsed body, and the same timeout code, against a real server", async () => {
  const { server, base } = await listen();
  try {
    for (const path of ["/health", "/text"]) {
      const mine = await carried.requestJson(`${base}${path}`, { timeoutMs: 2_000 });
      assert.deepEqual(mine, await http.requestJson(`${base}${path}`, { timeoutMs: 2_000 }), path);
    }
    const posted = await carried.requestJson(`${base}/health`, { method: "POST", body: { a: 1 }, timeoutMs: 2_000 });
    assert.equal(posted.json.method, "POST", "a body-carrying request keeps its method");
    const code = async (request: typeof carried.requestJson) => {
      try { await request(`${base}/stall`, { timeoutMs: 100 }); } catch (error) { return (error as NodeJS.ErrnoException).code; }
      return undefined;
    };
    assert.equal(await code(carried.requestJson), "ETIMEDOUT", "a worker that accepts and never answers is cut at the TOTAL deadline");
    assert.equal(await code(carried.requestJson), await code(http.requestJson));
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
