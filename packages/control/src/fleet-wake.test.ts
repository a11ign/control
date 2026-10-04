// The magic packet is the entire mechanism, and it is the one part that cannot be tested against a real
// machine from here — so it is tested against the specification instead. A wrong packet fails silently:
// the box simply never wakes, which is indistinguishable from a firmware setting being off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HEALTH_TIMEOUT_MS, WAKE_DEADLINE_MS, PROOF_WINDOW_MS, DEFAULT_PROOF_PATH, magicPacket, probeWorker, wakeFleet,
  wakeReportLine, readWakeProof, advanceWakeProof, recordWakeProof, proofWriteCommand, wakeFailed,
} from "./fleet-wake.mjs";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";

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

// ---------------------------------------------------------------------------------------------------
// #3227: the wake PROOF auto-off reads. Written only by a wake that began from silence and ended `ready`
// at the inventory's own address; dropped by a wake that failed; per worker, so one box moves no other.
// ---------------------------------------------------------------------------------------------------

const SILENT = { delayMs: Infinity };

/**
 * The control plane's filesystem, as a directory of this machine's: the transport runs the REAL command (the
 * real `flock`, the real `node`) with the control plane's checkout path rewritten to the sandbox. So the
 * address the code names is the address that is exercised, and nothing here reaches a network or `/root`.
 */
