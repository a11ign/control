/**
 * #2656: a worker idle five minutes powers itself off, never mid-capture. (It no longer checks
 * `Fleet-hold-until:` -- #2737, ceo's ruling on #2726/#2728: a power cycle cannot drift the stamp that
 * hold protects, so the read bought nothing and needed a credential this box was never meant to hold.)
 *
 * This is the DECISION and the STATE, proven offline -- every network read, every clock read and the
 * `sleep.yml` dispatch itself are injected, exactly as `fleet-wake.test.ts` and `fleet-watch.mjs`'s own
 * suite already prove their neighbours without a real fleet (the resource ban bars a live run: #2656
 * ships this timer DISABLED for that reason too).
 */
// no-token: gh -- nothing here spawns `gh`; the #2734 regression test below only reads/restores its own
// process's `GH_TOKEN` to prove no code path in this file reads it anymore, and needs no real credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, linkSync, readdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureTimes, readCapturesState, writeCapturesState, withFileLock } from "./fleet-watch.mjs";
import { DEFAULT_PROOF_PATH, PROOF_WINDOW_MS } from "./fleet-wake.mjs";
import {
  IDLE_THRESHOLD_MS, PROBE_TIMEOUT_MS, POLL_INTERVAL_MS,
  hasWakeableMac, probeIdle, advance, advanceShutdownRequested, autoOffDecision,
  readState, writeState, dispatchShutdown, reportLine, tick, DEFAULT_STATE_PATH,
} from "./fleet-auto-off.mjs";

// ---------------------------------------------------------------------------------------------------------
// hasWakeableMac -- "has a MAC" means magicPacket() accepts it, not merely a non-empty field.
// ---------------------------------------------------------------------------------------------------------

test("hasWakeableMac: 12 hex digits, any separator, is wakeable", () => {
  assert.equal(hasWakeableMac("aa:bb:cc:dd:ee:ff"), true);
  assert.equal(hasWakeableMac("AA-BB-CC-DD-EE-FF"), true);
  assert.equal(hasWakeableMac("aabbccddeeff"), true);
});

test("hasWakeableMac: absent, empty or short is not wakeable", () => {
  assert.equal(hasWakeableMac(null), false);
  assert.equal(hasWakeableMac(undefined), false);
  assert.equal(hasWakeableMac(""), false);
  assert.equal(hasWakeableMac("aa:bb:cc"), false, "too short to be a MAC magicPacket() accepts");
  assert.equal(hasWakeableMac("not-a-mac-at-all"), false);
});

// ---------------------------------------------------------------------------------------------------------
// probeIdle -- the three outcomes, and only three (done-when 7.1). #2656's own reading, agreeing with
// fleet-wake.mjs's HEALTH_TIMEOUT_MS on the READING (5 s rebuild, 12 s loaded ceiling) not the number by
// copying it -- both derive 12_000 independently.
// ---------------------------------------------------------------------------------------------------------

test("probeIdle: busy:true is `busy`", async () => {
  const request = async () => ({ status: 200, ok: true, text: "", json: { busy: true } });
  assert.deepEqual(await probeIdle("http://x", { request }), { outcome: "busy" });
});

test("probeIdle: busy:false is `idle` -- the positive control for the whole poll", async () => {
  const request = async () => ({ status: 200, ok: true, text: "", json: { busy: false } });
  assert.deepEqual(await probeIdle("http://x", { request }), { outcome: "idle" });
});

test("probeIdle: a silent probe (timeout/refused/unreachable) is `no-answer`, never `busy` or `idle`", async () => {
  const request = async () => { const e = new Error("Request to http://x/health timed out after 12000 ms");
    (e as NodeJS.ErrnoException).code = "ETIMEDOUT"; throw e; };
  const probe = await probeIdle("http://x", { request });
  assert.equal(probe.outcome, "no-answer");
  assert.match((probe as { detail: string }).detail, /ETIMEDOUT/);
});

test("probeIdle: an answer that cannot be read -- non-OK status -- is `no-answer`, not a crash", async () => {
  const request = async () => ({ status: 500, ok: false, text: "", json: null });
  const probe = await probeIdle("http://x", { request });
  assert.equal(probe.outcome, "no-answer");
  assert.match((probe as { detail: string }).detail, /HTTP 500/);
});

test("probeIdle: an answer with no boolean `busy` field is `no-answer`, not read as idle", async () => {
  const request = async () => ({ status: 200, ok: true, text: "", json: {} });
  const probe = await probeIdle("http://x", { request });
  assert.equal(probe.outcome, "no-answer");
});

