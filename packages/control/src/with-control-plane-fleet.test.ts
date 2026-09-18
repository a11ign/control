/**
 * ceo's ruling on #1356 (2026-09-18, option (b)): `doctor`/`worker:code` are PUBLISHED bins
 * (`@a11ign/worker-fleet`) that must never import `packages/control` -- `published-imports.test.ts`
 * forbids it, and ADR 0012 is why. This wrapper achieves the same operational outcome by setting
 * `A11Y_WORKERS` from the control plane before spawning the unchanged, published bin as a CHILD process
 * -- so these tests assert the ENV and ARGV the child receives, never the bin's own behaviour (that is
 * `doctor.mjs`/`check-worker-code.mjs`'s own test files' job).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withControlPlaneFleet } from "./with-control-plane-fleet.mjs";

/** A fake `spawnSync` that records the call and returns a clean exit, never spawning anything real. */
function recordingRun(calls: unknown[][]) {
  return ((...args: unknown[]) => { calls.push(args); return { status: 0 }; }) as unknown as typeof import("node:child_process").spawnSync;
}

test("with A11Y_WORKERS resolved from the control plane, the child sees it -- the bin itself never changes", () => {
  const calls: unknown[][] = [];
  const { status, env } = withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", ["--json"], {
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" },
      { name: "a11y-worker-3", url: "http://192.0.2.3:8765" }] }),
    run: recordingRun(calls),
    env: {},
  });
  assert.equal(status, 0);
  assert.equal(env.A11Y_WORKERS, "http://192.0.2.2:8765,http://192.0.2.3:8765");
  assert.deepEqual(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["packages/worker-fleet/src/doctor.mjs", "--json"], "argv is forwarded verbatim");
  assert.equal((calls[0][2] as { env: Record<string, string> }).env.A11Y_WORKERS,
    "http://192.0.2.2:8765,http://192.0.2.3:8765", "and the SAME env reaches the actual spawn call");
});

test("an operator's own A11Y_WORKER(S) is never overridden -- naming workers means managing them", () => {
  const calls: unknown[][] = [];
  let readFleetCalled = false;
  const { env } = withControlPlaneFleet("packages/worker-fleet/src/check-worker-code.mjs", [], {
    readFleet: () => { readFleetCalled = true; return { refusal: null, workers: [] }; },
    run: recordingRun(calls),
    env: { A11Y_WORKERS: "http://203.0.113.9:8765" },
  });
  assert.equal(readFleetCalled, false, "the control plane is never even asked when the operator already named workers");
  assert.equal(env.A11Y_WORKERS, "http://203.0.113.9:8765");
});

test("A11Y_WORKER (singular) also counts as already named", () => {
  let readFleetCalled = false;
  withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
    readFleet: () => { readFleetCalled = true; return { refusal: null, workers: [] }; },
    run: recordingRun([]),
    env: { A11Y_WORKER: "http://203.0.113.9:8765" },
  });
  assert.equal(readFleetCalled, false);
});

test("a control-plane refusal WARNS and falls through to the bin's own default -- never a hard failure "
  + "for a read-only diagnostic", () => {
  const calls: unknown[][] = [];
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as never;
  let result: ReturnType<typeof withControlPlaneFleet>;
  try {
    result = withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
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
  + "operator's own explicit choice with the control plane's", () => {
  const { env } = withControlPlaneFleet("packages/worker-fleet/src/doctor.mjs", [], {
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-9", url: "http://192.0.2.9:8765" }] }),
    run: recordingRun([]),
    env: { A11Y_WORKERS: "http://203.0.113.9:8765" },
  });
  assert.equal(env.A11Y_WORKERS, "http://203.0.113.9:8765", "must stay the operator's own value, not the control plane's");
});