function controlPlane() {
  const root = mkdtempSync(join(tmpdir(), "wake-proof-"));
  const commands: string[] = [];
  const transport = (command: string) => {
    commands.push(command);
    return execFileSync("sh", ["-c", command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, root)], { encoding: "utf8" });
  };
  const file = DEFAULT_PROOF_PATH.replace(CONTROL_PLANE_CHECKOUT_PATH, root);
  return {
    root, commands, transport, file,
    options: { proofTransport: transport as never },
    proven: () => readWakeProof(DEFAULT_PROOF_PATH, transport),
    seed: (initial: Record<string, number>) => {
      execFileSync("mkdir", ["-p", join(root, "runs")]);
      writeFileSync(file, JSON.stringify({ provenAt: initial }));
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One host per state: what `wakeFleet` must read to end in each. Worker n answers at 192.0.2.n. */
const ONE_OF_EACH = {
  "192.0.2.1": [SILENT, { json: READY }],                                   // woken
  "192.0.2.2": [{ json: READY }],                                           // already-up
  "192.0.2.3": [{ json: { ok: true, ready: false, busy: true } }],          // busy
  "192.0.2.4": [{ json: { ok: true, ready: false, reason: "starting" } }, { json: READY }], // came-up
  "192.0.2.5": [SILENT],                                                    // no-answer: it may answer elsewhere, never here
  "192.0.2.6": [{ code: "ECONNREFUSED", message: "refused" }],              // not-listening
  "192.0.2.7": [{ json: { ok: true, ready: false, reason: "browserConfigured" } }], // never-ready
  "192.0.2.8": [SILENT],                                                    // moved: silent here, found by MAC (below)
  "192.0.2.99": [{ json: READY }],                                          // ... and answering where the MAC says
};
const MOVED_TO = "192.0.2.99";
const MAC_OF_W8 = "aa:bb:cc:dd:ee:08";
/** The MAC reader the wake is handed: names `MOVED_TO` for w8's MAC every time, and nothing for any other. */
const findsW8 = (candidates: { name: string, mac: string }[]) =>
  new Map(candidates.filter((c) => c.mac === MAC_OF_W8).map((c) => [c.name, MOVED_TO]));

test("#3269 1: the ledger's address is ONE absolute path under the control plane's checkout, never the cwd's", () => {
  assert.equal(DEFAULT_PROOF_PATH, `${CONTROL_PLANE_CHECKOUT_PATH}/runs/fleet-wake-proof.json`);
  assert.ok(DEFAULT_PROOF_PATH.startsWith("/"), "a relative path is whichever checkout the process happened to run in");
});

test("#3227 2: ONLY a worker that was silent and then came up ready earns a proof; every other outcome writes none", async () => {
  const world = fakeWorld();
  const plane = controlPlane();
  try {
    const results = await wakeFleet(workers("w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"), {
      ...world.options, ...plane.options, request: fakeHealth(ONE_OF_EACH).request, macRead: findsW8,
    });
    assert.deepEqual(results.map((r) => r.state),
      ["woken", "already-up", "busy", "came-up", "no-answer", "not-listening", "never-ready", "moved"],
      "positive control: the fixture really produces each state, or an absent proof proves nothing");
    assert.deepEqual(Object.keys(plane.proven()), ["w1"], "w1 woke from silence on its own address; nobody else proved a thing");
    assert.equal(plane.proven().w1, world.sleepCalls(), "the proof is stamped with the wake's own clock");
  } finally { plane.dispose(); }
});

test("#3227 2: a wake that FAILS revokes the proof that worker held, and every other worker's proof is untouched", async () => {
  const world = fakeWorld();
  const plane = controlPlane();
  try {
    plane.seed({ w1: 111, w2: 222, w3: 333, w4: 444, w5: 555, w6: 666, w7: 777, w8: 888 });
    await wakeFleet(workers("w1", "w2", "w3", "w4", "w5", "w6", "w7"), {
      ...world.options, ...plane.options, request: fakeHealth(ONE_OF_EACH).request,
    });
    const after = plane.proven();
    assert.deepEqual(["w5", "w6", "w7"].filter((n) => n in after), [], "no-answer, not-listening and never-ready each drop their proof");
    assert.equal(after.w1, world.sleepCalls(), "the worker that woke has its proof renewed");
    assert.deepEqual([after.w2, after.w3, after.w4, after.w8], [222, 333, 444, 888],
      "already-up, busy, came-up and a worker not asked about keep what they held -- no refresh, no revocation");
  } finally { plane.dispose(); }
});

test("#3227 2: a worker with no mac that never answered is a failed wake and drops its proof (it cannot be woken at all)", async () => {
  const plane = controlPlane();
  try {
    plane.seed({ w1: 5 });
    const world = fakeWorld();
    const [r] = await wakeFleet([{ name: "w1", host: "192.0.2.1", mac: null }], {
      ...world.options, ...plane.options, request: fakeHealth({ "192.0.2.1": [SILENT] }).request,
    });
    assert.equal(r.state, "no-mac");
    assert.deepEqual(plane.proven(), {});
  } finally { plane.dispose(); }
});

test("#3227 5: advanceWakeProof is per worker -- adding or dropping one entry leaves every other exactly as it was", () => {
  const before = { a: 1, b: 2, c: 3 };
  assert.deepEqual(advanceWakeProof([{ name: "b", state: "no-answer" }], before, 9), { a: 1, c: 3 });
  assert.deepEqual(advanceWakeProof([{ name: "d", state: "woken" }], before, 9), { a: 1, b: 2, c: 3, d: 9 });
  assert.deepEqual(before, { a: 1, b: 2, c: 3 }, "the ledger it was given is not mutated");
});

test("#3227: a wake with an injected socket and no transport is no real wake -- it earns no proof and reaches no machine", async () => {
  const world = fakeWorld();
  const lines: string[] = [];
  const results = await wakeFleet(workers("w1"), {
    ...world.options, log: (l: string) => lines.push(l),
    request: fakeHealth({ "192.0.2.1": [SILENT, { json: READY }] }).request,
  });
  assert.equal(results[0].state, "woken", "positive control: it did wake, so the silence above is the injected socket's doing");
  assert.deepEqual(lines.filter((l) => /ledger/.test(l)), [], "the real transport was never tried: it would have said it failed");
});

test("#3269 3: a transport that FAILS leaves the wake's result unchanged, the worker unproven, and says so through log", async () => {
  const plane = controlPlane();
  try {
    const world = fakeWorld();
    const lines: string[] = [];
    const refused = () => { throw new Error("ssh: connect to host 192.0.2.250 port 22: Connection refused"); };
    const health = { "192.0.2.1": [SILENT, { json: READY }] };
    const failing = await wakeFleet(workers("w1"), {
      ...world.options, log: (l: string) => lines.push(l), proofTransport: refused as never, request: fakeHealth(health).request,
    });
    const working = await wakeFleet(workers("w1"), { ...fakeWorld().options, ...plane.options, request: fakeHealth(health).request });
    assert.deepEqual(failing.map((r) => r.state), working.map((r) => r.state), "the wake itself completes the same either way");
    assert.equal(failing[0].state, "woken");
    assert.ok(lines.some((l) => /wake-proof ledger was not updated.*Connection refused/.test(l)), `logged: ${lines.join(" | ")}`);
    assert.deepEqual(Object.keys(plane.proven()), ["w1"], "positive control: the same wake over a working transport DOES prove it");
    const nothing = controlPlane();
    try { assert.deepEqual(nothing.proven(), {}, "and the failed one left no ledger at all"); } finally { nothing.dispose(); }
  } finally { plane.dispose(); }
});

test("#3269 3: an unreachable control plane reads as an EMPTY ledger and is said aloud, never a guess", () => {
  const lines: string[] = [];
  const refused = () => { throw new Error("ssh: Connection timed out"); };
  assert.deepEqual(readWakeProof(DEFAULT_PROOF_PATH, refused as never, (l) => lines.push(l)), {});
  assert.ok(lines.some((l) => l.includes(DEFAULT_PROOF_PATH) && /Connection timed out/.test(l)), `logged: ${lines.join(" | ")}`);
});

test("#3269 2: a wake from the agents host and one on the control plane leave the SAME file with the SAME ledger", async () => {
  const fromAgentsHost = controlPlane();
  const onControlPlane = controlPlane();
  try {
    const health = { "192.0.2.1": [SILENT, { json: READY }] };
    for (const plane of [fromAgentsHost, onControlPlane]) {
      await wakeFleet(workers("w1"), { ...fakeWorld().options, ...plane.options, request: fakeHealth(health).request });
    }
    assert.deepEqual(fromAgentsHost.commands, onControlPlane.commands, "one command, whichever host sends it");
    assert.ok(fromAgentsHost.commands.every((c) => c.includes(DEFAULT_PROOF_PATH)), "and it names the shared absolute path");
    assert.ok(existsSync(fromAgentsHost.file) && existsSync(onControlPlane.file),
      "positive control: the ledger EXISTS at that path, so 'reads empty' cannot stand in for 'wrote nothing'");
    const [a, b] = [fromAgentsHost, onControlPlane].map((p) => readFileSync(p.file, "utf8"));
    assert.equal(a, b);
    assert.deepEqual(Object.keys(fromAgentsHost.proven()), ["w1"]);
  } finally { fromAgentsHost.dispose(); onControlPlane.dispose(); }
});

test("#3269 4: two wakes finishing together leave BOTH workers; the write waits on the ledger's lock", async () => {
  const plane = controlPlane();
  try {
    plane.seed({ w0: 1 });
    const run = (command: string) => new Promise<number | null>((resolve) => {
      spawn("sh", ["-c", command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, plane.root)]).on("close", resolve);
    });
    // Somebody else holds the lock until the test says so. A writer that ignores it lands inside the window, and
    // the window is GENEROUS: `node` alone takes ~0.3 s to start in the sandbox, so a shorter one proves nothing.
    const [held, release] = [join(plane.root, "held"), join(plane.root, "release")];
    const holder = run(`flock '${DEFAULT_PROOF_PATH}.lock' sh -c 'touch ${held}; while [ ! -e ${release} ]; do sleep 0.05; done'`);
    while (!existsSync(held)) await new Promise((r) => setTimeout(r, 20));
    const before = readFileSync(plane.file, "utf8");
    const writes = [run(proofWriteCommand(DEFAULT_PROOF_PATH, { set: { w1: 10 }, drop: [] })),
      run(proofWriteCommand(DEFAULT_PROOF_PATH, { set: { w2: 20 }, drop: [] }))];
    try {
      await new Promise((r) => setTimeout(r, 1_500));
      assert.equal(readFileSync(plane.file, "utf8"), before, "no write got past a held lock");
    } finally {
      writeFileSync(release, ""); // a red run must still free the holder (and wait for it), or it spins forever
      await holder;
    }
    assert.deepEqual(await Promise.all([holder, ...writes]), [0, 0, 0]);
    assert.deepEqual(plane.proven(), { w0: 1, w1: 10, w2: 20 }, "both writers' workers and the one already there");
  } finally { plane.dispose(); }
});

test("#3269 4: the remote step agrees with advanceWakeProof, including over a ledger that is corrupt or half-numeric", () => {
  const results = [{ name: "w1", state: "woken" }, { name: "w2", state: "no-answer" }, { name: "w3", state: "busy" }];
  const cases: [string, string | null, Record<string, number>][] = [
    ["absent", null, {}],
    ["populated", JSON.stringify({ provenAt: { w2: 1, w3: 3, w4: 4 } }), { w2: 1, w3: 3, w4: 4 }],
    ["corrupt", "{ nope", {}],
    ["wrongly shaped", JSON.stringify({ provenAt: [1] }), {}],
    ["a stamp that is not a number", JSON.stringify({ provenAt: { w3: "yesterday", w4: 4 } }), { w4: 4 }],
  ];
  for (const [label, text, expected] of cases) {
    const plane = controlPlane();
    try {
      if (text !== null) { execFileSync("mkdir", ["-p", join(plane.root, "runs")]); writeFileSync(plane.file, text); }
      recordWakeProof(results, { path: DEFAULT_PROOF_PATH, at: 9, transport: plane.transport });
      assert.deepEqual(plane.proven(), advanceWakeProof(results, expected, 9), label);
      assert.equal(plane.proven().w1, 9, `${label}: positive control, the proving worker is in it`);
    } finally { plane.dispose(); }
  }
});

test("#3269: a wake that changes nothing sends nothing, and a path that is not a plain absolute one is refused before any command", () => {
  const sent: string[] = [];
  const lines: string[] = [];
  const transport = (c: string) => { sent.push(c); return ""; };
  recordWakeProof([{ name: "w1", state: "already-up" }, { name: "w2", state: "busy" }], { path: DEFAULT_PROOF_PATH, at: 1, transport });
  assert.deepEqual(sent, []);
  recordWakeProof([{ name: "w1", state: "woken" }], { path: DEFAULT_PROOF_PATH, at: 1, transport });
  assert.equal(sent.length, 1, "positive control: a proving wake does send one command");
  for (const path of [DEFAULT_PROOF_PATH.replace(`${CONTROL_PLANE_CHECKOUT_PATH}/`, ""), "/tmp/a b.json", "/tmp/x'; rm -rf /; '"]) {
    recordWakeProof([{ name: "w1", state: "woken" }], { path, at: 1, transport, log: (l) => lines.push(l) });
  }
  assert.equal(sent.length, 1, "none of the three reached the transport");
  assert.equal(lines.length, 3, "and each said why");
});

test("#3227: a missing, corrupt or wrongly-shaped ledger reads as EMPTY, which is no proof for anyone", () => {
  const reading = (text: string) => readWakeProof(DEFAULT_PROOF_PATH, (() => text) as never);
  assert.deepEqual(reading(JSON.stringify({ provenAt: { w1: 5 } })), { w1: 5 }, "positive control");
  for (const bad of ["", "{ nope", "null", "[]", JSON.stringify({ provenAt: [1] }), JSON.stringify({ other: { w1: 5 } })]) {
    assert.deepEqual(reading(bad), {}, `${JSON.stringify(bad)} must read as empty`);
  }
  assert.deepEqual(reading(JSON.stringify({ provenAt: { w1: "yesterday", w2: 7 } })), { w2: 7 }, "a stamp that is not a number is not a proof");
});

test("#3227 4: the report names a failed wake's worker and says its proof was dropped; a proving wake says so too", () => {
  const failed = wakeReportLine({ name: "a11y-worker-4", host: "192.0.2.4", state: "no-answer", detail: "ETIMEDOUT" });
  assert.match(failed, /a11y-worker-4/);
  assert.match(failed, /wake proof dropped: auto-off keeps it on/);
  assert.match(wakeReportLine({ name: "a11y-worker-3", host: "192.0.2.3", state: "woken" }), /wake proved: auto-off may power it off/);
  for (const state of ["already-up", "busy", "came-up"]) {
    assert.doesNotMatch(wakeReportLine({ name: "w", host: "h", state }), /proof/, `${state} neither proves nor drops`);
  }
});

test("#3227 3: the window is a derived bound, not a round number: under the monthly servicing cadence it is derived from", () => {
  const DAY = 86_400_000;
  assert.ok(PROOF_WINDOW_MS < 31 * DAY, "a proof must lapse before the next monthly Windows servicing update can have changed the NIC");
  assert.ok(PROOF_WINDOW_MS > WAKE_DEADLINE_MS, "and it must outlive one wake, or every proof would lapse as it was earned");
});

// ---- #3401: a silent worker is asked for by MAC BEFORE any packet goes out ----

/** A MAC reader that answers from a script, one entry per call, and records every candidate list it was given. */
function fakeMacRead(...reads: Record<string, string>[]) {
  const asked: string[][] = [];
  const macRead = (candidates: { name: string }[]) => {
    asked.push(candidates.map((c) => c.name));
    const read = reads[Math.min(asked.length - 1, reads.length - 1)] ?? {};
    return new Map(candidates.flatMap((c) => (c.name in read ? [[c.name, read[c.name]] as [string, string]] : [])));
  };
  return { macRead, asked };
}
const ANSWERS_ELSEWHERE = { "192.0.2.1": [SILENT], [MOVED_TO]: [{ json: READY }] };

test("#3401 2: a silent worker the MAC finds elsewhere is `moved` AT ONCE -- ZERO packets, no deadline wait, and no 'NOTHING ANSWERED'", async () => {
  const world = fakeWorld();
  const mac = fakeMacRead({ w1: MOVED_TO });
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: fakeHealth(ANSWERS_ELSEWHERE).request, macRead: mac.macRead });
  assert.equal(r.state, "moved");
  assert.equal(world.sent.length, 0, "positive control for 'no packet': the same silent box WITHOUT a find sends one (next test)");
  assert.equal(r.packets, 0);
  assert.equal(world.sleepCalls(), 0, "it did not wait on the 300 s deadline, or on any poll");
  const line = wakeReportLine(r);
  assert.match(line, new RegExp(`answers at ${MOVED_TO.replaceAll(".", "\\.")}`));
  assert.match(line, /192\.0\.2\.1/, "and names the address the inventory pins");
  assert.match(line, /fix inventory\.yml and ask for a DHCP reservation/, "the remedy fleet:status already names");
  assert.doesNotMatch(line, /NOTHING ANSWERED|Wake-on-LAN|firmware|\bis down\b/, "not the no-answer story, and not 'down'");
});