test("probeIdle: the timeout it asks for is PROBE_TIMEOUT_MS, not fleet:discover's old 2 s -- not vacuous", async () => {
  let seen: number | undefined;
  const request = async (_url: string, options: { timeoutMs?: number }) => {
    seen = options.timeoutMs;
    return { status: 200, ok: true, text: "", json: { busy: false } };
  };
  const probe = await probeIdle("http://x", { request: request as never });
  assert.equal(seen, PROBE_TIMEOUT_MS);
  assert.ok(PROBE_TIMEOUT_MS > 2_000, "must exceed fleet:discover's PROBE_TIMEOUT_MS, which read healthy boxes as asleep");
  assert.deepEqual(probe, { outcome: "idle" });
});

test("probeIdle: a slow-but-real answer, under PROBE_TIMEOUT_MS, still reads idle -- the timeout is not vacuous (done-when 7.5)", async () => {
  // "Slow" is simulated by an actual delay shorter than PROBE_TIMEOUT_MS and longer than the old 2 s --
  // proving a real answer landing inside the budget is read, not dropped by some shorter timeout still
  // lurking in the call chain.
  const request = async () => new Promise<{ status: number; ok: boolean; text: string; json: unknown }>((resolve) => {
    setTimeout(() => resolve({ status: 200, ok: true, text: "", json: { busy: false } }), 5);
  });
  const probe = await probeIdle("http://x", { request });
  assert.deepEqual(probe, { outcome: "idle" });
});

// ---------------------------------------------------------------------------------------------------------
// advance -- the idle-since ledger. A busy or no-answer sample RESETS the streak (done-when 7.3).
// ---------------------------------------------------------------------------------------------------------

test("advance: a first idle sample stamps `now`", () => {
  const next = advance([{ name: "a11y-worker-2", outcome: "idle" }], {}, 1000);
  assert.deepEqual(next, { "a11y-worker-2": 1000 });
});

test("advance: a worker already idle-since keeps its ORIGINAL timestamp, not `now`", () => {
  const next = advance([{ name: "a11y-worker-2", outcome: "idle" }], { "a11y-worker-2": 500 }, 1000);
  assert.deepEqual(next, { "a11y-worker-2": 500 });
});

test("advance: a busy sample drops the worker from the ledger -- the streak ends", () => {
  const next = advance([{ name: "a11y-worker-2", outcome: "busy" }], { "a11y-worker-2": 500 }, 1000);
  assert.deepEqual(next, {});
});

test("advance: a no-answer sample ALSO drops the worker -- RESET, not held (done-when 7.3, argued in the "
  + "function's own comment: a mid-capture box is plausibly the slow one, so an unconfirmed gap must never "
  + "count as idle time)", () => {
  const next = advance([{ name: "a11y-worker-2", outcome: "no-answer" }], { "a11y-worker-2": 500 }, 1000);
  assert.deepEqual(next, {}, "the prior idle-since must not survive a no-answer, or a capture hidden in "
    + "the gap would count toward the five minutes once the worker answers idle again");
});

test("advance: a worker recovering to idle after a no-answer restarts the clock at `now`, not the old stamp", () => {
  const afterBlip = advance([{ name: "a11y-worker-2", outcome: "no-answer" }], { "a11y-worker-2": 500 }, 900);
  const afterRecovery = advance([{ name: "a11y-worker-2", outcome: "idle" }], afterBlip, 1000);
  assert.deepEqual(afterRecovery, { "a11y-worker-2": 1000 });
});

// ---------------------------------------------------------------------------------------------------------
// advanceShutdownRequested -- kept while silent, cleared the moment the worker answers again.
// ---------------------------------------------------------------------------------------------------------

test("advanceShutdownRequested: kept across a no-answer -- the expected shape of a box going down", () => {
  const next = advanceShutdownRequested([{ name: "a11y-worker-2", outcome: "no-answer" }], { "a11y-worker-2": 500 });
  assert.deepEqual(next, { "a11y-worker-2": 500 });
});

test("advanceShutdownRequested: cleared when the worker answers idle again -- the shutdown never landed", () => {
  const next = advanceShutdownRequested([{ name: "a11y-worker-2", outcome: "idle" }], { "a11y-worker-2": 500 });
  assert.deepEqual(next, {});
});

test("advanceShutdownRequested: cleared when the worker answers busy -- sleep.yml's own refusal won the race", () => {
  const next = advanceShutdownRequested([{ name: "a11y-worker-2", outcome: "busy" }], { "a11y-worker-2": 500 });
  assert.deepEqual(next, {});
});

test("advanceShutdownRequested: a worker with no prior request stays absent", () => {
  const next = advanceShutdownRequested([{ name: "a11y-worker-2", outcome: "no-answer" }], {});
  assert.deepEqual(next, {});
});

// ---------------------------------------------------------------------------------------------------------
// autoOffDecision -- THE PURE FUNCTION (done-when 1). Every keep reason, each with a test that fails
// without it, and the no-mac positive control.
// ---------------------------------------------------------------------------------------------------------

