// The magic packet is the entire mechanism, and it is the one part that cannot be tested against a real
// machine from here — so it is tested against the specification instead. A wrong packet fails silently:
// the box simply never wakes, which is indistinguishable from a firmware setting being off.
import { test } from "node:test";
import assert from "node:assert/strict";

import { HEALTH_TIMEOUT_MS, WAKE_DEADLINE_MS, magicPacket, probeWorker, wakeFleet, wakeReportLine } from "./fleet-wake.mjs";

test("a magic packet is 6 x 0xFF then the MAC sixteen times", () => {
  const packet = magicPacket("00:1a:2b:3c:4d:5e");
  assert.equal(packet.length, 102, "6 + 16 * 6");
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < 16; i += 1) {
    assert.deepEqual([...packet.subarray(6 + i * 6, 12 + i * 6)], [0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e],
      `repetition ${i} must be the target MAC`);
  }
});

test("separator and case do not matter — the same machine is the same packet", () => {
  // inventory.yml is hand-edited and a MAC gets pasted in whatever form the firmware showed it.
  const canonical = magicPacket("00:1a:2b:3c:4d:5e");
  for (const form of ["00-1A-2B-3C-4D-5E", "001a2b3c4d5e", "00:1A:2b:3C:4d:5E"]) {
    assert.deepEqual(magicPacket(form), canonical, `${form} should build the same packet`);
  }
});

test("anything that is not a MAC is refused, not padded into a packet nobody will answer", () => {
  // Silently sending a malformed packet is the worst outcome: it looks like it worked and the box never
  // comes back, which reads as a firmware problem on a machine you may have to walk to.
  for (const bad of ["", "not-a-mac", "00:1a:2b:3c:4d", "00:1a:2b:3c:4d:5e:6f"]) {
    assert.throws(() => magicPacket(bad), /not a MAC address/, `${bad} should be refused`);
  }
});

// #1683's own "durable copy first" tests moved to control-plane-fleet.test.ts -- `inventoryPathFor` now
// lives there (shared with fleet-discover.mjs, #1684), not restated here.

// ---------------------------------------------------------------------------------------------------
// #2655: wake exactly what is needed, WAIT FOR READY, and never mistake a slow box for a down one.
//
// Everything below is offline by injection: `request` stands in for the `/health` read, `send` for the
// UDP socket, and `sleep`/`now` for the clock, so no network is read and no time passes.
// ---------------------------------------------------------------------------------------------------

type Step = { delayMs?: number; status?: number; json?: unknown; code?: string; message?: string };