test("#3401 4: a silent worker the MAC does NOT find behaves as today -- ONE packet, the deadline, `no-answer`, the unchanged line", async () => {
  const world = fakeWorld();
  const mac = fakeMacRead({});
  const [r] = await wakeFleet(workers("w1"), {
    ...world.options, request: fakeHealth({ "192.0.2.1": [SILENT] }).request, macRead: mac.macRead, deadlineMs: 60_000,
  });
  assert.deepEqual(mac.asked, [["w1"]], "positive control: the reader WAS asked, and found nothing");
  assert.equal(r.state, "no-answer");
  assert.equal(world.sent.length, 1);
  assert.ok(world.sleepCalls() >= 60_000);
  assert.match(wakeReportLine(r), /one packet sent and NOTHING ANSWERED within the deadline/);
});

test("#3401 4: a MAC that reads at an address once and NOT AGAIN is not trusted -- today's path, one packet, `no-answer`", async () => {
  const world = fakeWorld();
  const mac = fakeMacRead({ w1: MOVED_TO }, {});
  const health = fakeHealth(ANSWERS_ELSEWHERE);
  const [r] = await wakeFleet(workers("w1"), { ...world.options, request: health.request, macRead: mac.macRead, deadlineMs: 20_000 });
  assert.equal(mac.asked.length, 2, "positive control: the identity check read twice");
  assert.equal(r.state, "no-answer");
  assert.equal(world.sent.length, 1);
  assert.ok(!health.calls.includes(MOVED_TO), "an address that failed the identity check is never even probed");
});