const BASE = {
  name: "a11y-worker-2", hasMac: true, probe: "idle" as const,
  idleSince: 0, shutdownRequestedAt: null, wakeProvenAt: 0 as number | null,
  batchQueued: false, leasePending: false,
};
const NOW = IDLE_THRESHOLD_MS; // idleSince 0 -> exactly at the threshold

test("autoOffDecision: POSITIVE CONTROL -- idle past the threshold, MAC present, nothing else pending, reads off", () => {
  assert.deepEqual(autoOffDecision(BASE, NOW), { action: "off", reason: "idle-five-minutes" });
});

test("autoOffDecision: no-mac keeps, even when otherwise idle past the threshold", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, hasMac: false }, NOW), { action: "keep", reason: "no-mac" });
});

// #3227: a worker is powered off only while it has PROVED it comes back. Each fixture below is otherwise `off`
// (BASE is the positive control), so the proof is the one thing that differs between off and keep.
test("autoOffDecision: wake-unproven keeps an otherwise-off worker with NO proof, and outranks idle-five-minutes (#3227)", () => {
  const unproven = { ...BASE, wakeProvenAt: null };
  assert.notDeepEqual(unproven, BASE, "the proven and unproven fixtures must differ before the decision is run");
  assert.equal(autoOffDecision(BASE, NOW).action, "off", "positive control: the same worker WITH a proof powers off");
  assert.deepEqual(autoOffDecision(unproven, NOW), { action: "keep", reason: "wake-unproven" });
});

test("autoOffDecision: wake-unproven keeps an otherwise-off worker whose proof has EXPIRED -- not the same case as absent (#3227)", () => {
  const stale = { ...BASE, wakeProvenAt: NOW - PROOF_WINDOW_MS - 1 };
  assert.notEqual(stale.wakeProvenAt, null, "an expired proof is a value, so 'absent' cannot stand for it by accident");
  assert.deepEqual(autoOffDecision(stale, NOW), { action: "keep", reason: "wake-unproven" });
  assert.equal(autoOffDecision({ ...BASE, wakeProvenAt: NOW - PROOF_WINDOW_MS }, NOW).action, "off",
    "the last instant of the window still proves: the boundary is inclusive, as the idle threshold's is");
});

test("autoOffDecision: a proof stamped in the FUTURE is a clock fault and proves nothing (#3227)", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, wakeProvenAt: NOW + 1 }, NOW), { action: "keep", reason: "wake-unproven" });
});

test("autoOffDecision: already-off keeps once a shutdown was requested, regardless of the current probe", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, shutdownRequestedAt: 0 }, NOW), { action: "keep", reason: "already-off" });
});

test("autoOffDecision: no-answer keeps -- unknown never powers anything off", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, probe: "no-answer", idleSince: null }, NOW),
    { action: "keep", reason: "no-answer" });
});

test("autoOffDecision: busy keeps", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, probe: "busy", idleSince: null }, NOW), { action: "keep", reason: "busy" });
});

test("autoOffDecision: batch-queued keeps", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, batchQueued: true }, NOW), { action: "keep", reason: "batch-queued" });
});

test("autoOffDecision: lease-pending keeps", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, leasePending: true }, NOW), { action: "keep", reason: "lease-pending" });
});

test("autoOffDecision: idle-since-unknown keeps -- never treat 'never observed idle' as idle", () => {
  assert.deepEqual(autoOffDecision({ ...BASE, idleSince: null }, NOW), { action: "keep", reason: "idle-since-unknown" });
});

test("autoOffDecision: not-yet-five-minutes keeps, one millisecond short of the threshold", () => {
  assert.deepEqual(autoOffDecision(BASE, NOW - 1), { action: "keep", reason: "not-yet-five-minutes" });
});

test("autoOffDecision: exactly at the threshold is off, one past it is off -- the boundary is inclusive and stays off", () => {
  assert.equal(autoOffDecision(BASE, NOW).action, "off");
  assert.equal(autoOffDecision(BASE, NOW + 1).action, "off");
});

// ---------------------------------------------------------------------------------------------------------
// readState / writeState -- absent or corrupt reads as empty, never a crash.
// ---------------------------------------------------------------------------------------------------------

test("readState: a missing file reads as both ledgers empty", () => {
  const read = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  assert.deepEqual(readState("nowhere.json", read), { idleSince: {}, shutdownRequestedAt: {} });
});

test("readState: corrupt JSON reads as empty, not a thrown error", () => {
  assert.deepEqual(readState("x.json", () => "{not json"), { idleSince: {}, shutdownRequestedAt: {} });
});

test("readState/writeState: round-trips both ledgers", () => {
  let written = "";
  const state = { idleSince: { "a11y-worker-2": 5 }, shutdownRequestedAt: { "a11y-worker-3": 9 } };
  writeState("x.json", state, (_p, data) => { written = data; });
  assert.deepEqual(readState("x.json", () => written), state);
});

