/**
 * ceo's ruling on #1356 (2026-09-18, option (b)): `doctor`/`worker:code` are PUBLISHED bins
 * (`@a11ign/screenreader-fleet`) that must never import `packages/control` -- `published-imports.test.ts`
 * forbids it, and ADR 0012 is why. This wrapper achieves the same operational outcome by setting
 * `A11Y_WORKERS` from the control plane before spawning the unchanged, published bin as a CHILD process
 * -- so these tests assert the ENV and ARGV the child receives, never the bin's own behaviour (that is
 * `doctor.mjs`/`check-worker-code.mjs`'s own test files' job).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withControlPlaneFleet, resolvePoolAtUseTime } from "./with-control-plane-fleet.mjs";

/** A fake `spawnSync` that records the call and returns a clean exit, never spawning anything real. */
function recordingRun(calls: unknown[][]) {
  return ((...args: unknown[]) => { calls.push(args); return { status: 0 }; }) as unknown as typeof import("node:child_process").spawnSync;
}

/** Every pinned address answers `/health` and no MAC is ever asked for: the healthy fleet, at no cost. */
const healthyFleet = (workers: Parameters<typeof resolvePoolAtUseTime>[0]) =>
  resolvePoolAtUseTime(workers, { probe: async () => true, macRead: () => { throw new Error("a healthy fleet asks nothing"); } });

test("with A11Y_WORKERS resolved from the control plane, the child sees it -- the bin itself never changes", async () => {
  const calls: unknown[][] = [];
  const { status, env } = await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", ["--json"], {
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" },
      { name: "a11y-worker-3", url: "http://192.0.2.3:8765" }] }),
    run: recordingRun(calls),
    resolvePool: healthyFleet,
    env: {},
  });
  assert.equal(status, 0);
  assert.equal(env.A11Y_WORKERS, "http://192.0.2.2:8765,http://192.0.2.3:8765");
  assert.deepEqual(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["packages/worker-fleet/src/doctor.mjs", "--json"], "argv is forwarded verbatim");
  assert.equal((calls[0][2] as { env: Record<string, string> }).env.A11Y_WORKERS,
    "http://192.0.2.2:8765,http://192.0.2.3:8765", "and the SAME env reaches the actual spawn call");
});

test("an operator's own A11Y_WORKER(S) is never overridden -- naming workers means managing them", async () => {
  const calls: unknown[][] = [];
  let readFleetCalled = false;
  const { env } = await withControlPlaneFleet("packages/worker-fleet/src/check-worker-code.mjs", [], {
    readFleet: () => { readFleetCalled = true; return { refusal: null, workers: [] }; },
    run: recordingRun(calls),
    env: { A11Y_WORKERS: "http://203.0.113.9:8765" },
  });
  assert.equal(readFleetCalled, false, "the control plane is never even asked when the operator already named workers");
  assert.equal(env.A11Y_WORKERS, "http://203.0.113.9:8765");
});

test("A11Y_WORKER (singular) also counts as already named", async () => {
  let readFleetCalled = false;
  await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
    readFleet: () => { readFleetCalled = true; return { refusal: null, workers: [] }; },
    run: recordingRun([]),
    env: { A11Y_WORKER: "http://203.0.113.9:8765" },
  });
  assert.equal(readFleetCalled, false);
});

test("a control-plane refusal WARNS and falls through to the bin's own default -- never a hard failure "
  + "for a read-only diagnostic", async () => {
  const calls: unknown[][] = [];
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as never;
  let result: Awaited<ReturnType<typeof withControlPlaneFleet>>;
  try {
    result = await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
      readFleet: () => ({ refusal: "no inventory exists at /etc/a11ign/inventory.yml on the control plane", workers: [] }),
      run: recordingRun(calls),
      env: {},
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(result.env.A11Y_WORKERS, undefined, "never set to an empty string -- that would be a NAMED empty fleet, a different claim from unset");
  assert.match(stderr, /could not ask the control plane for its inventory/);
  assert.match(stderr, /no inventory exists at \/etc\/a11ign\/inventory\.yml/);
  assert.equal(calls.length, 1, "the child still runs -- a diagnostic must not refuse to diagnose the thing it could not reach");
});

test("MUTATION TARGET: dropping the A11Y_WORKER(S)-already-named check would silently overwrite an "
  + "operator's own explicit choice with the control plane's", async () => {
  const { env } = await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-9", url: "http://192.0.2.9:8765" }] }),
    run: recordingRun([]),
    resolvePool: healthyFleet,
    env: { A11Y_WORKERS: "http://203.0.113.9:8765" },
  });
  assert.equal(env.A11Y_WORKERS, "http://203.0.113.9:8765", "must stay the operator's own value, not the control plane's");
});

// --- #2790: a moved worker is re-resolved by MAC where the address is USED ---------------------------------

const worker = (n: number, mac?: string) => ({ name: `a11y-worker-${n}`, url: `http://192.0.2.${n}:8765`, ...(mac ? { mac } : {}) });
const MAC_3 = "aa:bb:cc:00:00:03";

/** A probe that answers only at the listed URLs. */
const answersAt = (...urls: string[]) => async (url: string) => urls.includes(url);