test("#3401 4: two reads that agree but an address that answers no /health is not `moved` either", async () => {
  const world = fakeWorld();
  const [r] = await wakeFleet(workers("w1"), {
    ...world.options, request: fakeHealth({ "192.0.2.1": [SILENT] }).request, macRead: fakeMacRead({ w1: MOVED_TO }).macRead,
    deadlineMs: 20_000,
  });
  assert.equal(r.state, "no-answer");
  assert.equal(world.sent.length, 1);
});

test("#3401 4: a box with no mac is still `no-mac`, and the MAC reader is never asked", async () => {
  const world = fakeWorld();
  const mac = fakeMacRead({ w1: MOVED_TO });
  const [r] = await wakeFleet([{ name: "w1", host: "192.0.2.1", mac: null }], {
    ...world.options, request: fakeHealth(ANSWERS_ELSEWHERE).request, macRead: mac.macRead,
  });
  assert.equal(r.state, "no-mac");
  assert.deepEqual(mac.asked, []);
});

test("#3401 5: a worker that answers at its pin never reaches the MAC read -- a healthy fleet pays one /health each", async () => {
  const world = fakeWorld();
  const mac = fakeMacRead({ w1: MOVED_TO, w2: MOVED_TO, w3: MOVED_TO });
  const health = fakeHealth({
    "192.0.2.1": [{ json: READY }], "192.0.2.2": [{ json: { ok: true, ready: false, busy: true } }],
    "192.0.2.3": [{ code: "ECONNREFUSED", message: "refused" }],
  });
  const results = await wakeFleet(workers("w1", "w2", "w3"), { ...world.options, request: health.request, macRead: mac.macRead, deadlineMs: 10_000 });
  assert.deepEqual(results.map((r) => r.state), ["already-up", "busy", "not-listening"]);
  assert.deepEqual(mac.asked, [], "ready, busy and refused all KNOW the box is up at its pin: nothing to look for");
});

test("#3401 3: `moved` is a failure for the exit code and the ledger: it writes no proof and DROPS a held one, as no-answer does", () => {
  assert.equal(wakeFailed({ state: "moved" }), true);
  assert.deepEqual(advanceWakeProof([{ name: "a", state: "moved" }], { a: 1, b: 2 }, 9), { b: 2 }, "a held proof is dropped");
  assert.deepEqual(advanceWakeProof([{ name: "a", state: "moved" }], { b: 2 }, 9), { b: 2 }, "and none is ever written");
  assert.match(wakeReportLine({ name: "w1", host: "192.0.2.1", state: "moved", detail: MOVED_TO }), /wake proof dropped/);
});

test("#3401 2: the MAC reader the wake defaults to is the live one -- but an injected socket is no real wake and never reaches it", async () => {
  const world = fakeWorld();
  const [r] = await wakeFleet(workers("w1"), {
    ...world.options, request: fakeHealth({ "192.0.2.1": [SILENT] }).request, deadlineMs: 5_000,
  });
  assert.equal(r.state, "no-answer", "no `macRead` given with an injected socket: nothing is found, and nothing is run over ssh");
});