// ---------------------------------------------------------------------------------------------------------
// dispatchShutdown -- calls sleep.yml, by name, with ANSIBLE_CONFIG set. Reused, not reimplemented.
// ---------------------------------------------------------------------------------------------------------

test("dispatchShutdown: runs ansible-playbook against sleep.yml, limited to the one worker", () => {
  let seenCommand = "";
  let seenArgs: string[] = [];
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const run = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    seenCommand = command; seenArgs = [...args]; seenEnv = options.env;
    return { status: 0, stdout: "ok", stderr: "" };
  }) as unknown as typeof import("node:child_process").spawnSync;
  const result = dispatchShutdown("a11y-worker-2", { run });
  assert.equal(seenCommand, "ansible-playbook");
  assert.match(seenArgs[0], /sleep\.yml$/, "must name sleep.yml -- reused, never reimplemented (done-when 2)");
  assert.deepEqual(seenArgs.slice(1), ["-l", "a11y-worker-2"], "must limit to exactly the one worker, never the fleet");
  assert.match(String(seenEnv?.ANSIBLE_CONFIG), /ansible\.cfg$/);
  assert.equal(result.status, 0);
});

// #2725 done-when 4: a REAL spawnSync (not a stub unconditionally returning {status: 0}), run against a
// PATH that omits `ansible-playbook` -- exactly the live defect (systemd's default PATH lacked
// `/root/.local/bin`, where `ansible-playbook` actually lives). Proves `dispatchShutdown` itself surfaces
// the failure rather than discarding `spawnSync`'s own `error`, which is what let #2725 read as an
// infinite silent retry instead of a visible one.
test("dispatchShutdown: a REAL spawnSync against a PATH lacking ansible-playbook surfaces the failure", () => {
  const run = ((command: string, args: readonly string[], options: { encoding?: string }) =>
    spawnSync(command, args, { ...options, env: { PATH: "" }, encoding: "utf8" })
  ) as unknown as typeof import("node:child_process").spawnSync;
  const result = dispatchShutdown("a11y-worker-2", { run });
  assert.notEqual(result.status, 0, "a missing ansible-playbook must never read as a successful dispatch");
  assert.match(result.log, /ENOENT/, "the reason must be visible in the log, not swallowed");
});

// ---------------------------------------------------------------------------------------------------------
// reportLine -- names a no-answer worker's own wait (done-when 7.4).
// ---------------------------------------------------------------------------------------------------------

test("reportLine: a no-answer worker's line names the seconds waited", () => {
  const line = reportLine({ name: "a11y-worker-2", host: "192.0.2.12" }, { action: "keep", reason: "no-answer" }, 12_000);
  assert.match(line, /waited 12\.0s/);
});

test("reportLine: any other reason carries no wait clause", () => {
  const line = reportLine({ name: "a11y-worker-2", host: "192.0.2.12" }, { action: "keep", reason: "busy" }, 12_000);
  assert.ok(!line.includes("waited"));
});

// ---------------------------------------------------------------------------------------------------------
// tick -- the whole thing, offline. #2656 done-when 6: report-only by default, dispatches ONLY under
// {apply:true}, and never touches the network, the clock or sleep.yml except through the injected deps.
// ---------------------------------------------------------------------------------------------------------

const WORKERS = [{ name: "a11y-worker-2", host: "192.0.2.12", mac: "aa:bb:cc:dd:ee:ff" }];

/** The ledger of a worker that proved a wake at time 0, a moment before every `now` these tests use. */
const PROVEN_AT_0 = JSON.stringify({ provenAt: { "a11y-worker-2": 0 } });
const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };

/** `state` for every path but the proof ledger's; the proof ledger as given. One fake serves both reads. */
const filesWith = (state: string | null, proof: string | null) =>
  ((path: string) => { const text = path === DEFAULT_PROOF_PATH ? proof : state; return text ?? enoent(); }) as never;

/** A worker already idle-since time 0 and already proven -- so `now = IDLE_THRESHOLD_MS` lands exactly at the boundary. */
const alreadyIdleSince0 = filesWith(JSON.stringify({ idleSince: { "a11y-worker-2": 0 }, shutdownRequestedAt: {} }), PROVEN_AT_0);

test("tick: report only (apply omitted) never dispatches, even for a worker decided off", async () => {
  let dispatched = 0;
  const result = await tick({
    workers: WORKERS,
    probe: async () => ({ outcome: "idle" }),
    now: () => IDLE_THRESHOLD_MS,
    statePath: "x.json",
    read: alreadyIdleSince0,
    write: () => {},
    dispatch: () => { dispatched += 1; return { status: 0, log: "" }; },
  });
  assert.equal(dispatched, 0, "report-only must power nothing off");
  assert.deepEqual(result.decisions[0].decision, { action: "off", reason: "idle-five-minutes" },
    "and it must still SAY what it would have done");
});