/** A `/health` stand-in: per host, a script of steps; the last step repeats. Honours the caller's timeout. */
function fakeHealth(script: Record<string, Step[]>) {
  const calls: string[] = [];
  const timeouts: number[] = [];
  const request = async (url: string, { timeoutMs = 30_000 }: { timeoutMs?: number } = {}) => {
    const host = new URL(url).hostname;
    calls.push(host);
    timeouts.push(timeoutMs);
    const steps = script[host] ?? [{ delayMs: Infinity }];
    const step = steps[Math.min(calls.filter((c) => c === host).length - 1, steps.length - 1)];
    if (step.code) throw Object.assign(new Error(step.message ?? step.code), { code: step.code });
    if ((step.delayMs ?? 0) > timeoutMs) {
      throw Object.assign(new Error(`Request to ${url} timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT" });
    }
    const status = step.status ?? 200;
    return { status, ok: status >= 200 && status < 300, text: "", json: step.json };
  };
  return { request, calls, timeouts };
}

/** A clock that only moves when the code sleeps, and a socket that records who was sent a packet. */
function fakeWorld() {
  let clock = 0;
  const sent: string[] = [];
  return {
    sent,
    sleepCalls: () => clock,
    options: {
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      send: async (mac: string) => { sent.push(mac); return 3; },
    },
  };
}

const SLOW_HEALTHY_MS = 3_100;
const OLD_PROBE_MS = 2_000;
const READY = { ok: true, ready: true, busy: false };
const workers = (...names: string[]) => names.map((name, i) => ({ name, host: `192.0.2.${i + 1}`, mac: `aa:bb:cc:dd:ee:0${i + 1}` }));

test("#2655 5.5: a healthy box answering in 3.1 s -- slower than the old 2 s probe, faster than T -- is UP and is sent NO packet", async () => {
  // 3.09 s is the slowest healthy first-after-idle reading on the real fleet (#2671); 3.1 s is that plus a hair.
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: SLOW_HEALTHY_MS, json: READY }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request });
  assert.equal(r.state, "already-up");
  assert.equal(world.sent.length, 0, "a slow answer is not a down box, so it is not woken");
  assert.ok(SLOW_HEALTHY_MS > OLD_PROBE_MS && SLOW_HEALTHY_MS < HEALTH_TIMEOUT_MS,
    "the stub sits between the old 2 s and T, or it proves nothing");
});

test("#2655 5.1: T clears a LOADED box (about 10 s: two synchronous PowerShell calls, each bounded at 5 s) too", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: 10_000, json: READY }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request });
  assert.equal(r.state, "already-up");
  assert.equal(world.sent.length, 0);
  assert.ok(HEALTH_TIMEOUT_MS >= 12_000, `T is stated as 12 s (the loaded ceiling plus 2 s); it is ${HEALTH_TIMEOUT_MS}`);
});

test("#2655 5.5: a box that answers only on a LATER poll gets exactly ONE packet in total", async () => {
  const world = fakeWorld();
  // silent, silent, silent, then up: the packet goes after the first silence and no poll sends another.
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: Infinity }, { delayMs: Infinity }, { delayMs: Infinity }, { json: READY }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request });
  assert.equal(r.state, "woken");
  assert.equal(world.sent.length, 1, "at most one packet per box per wake, however many polls timed out");
  assert.equal(r.packets, 1);
});

test("#2655 5.5: a box that never answers ends in the UNKNOWN-outcome error -- packet sent, nothing answered -- and never says 'down'", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: Infinity }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request, deadlineMs: 60_000 });
  assert.equal(r.state, "no-answer");
  assert.equal(world.sent.length, 1, "silence for the whole deadline still sent one packet, not one per poll");
  const line = wakeReportLine(r);
  assert.match(line, /one packet sent and NOTHING ANSWERED within the deadline/);
  assert.match(line, /ETIMEDOUT/, "the probe's own error text travels with the outcome");
  assert.doesNotMatch(line, /\bis down\b|\bwas down\b/i, "a silence is not a finding that the box is down");
  // the deadline, not a probe timeout, ends it: silent probes keep waiting until 60 s of polling have passed.
  assert.ok(world.sleepCalls() >= 60_000);
});

test("#2655 5.2: a REFUSED connection is its own outcome, KNOWN (the box is up), and it is sent no packet", async () => {
  const health = fakeHealth({ "192.0.2.1": [{ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }] });
  const probe = await probeWorker("http://192.0.2.1:8765", { request: health.request });
  assert.equal(probe.outcome, "refused");
  const silent = await probeWorker("http://192.0.2.1:8765", { request: fakeHealth({}).request });
  assert.equal(silent.outcome, "no-answer", "a timeout and a refusal must not share an outcome");

  const world = fakeWorld();
  const later = fakeHealth({ "192.0.2.1": [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }, { json: READY }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: later.request });
  assert.equal(r.state, "came-up");
  assert.equal(world.sent.length, 0, "a refusal means the box is up: a magic packet has nothing to do");
});

test("#2655 5.2: a box refusing for the whole wait is 'not-listening' (it is up), which is not the unknown 'no-answer'", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ code: "ECONNREFUSED" }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request, deadlineMs: 30_000 });
  assert.equal(r.state, "not-listening");
  assert.equal(world.sent.length, 0);
});

test("#2655 3: answered but never ready is its own named error, carrying /health's own reason", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ json: { ok: true, ready: false, busy: false, reason: "not ready: browserConfigured" } }] });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request, deadlineMs: 30_000 });
  assert.equal(r.state, "never-ready");
  assert.match(String(r.detail), /not ready: browserConfigured/);
  assert.equal(world.sent.length, 0, "it answered, so it is up and is never sent a packet");
  assert.match(wakeReportLine(r), /answered but never became ready: not ready: browserConfigured/);
});

test("#2655 2: a worker that is UP AND BUSY is neither woken nor waited on", async () => {
  const world = fakeWorld();
  let slept = 0;
  const health = fakeHealth({ "192.0.2.1": [{ json: { ok: true, ready: false, busy: true, reason: "busy with a capture" } }] });
  const [r] = await wakeFleet(workers("w1"), {
    ...world.options, request: health.request,
    // still moves the clock: a sleep that did not would turn a mutant of this test into a hang, not a failure
    sleep: async (ms: number) => { slept += 1; await world.options.sleep(ms); },
  });
  assert.equal(r.state, "busy");
  assert.equal(world.sent.length, 0);
  assert.equal(slept, 0, "waiting for a busy box to be ready would wait on a capture somebody else is running");
});

test("#2655 3: silent and no mac in the inventory is 'no-mac', and nothing is sent; an UP box with no mac is fine", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: Infinity }], "192.0.2.2": [{ json: READY }] });
  const results = await wakeFleet(
    [{ name: "w1", host: "192.0.2.1", mac: null }, { name: "w2", host: "192.0.2.2", mac: null }],
    { ...world.options, request: health.request });
  assert.deepEqual(results.map((r) => r.state), ["no-mac", "already-up"]);
  assert.equal(world.sent.length, 0);
});

test("#2655 2: it wakes exactly the workers it is given -- three asked, one silent: one packet, and no other host is probed", async () => {
  const world = fakeWorld();
  const health = fakeHealth({
    "192.0.2.1": [{ json: READY }],
    "192.0.2.2": [{ delayMs: Infinity }, { json: READY }],
    "192.0.2.3": [{ json: READY }],
  });
  const results = await wakeFleet(workers("w1", "w2", "w3"), { ...world.options, request: health.request });
  assert.deepEqual(results.map((r) => r.state), ["already-up", "woken", "already-up"]);
  assert.deepEqual(world.sent, ["aa:bb:cc:dd:ee:02"], "only the silent box is sent a packet");
  assert.deepEqual([...new Set(health.calls)].sort(), ["192.0.2.1", "192.0.2.2", "192.0.2.3"]);
});

test("#2655 5.1: every probe is made with T, never with a shorter number, and T is not the discover probe's 2 s", async () => {
  const world = fakeWorld();
  const health = fakeHealth({ "192.0.2.1": [{ delayMs: Infinity }, { json: READY }] });
  await wakeFleet(workers("w1"), { ...world.options, request: health.request });
  assert.deepEqual([...new Set(health.timeouts)], [HEALTH_TIMEOUT_MS]);
  assert.notEqual(HEALTH_TIMEOUT_MS, 2_000);
  assert.ok(WAKE_DEADLINE_MS > HEALTH_TIMEOUT_MS, "the overall wait is a separate, larger number");
});