/** A MAC reader that returns the same table on every read, recording what it was asked. */
function macTable(table: Record<string, string>, asked: unknown[][] = []) {
  return (candidates: { name: string }[]) => {
    asked.push(candidates.map((c) => c.name));
    return new Map(candidates.filter((c) => table[c.name]).map((c) => [c.name, table[c.name]]));
  };
}

test("#2790: a worker unreachable at its pin and present at another address by MAC is used at THAT address", async () => {
  const moved = "http://192.0.2.93:8765";
  const asked: unknown[][] = [];
  const resolved = await resolvePoolAtUseTime([worker(2, "aa:bb:cc:00:00:02"), worker(3, MAC_3)], {
    probe: answersAt("http://192.0.2.2:8765", moved),
    macRead: macTable({ "a11y-worker-3": "192.0.2.93" }, asked),
  });
  assert.deepEqual(resolved.pool, ["http://192.0.2.2:8765", moved], "the resolved address, not the pin, in the pin's slot");
  assert.deepEqual(resolved.moved, [{ name: "a11y-worker-3", from: "http://192.0.2.3:8765", to: moved }]);
  assert.deepEqual(resolved.missing, []);
  assert.deepEqual(asked, [["a11y-worker-3"], ["a11y-worker-3"]], "only the silent worker is asked, and asked twice");
});

test("#2790: a healthy fleet pays nothing -- no MAC read for a worker that answers at its pin", async () => {
  const resolved = await resolvePoolAtUseTime([worker(2, "aa:bb:cc:00:00:02"), worker(3, MAC_3)], {
    probe: async () => true,
    macRead: () => { throw new Error("must not be asked"); },
  });
  assert.deepEqual(resolved.pool, ["http://192.0.2.2:8765", "http://192.0.2.3:8765"]);
  assert.deepEqual(resolved.moved, []);
});

test("#2790: a worker missing entirely is named and left out, and the run carries on with the rest", async () => {
  const resolved = await resolvePoolAtUseTime([worker(2), worker(3, MAC_3), worker(4)], {
    probe: answersAt("http://192.0.2.4:8765"),
    macRead: macTable({}),
  });
  assert.deepEqual(resolved.pool, ["http://192.0.2.4:8765"]);
  assert.deepEqual(resolved.missing.map((m) => m.name), ["a11y-worker-2", "a11y-worker-3"]);
  assert.match(resolved.missing[0].why, /declares no mac/, "no MAC declared is its own reason");
  assert.match(resolved.missing[1].why, /not on the network segment/, "declared but not found is another");
});

test("#2790: a resolved address is never trusted on one read -- two reads that disagree leave the worker out", async () => {
  let reads = 0;
  const resolved = await resolvePoolAtUseTime([worker(3, MAC_3)], {
    probe: async (url) => url !== "http://192.0.2.3:8765", // silent at its pin, and anything else "answers"
    macRead: (candidates: { name: string }[]) => new Map(candidates.map((c) => [c.name, `192.0.2.${90 + reads++}`])),
  });
  assert.deepEqual(resolved.pool, []);
  assert.match(resolved.missing[0].why, /read as 192\.0\.2\.90 once and not again/);
});

test("#2790: a resolved address that does not answer /health is not used either", async () => {
  const resolved = await resolvePoolAtUseTime([worker(3, MAC_3)], {
    probe: answersAt(),
    macRead: macTable({ "a11y-worker-3": "192.0.2.93" }),
  });
  assert.deepEqual(resolved.pool, []);
  assert.match(resolved.missing[0].why, /nothing answers \/health there/);
});

test("#2790: the wrapper puts the moved address in A11Y_WORKERS and REPORTS the move and the missing worker by name", async () => {
  const written: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as never;
  let env: NodeJS.ProcessEnv;
  try {
    ({ env } = await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
      readFleet: () => ({ refusal: null, workers: [worker(2), worker(3, MAC_3), worker(4)] }),
      run: recordingRun([]),
      resolvePool: (workers) => resolvePoolAtUseTime(workers, {
        probe: answersAt("http://192.0.2.2:8765", "http://192.0.2.93:8765"),
        macRead: macTable({ "a11y-worker-3": "192.0.2.93" }),
      }),
      env: {},
    }));
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(env.A11Y_WORKERS, "http://192.0.2.2:8765,http://192.0.2.93:8765");
  const stderr = written.join("");
  assert.match(stderr, /MOVED a11y-worker-3: pinned http:\/\/192\.0\.2\.3:8765, answers by MAC at http:\/\/192\.0\.2\.93:8765/);
  assert.match(stderr, /MISSING a11y-worker-4 \(http:\/\/192\.0\.2\.4:8765\)/);
});

test("#2790: with NO worker left the wrapper refuses, says so, and never spawns the bin", async () => {
  const calls: unknown[][] = [];
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as never;
  let result: Awaited<ReturnType<typeof withControlPlaneFleet>>;
  try {
    result = await withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
      readFleet: () => ({ refusal: null, workers: [worker(2)] }),
      run: recordingRun(calls),
      resolvePool: (workers) => resolvePoolAtUseTime(workers, { probe: answersAt(), macRead: macTable({}) }),
      env: {},
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(result.status, 1);
  assert.equal(calls.length, 0, "the bin is not run against an empty pool");
  assert.equal(result.env.A11Y_WORKERS, undefined);
  assert.match(stderr, /no worker is left to run/);
  assert.match(stderr, /MISSING a11y-worker-2/);
});