test("tick: --apply dispatches exactly the workers decided off, and stamps shutdownRequestedAt", async () => {
  const dispatchedNames: string[] = [];
  let savedState: unknown = null;
  await tick({
    workers: WORKERS,
    probe: async () => ({ outcome: "idle" }),
    now: () => IDLE_THRESHOLD_MS,
    statePath: "x.json",
    read: alreadyIdleSince0,
    write: (_p, data) => { savedState = JSON.parse(String(data)); },
    apply: true,
    dispatch: (name: string) => { dispatchedNames.push(name); return { status: 0, log: "" }; },
  });
  assert.deepEqual(dispatchedNames, ["a11y-worker-2"]);
  assert.deepEqual((savedState as { shutdownRequestedAt: Record<string, number> }).shutdownRequestedAt,
    { "a11y-worker-2": IDLE_THRESHOLD_MS });
});

test("tick: a failed dispatch is logged to stderr and does not stamp shutdownRequestedAt (done-when 2)", async () => {
  let savedState: unknown = null;
  const originalWrite = process.stderr.write.bind(process.stderr);
  let stderrOutput = "";
  process.stderr.write = ((chunk: string) => { stderrOutput += chunk; return true; }) as typeof process.stderr.write;
  try {
    await tick({
      workers: WORKERS,
      probe: async () => ({ outcome: "idle" }),
      now: () => IDLE_THRESHOLD_MS,
      statePath: "x.json",
      read: alreadyIdleSince0,
      write: (_p, data) => { savedState = JSON.parse(String(data)); },
      apply: true,
      dispatch: () => ({ status: null, log: "spawnSync ansible-playbook ENOENT" }),
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.deepEqual((savedState as { shutdownRequestedAt: Record<string, number> }).shutdownRequestedAt, {},
    "a dispatch that never reached sleep.yml must not be recorded as a requested shutdown");
  assert.match(stderrOutput, /a11y-worker-2/, "the failure must name the worker");
  assert.match(stderrOutput, /ENOENT/, "the failure reason must reach the log, not be discarded (#2725)");
});

test("tick: a worker still idle but under the threshold is kept, and never dispatched even under --apply", async () => {
  let dispatched = 0;
  const result = await tick({
    workers: WORKERS,
    probe: async () => ({ outcome: "idle" }),
    now: () => IDLE_THRESHOLD_MS - 1,
    statePath: "x.json",
    read: filesWith(null, PROVEN_AT_0),
    write: () => {},
    apply: true,
    dispatch: () => { dispatched += 1; return { status: 0, log: "" }; },
  });
  assert.equal(dispatched, 0);
  assert.equal(result.decisions[0].decision.reason, "not-yet-five-minutes");
});

const TWO_WORKERS = [WORKERS[0], { name: "a11y-worker-3", host: "192.0.2.13", mac: "aa:bb:cc:dd:ee:00" }];
const BOTH_IDLE_SINCE_0 = JSON.stringify({ idleSince: { "a11y-worker-2": 0, "a11y-worker-3": 0 }, shutdownRequestedAt: {} });

/** One `--apply` tick over both workers, both idle past the threshold, reading `proof` as the wake-proof ledger. */
async function applyOver(proof: string | null, now = IDLE_THRESHOLD_MS) {
  const dispatched: string[] = [];
  const { decisions } = await tick({
    workers: TWO_WORKERS, probe: async () => ({ outcome: "idle" }), now: () => now, statePath: "x.json",
    read: filesWith(BOTH_IDLE_SINCE_0, proof), write: () => {}, apply: true,
    dispatch: (name: string) => { dispatched.push(name); return { status: 0, log: "" }; },
  });
  return { dispatched, reasons: Object.fromEntries(decisions.map((d) => [d.worker.name, d.decision.reason])) };
}
const proofOf = (provenAt: Record<string, number>) => JSON.stringify({ provenAt });

test("tick: an idle worker with no proof is kept and never dispatched under --apply, and is NAMED by its reason (#3227)", async () => {
  const proven = await applyOver(proofOf({ "a11y-worker-2": 0, "a11y-worker-3": 0 }));
  assert.deepEqual(proven.dispatched, ["a11y-worker-2", "a11y-worker-3"], "positive control: with proofs both power off");
  for (const proof of [null, "{ not json", proofOf({})]) {
    const none = await applyOver(proof);
    assert.deepEqual(none.dispatched, [], `no proof (${proof}) must power nothing off`);
    assert.deepEqual(none.reasons, { "a11y-worker-2": "wake-unproven", "a11y-worker-3": "wake-unproven" });
  }
});

test("tick: an expired proof keeps the worker, one tick before and one after the window (#3227)", async () => {
  const proof = proofOf({ "a11y-worker-2": 0, "a11y-worker-3": 0 });
  assert.equal((await applyOver(proof, PROOF_WINDOW_MS)).dispatched.length, 2, "at the window's edge both still prove");
  const lapsed = await applyOver(proof, PROOF_WINDOW_MS + 1);
  assert.deepEqual(lapsed.dispatched, []);
  assert.deepEqual(lapsed.reasons, { "a11y-worker-2": "wake-unproven", "a11y-worker-3": "wake-unproven" });
});

test("tick: revoking ONE worker's proof changes no other worker's decision (#3227, done-when 5)", async () => {
  const both = await applyOver(proofOf({ "a11y-worker-2": 0, "a11y-worker-3": 0 }));
  const without2 = await applyOver(proofOf({ "a11y-worker-3": 0 }));
  const without3 = await applyOver(proofOf({ "a11y-worker-2": 0 }));
  assert.notDeepEqual(without2.reasons, both.reasons, "the revocation must be visible, or this compares nothing");
  assert.equal(without2.reasons["a11y-worker-3"], both.reasons["a11y-worker-3"]);
  assert.equal(without3.reasons["a11y-worker-2"], both.reasons["a11y-worker-2"]);
  assert.deepEqual(without2.dispatched, ["a11y-worker-3"]);
  assert.deepEqual(without3.dispatched, ["a11y-worker-2"]);
});

test("tick: a worker with no MAC is never decided off, even idle past the threshold, and the report names it", async () => {
  const result = await tick({
    workers: [{ name: "a11y-worker-12", host: "192.0.2.20", mac: null }],
    probe: async () => ({ outcome: "idle" }),
    now: () => IDLE_THRESHOLD_MS,
    statePath: "x.json",
    read: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    write: () => {},
  });
  assert.deepEqual(result.decisions[0].decision, { action: "keep", reason: "no-mac" });
});

test("tick: an unreadable GitHub cannot change the decision -- no seam left for it to reach (#2734)", async () => {
  // No GH_TOKEN anywhere in this test's own environment: the old `readHoldState` (removed by #2737) would
  // have read `holdUnreadable: true` under exactly this condition and forced `keep, hold-unreadable` for
  // EVERY worker, per this file's former "An unreadable read is `keep` for EVERY worker" contract. `tick`'s
  // deps above carry no hold-read dependency to inject in the first place -- `DecisionInput` has no
  // `held`/`holdUnreadable` field -- so the decision below must come out exactly as every other idle-past-
  // threshold case in this file, proving the removal rather than merely asserting intent.
  const savedToken = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    const result = await tick({
      workers: WORKERS,
      probe: async () => ({ outcome: "idle" }),
      now: () => IDLE_THRESHOLD_MS,
      statePath: "x.json",
      read: alreadyIdleSince0,
      write: () => {},
    });
    assert.deepEqual(result.decisions[0].decision, { action: "off", reason: "idle-five-minutes" },
      "identical to the same probe, idleSince and MAC decided elsewhere in this file -- GH_TOKEN's "
      + "absence must not turn this into `keep, hold-unreadable`, because nothing left reads it");
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = savedToken;
  }
});

// ---------------------------------------------------------------------------------------------------------
// The capture ledger (#3208). A worker that boots, works and is powered off between two hourly
// `fleet-watch` polls is seen only here, by the 10 s probe, so what the last probe read must land in the
// ledger. The ledger is an in-memory map behind the injected `read`/`write`, so nothing touches `runs/`.
// ---------------------------------------------------------------------------------------------------------

const LEDGER = "ledger.json";
const BOOT_MS = 1_000_000;

function inMemoryFiles() {
  const files = new Map<string, string>();
  const read = ((path: string) => {
    const text = files.get(path);
    if (text === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return text;
  }) as never;
  const write = (path: string, data: string) => { files.set(path, String(data)); };
  return { files, read, write };
}

/** One tick against `files`, the worker answering `answer` (null = it never answers). */
async function tickAt(
  files: ReturnType<typeof inMemoryFiles>, now: number,
  answer: { outcome: "idle" | "busy", captures?: number, uptimeMinutes?: number } | null,
) {
  return tick({
    workers: WORKERS,
    probe: async () => (answer ?? { outcome: "no-answer", detail: "ETIMEDOUT" }),
    now: () => now,
    statePath: "state.json",
    capturesPath: LEDGER,
    read: files.read,
    write: files.write as never,
  });
}

const capturesIn24h = (files: ReturnType<typeof inMemoryFiles>, now: number) =>
  captureTimes(readCapturesState(LEDGER, files.read), now);

test("probeIdle: an answer carries vitals.captures and vitals.uptimeMinutes, and only when they are numbers (#3208)", async () => {
  const answering = (json: unknown) => async () => ({ status: 200, ok: true, text: "", json: json as never });
  assert.deepEqual(
    await probeIdle("http://x", { request: answering({ busy: false, vitals: { captures: 12, uptimeMinutes: 3 } }) }),
    { outcome: "idle", captures: 12, uptimeMinutes: 3 });
  assert.deepEqual(
    await probeIdle("http://x", { request: answering({ busy: true, vitals: { captures: "12", uptimeMinutes: null } }) }),
    { outcome: "busy" }, "a non-numeric vital is absent, never a guessed zero");
});

test("tick: a worker last probed at 12 captures and then powered off is recorded as 12 captures (#3208)", async () => {
  const files = inMemoryFiles();
  await tickAt(files, BOOT_MS, { outcome: "idle", captures: 0, uptimeMinutes: 0 });
  await tickAt(files, BOOT_MS + POLL_INTERVAL_MS, { outcome: "busy", captures: 7, uptimeMinutes: 1 });
  await tickAt(files, BOOT_MS + 2 * POLL_INTERVAL_MS, { outcome: "idle", captures: 12, uptimeMinutes: 1 });
  // Then the box is powered off between two hourly polls: from here on it never answers.
  await tickAt(files, BOOT_MS + 3 * POLL_INTERVAL_MS, null);
  const read = capturesIn24h(files, BOOT_MS + 3_600_000);
  assert.equal(read?.captures24h, 12, "the ledger the hourly poll reads must hold what the worker did");
  assert.equal(read?.lastCaptureAt, BOOT_MS + 2 * POLL_INTERVAL_MS, "dated at the probe that saw the rise");
});

test("tick: a worker that never answered records nothing -- not even a ledger (#3208)", async () => {
  const files = inMemoryFiles();
  await tickAt(files, BOOT_MS, null);
  await tickAt(files, BOOT_MS + POLL_INTERVAL_MS, { outcome: "idle" });
  assert.equal(files.files.has(LEDGER), false, "no reading, and a fresh ledger would claim `since` for nothing");
  assert.equal(capturesIn24h(files, BOOT_MS), null);
});

test("tick: a ledger that cannot be written is reported and does not stop the shutdown decision (#3208)", async () => {
  const files = inMemoryFiles();
  const stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as never;
  try {
    const result = await tick({
      workers: WORKERS,
      probe: async () => ({ outcome: "idle", captures: 3, uptimeMinutes: 1 }),
      now: () => IDLE_THRESHOLD_MS,
      statePath: "state.json",
      capturesPath: LEDGER,
      read: alreadyIdleSince0,
      write: ((path: string, data: string) => {
        if (path === LEDGER) throw new Error("ENOSPC");
        files.write(path, data);
      }) as never,
    });
    assert.deepEqual(result.decisions[0].decision, { action: "off", reason: "idle-five-minutes" });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.match(stderr.join(""), /capture ledger was not updated.*ENOSPC/);
});

test("writeCapturesState: the real write REPLACES the file, so a reader never sees a truncated one (#3208)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const path = join(dir, "fleet-captures-state.json");
    const alias = join(dir, "reader-holds-the-old-file.json");
    writeCapturesState(path, { since: 1, workers: {} });
    // A second name for the same inode stands in for a reader that has the file open: an in-place write
    // (`writeFileSync` on `path`) truncates and rewrites THAT inode and the alias changes with it, while a
    // rename leaves it the old, whole file.
    linkSync(path, alias);
    writeCapturesState(path, { since: 2, workers: {} });
    assert.equal(readCapturesState(path)?.since, 2);
    assert.equal(readCapturesState(alias)?.since, 1, "the old inode was written over in place, not replaced");
    assert.deepEqual(readdirSync(dir).sort(), ["fleet-captures-state.json", "reader-holds-the-old-file.json"],
      "no staging file is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A real process that records one worker's reading, its read held open for 150 ms and released only at a shared
// instant -- so two of them are inside read-modify-write at once, the interleave that rename alone cannot stop.
const RECORDER = `
  import { readFileSync } from "node:fs";
  const { WATCH: watch, LEDGER: path, WORKER: name, START: start } = process.env;
  const { recordCaptures } = await import(watch);
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const read = (p, enc) => { const text = readFileSync(p, enc); pause(150); return text; };
  while (Date.now() < Number(start)) pause(1);
  recordCaptures([{ name, state: "busy", captures: 12, uptimeMinutes: null }], { path, at: 1000, read });
`;

function recordFromAnotherProcess(path: string, name: string, start: number): Promise<number | null> {
  const watch = pathToFileURL(fileURLToPath(new URL("./fleet-watch.mjs", import.meta.url))).href;
  // Through the environment, not argv: fleet-watch's main guard `realpathSync`s `process.argv[1]` on import.
  const child = spawn(process.execPath, ["--input-type=module", "-e", RECORDER],
    { stdio: "inherit", env: { ...process.env, WATCH: watch, LEDGER: path, WORKER: name, START: String(start) } });
  return new Promise((resolve) => child.on("close", resolve));
}

test("recordCaptures: two processes recording at once both land in the ledger -- the second reads the first's write (#3208)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const path = join(dir, "fleet-captures-state.json");
    writeCapturesState(path, { since: 1, workers: {} });
    const start = Date.now() + 1500;
    const exits = await Promise.all([recordFromAnotherProcess(path, "a11y-worker-2", start),
      recordFromAnotherProcess(path, "a11y-worker-3", start)]);
    assert.deepEqual(exits, [0, 0]);
    assert.deepEqual(Object.keys(readCapturesState(path)?.workers ?? {}).sort(), ["a11y-worker-2", "a11y-worker-3"],
      "one writer's reading was overwritten by the other's snapshot");
    assert.equal(existsSync(`${path}.lock`), false, "the lock was left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock: a dead writer's aged lock is broken, and the lock is released after the work or a throw (#3208)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const path = join(dir, "fleet-captures-state.json");
    const lock = `${path}.lock`;
    writeFileSync(lock, "");
    const abandoned = new Date(Date.now() - 60_000);
    utimesSync(lock, abandoned, abandoned);
    assert.equal(withFileLock(path, () => "ran"), "ran");
    assert.equal(existsSync(lock), false, "released after the work");
    assert.throws(() => withFileLock(path, () => { throw new Error("boom"); }), /boom/);
    assert.equal(existsSync(lock), false, "released when the work throws");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------
// POLL_INTERVAL_MS -- pinned strictly under the shortest capture (12 s), or a capture entirely inside one
// gap would never be sampled busy at all (done-when 3).
// ---------------------------------------------------------------------------------------------------------

test("POLL_INTERVAL_MS is strictly shorter than the shortest measured capture (12 s)", () => {
  assert.ok(POLL_INTERVAL_MS < 12_000,
    `POLL_INTERVAL_MS (${POLL_INTERVAL_MS}) must be under 12 s or a capture could start and finish `
    + "entirely inside one gap and never be sampled busy");
});

// ---------------------------------------------------------------------------------------------------------
// The SHIPPED unit pair -- #2784. Everything above proves the decision; none of it reads the file systemd runs.
// ---------------------------------------------------------------------------------------------------------

const shippedUnit = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../ansible/files/${name}`, import.meta.url)), "utf8");
const activeLines = (unit: string) => unit.split("\n").filter((line) => !line.trimStart().startsWith("#"));

test("#2784: the service passes --apply, or the timer is a report on a clock", () => {
  // THE FAILURE IS INVISIBLE ELSEWHERE: a unit running the bare script is installed, enabled, active,
  // exits 0, and prints fifteen lines every ten seconds while nothing powers off. #2734 flipped the timer
  // live with exactly this unit and both rows closed on a fleet idle for 25h+.
  const execStart = activeLines(shippedUnit("a11y-fleet-auto-off.service")).filter((l) => l.startsWith("ExecStart="));
  assert.deepEqual(execStart,
    ["ExecStart=/usr/bin/node /root/a11y-witness/packages/control/src/fleet-auto-off.mjs --apply"]);
});

test("#2784: the service runs from the checkout, or its relative state path is ENOENT on every tick", () => {
  // Read live on a11y-control at 09:40Z: with no WorkingDirectory the unit starts in `/`, and
  // `writeState("runs/fleet-auto-off-state.json")` throws ENOENT, so the timer fails every ten seconds
  // and never dispatches. The state path must stay relative to the directory the unit names.
  const active = activeLines(shippedUnit("a11y-fleet-auto-off.service"));
  assert.deepEqual(active.filter((l) => l.startsWith("WorkingDirectory=")), ["WorkingDirectory=/root/a11y-witness"]);
  assert.ok(!DEFAULT_STATE_PATH.startsWith("/"), "if the state path becomes absolute, this pin and the unit line can go");
});

test("#2784: the timer polls under the shortest capture and fires the service the playbook installs", () => {
  const timer = activeLines(shippedUnit("a11y-fleet-auto-off.timer")).join("\n");
  assert.match(timer, /^OnUnitActiveSec=10s$/m, `${POLL_INTERVAL_MS} ms, so a poll lands inside any capture`);
  assert.match(timer, /^Unit=a11y-fleet-auto-off\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m, "an [Install] section, or `enable` has nothing to enable");
  const playbook = readFileSync(fileURLToPath(new URL("../ansible/auto-off-schedule.yml", import.meta.url)), "utf8");
  assert.match(playbook, /- a11y-fleet-auto-off\.timer\n\s+- a11y-fleet-auto-off\.service/,
    "the playbook installs both files of the pair");
});
