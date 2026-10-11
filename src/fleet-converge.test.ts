// a11ign#5023: the scripted run that wakes, deploys and provisions with bounded retries of the known causes.
// Every effect is injected: no box, no control plane, no playbook. The lock tests run the REAL lock command against a
// directory of this machine's (as `fleet-lock.test.ts` does), because "the run's own deploy would refuse it" is a claim
// about `lockTakeStep`, which is imported and not restated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTEMPTS_PER_BOX, WAKE_LOCK_RUN_MS, WHOLE_FLEET, converge, failuresIn, recapOf, resolveLayerRefs, runConverge, wakeMessage,
  type Effects, type PlayRequest, type PlayRun,
} from "./fleet-converge.ts";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { expireFleetLock, readFleetLock, takeFleetLock } from "./fleet-lock.ts";
import { lockTakeStep } from "./fleet-playbook.ts";
import { WAKE_LOCK_OPERATION } from "./fleet-wake.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures: the lines are the real ones (a11ign#4948), around ansible's own framing.
// ---------------------------------------------------------------------------------------------------------------------

const UPDATER_TASK = "TASK [worker : Refuse to call this provisioned unless Edge is the pinned build and the updater is off] ***";
const UPDATER_FATAL = (box: string) => `fatal: [${box}]: FAILED! => {"changed": false, "msg": "scheduled task MicrosoftEdgeUpdateTaskMachineCore is Ready, expected Disabled; `
  + `scheduled task MicrosoftEdgeUpdateTaskMachineUA is Ready, expected Disabled; service edgeupdate is Running, expected Stopped"}`;
const UNREACHABLE_FATAL = (box: string) => `fatal: [${box}]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: ssh: connect to host 10.0.0.3 port 22: No route to host", "unreachable": true}`;
const recap = (rows: Array<[string, number, number]>) => ["PLAY RECAP *********", ...rows.map(([box, unreachable, failed]) =>
  `${box.padEnd(24)}: ok=87   changed=3    unreachable=${unreachable}    failed=${failed}    skipped=2    rescued=0    ignored=0`)].join("\n");

const edgeFailure = (...boxes: string[]): PlayRun => ({ status: 2, output: [UPDATER_TASK, ...boxes.map(UPDATER_FATAL), recap(boxes.map((b) => [b, 0, 1]))].join("\n") });
const unreachableFailure = (...boxes: string[]): PlayRun => ({ status: 4, output: ["TASK [Gathering Facts] ***", ...boxes.map(UNREACHABLE_FATAL), recap(boxes.map((b) => [b, 1, 0]))].join("\n") });
const PASS: PlayRun = { status: 0, output: recap([["a11y-worker-2", 0, 0], ["a11y-worker-3", 0, 0]]) };

const WORKERS = [{ name: "a11y-worker-2", host: "10.0.0.2", mac: null }, { name: "a11y-worker-3", host: "10.0.0.3", mac: null }];
const REFS = { "nvda-worker": "a".repeat(40), "screenreader-fleet": "b".repeat(40) };

type Script = { plays?: Record<string, PlayRun[]>; wakes?: Array<string[]>; throwOn?: string; take?: Effects["take"] };

/** Effects that record every call in order, so "before the first step" and "once" are readings of one list. */
function harness(script: Script = {}) {
  const events: string[] = [];
  const plays: PlayRequest[] = [];
  const messages: string[] = [];
  const posts: Array<{ row: number; body: string }> = [];
  const queues = new Map(Object.entries(script.plays ?? {}).map(([k, v]) => [k, [...v]]));
  const wakeScript = [...(script.wakes ?? [])];
  const effects: Effects = {
    now: () => 1_000_000,
    take: script.take ?? ((call) => {
      events.push(`take:${call.operation}`);
      return { taken: true, lock: { operation: call.operation, holder: "h", takenAt: call.now, expiresAt: call.now + call.longestRunMs }, replacedUnreadable: false };
    }),
    end: (call) => { events.push(`end:${call.operation}`); return { ended: true }; },
    wake: async (targets) => {
      events.push(`wake:${targets.map((t) => t.name).join(",")}`);
      const stillDown = wakeScript.shift() ?? [];
      return targets.map((t) => ({ ...t, state: stillDown.includes(t.name) ? "no-answer" : "woken", packets: 3 }));
    },
    runPlay: async (request) => {
      const key = request.script === "fleet-status.ts" ? "status" : request.args[0].replace("--playbook=", "").replace(".yml", "").replace("provision-role", "provision");
      events.push(`play:${key}`);
      plays.push(request);
      if (script.throwOn === key) throw new Error(`${key} blew up`);
      const queue = queues.get(key);
      return queue?.shift() ?? { status: 0, output: key === "status" ? "fleet: 2 of 2 serving" : PASS.output };
    },
    log: () => {},
    notify: (message) => { events.push("notify"); messages.push(message); return null; },
    post: (row, body) => { events.push(`post:${row}`); posts.push({ row, body }); return null; },
    save: () => { events.push("save"); },
  };
  return { effects, events, plays, messages, posts };
}

const attemptsOf = (plays: PlayRequest[], playbook: string) => plays.filter((p) => p.args[0] === `--playbook=${playbook}`).length;

// ---------------------------------------------------------------------------------------------------------------------
// The cause patterns
// ---------------------------------------------------------------------------------------------------------------------

test("the two known causes match the real lines of #4948, per box", () => {
  assert.deepEqual(failuresIn(unreachableFailure("a11y-worker-3").output).map(({ box, cause }) => ({ box, cause })),
    [{ box: "a11y-worker-3", cause: "unreachable" }]);
  assert.deepEqual(failuresIn(edgeFailure("a11y-worker-3", "a11y-worker-5").output).map(({ box, cause }) => ({ box, cause })),
    [{ box: "a11y-worker-3", cause: "edge-updater-ready" }, { box: "a11y-worker-5", cause: "edge-updater-ready" }]);
});

test("negative controls: a different failure, and an Edge that is the WRONG BUILD, are unknown and not the updater", () => {
  const other = ["TASK [worker : Install NVDA] ***", 'fatal: [a11y-worker-3]: FAILED! => {"msg": "msiexec exited 1603"}'].join("\n");
  assert.deepEqual(failuresIn(other).map((f) => f.cause), ["unknown"]);
  // The same guard task, but the build is wrong: a retry does not move a pin, so it must not be retried as the updater.
  const wrongBuild = [UPDATER_TASK, 'fatal: [a11y-worker-3]: FAILED! => {"msg": "Edge is 152.0.4191.66, expected 155.0.4283.45; scheduled task MicrosoftEdgeUpdateTaskMachineCore is Ready, expected Disabled"}'].join("\n");
  assert.deepEqual(failuresIn(wrongBuild).map((f) => f.cause), ["unknown"]);
  // The Ready message under ANOTHER task is not the guard's.
  const elsewhere = ["TASK [worker : Something else] ***", UPDATER_FATAL("a11y-worker-3")].join("\n");
  assert.deepEqual(failuresIn(elsewhere).map((f) => f.cause), ["unknown"]);
});

test("a failure the play itself ignored is not a failure; a clean recap is none", () => {
  const ignored = [UPDATER_TASK, UPDATER_FATAL("a11y-worker-3"), "...ignoring", recap([["a11y-worker-3", 0, 0]])].join("\n");
  assert.deepEqual(failuresIn(ignored), []);
  assert.deepEqual(failuresIn(PASS.output), [], "positive control below: the same reader DOES find the failure when it is not ignored");
  assert.equal(failuresIn(ignored.replace("...ignoring\n", "")).length, 1);
});

test("a recap with a count and no fatal line falls back to what the count says, and a bare failed count is unknown", () => {
  assert.deepEqual(failuresIn(recap([["a11y-worker-4", 1, 0]])).map((f) => f.cause), ["unreachable"]);
  assert.deepEqual(failuresIn(recap([["a11y-worker-4", 0, 2]])).map((f) => f.cause), ["unknown"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------------------

test("an unreachable box is woken and retried, and the run ends ok when the second attempt passes; nobody is woken", async () => {
  const h = harness({ plays: { deploy: [unreachableFailure("a11y-worker-3"), PASS] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "ok");
  assert.equal(attemptsOf(h.plays, "deploy.yml"), 2, "the failed play ran again");
  assert.deepEqual(h.events.filter((e) => e.startsWith("wake:")), ["wake:a11y-worker-2,a11y-worker-3", "wake:a11y-worker-3"],
    "the first is the sweep; the second wakes ONLY the box that was unreachable");
  assert.deepEqual(result.perBox["a11y-worker-3"], { causes: ["unreachable"], attempts: 2 });
  assert.deepEqual(result.perBox["a11y-worker-2"], { causes: [], attempts: 1 });
  assert.equal(h.messages.length, 0, "a success wakes nobody");
});

test("the Edge updater cause is retried without a wake and ends ok when the retry passes", async () => {
  const h = harness({ plays: { provision: [edgeFailure("a11y-worker-3"), PASS] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "ok");
  assert.equal(attemptsOf(h.plays, "provision-role.yml"), 2);
  assert.deepEqual(h.events.filter((e) => e.startsWith("wake:")), ["wake:a11y-worker-2,a11y-worker-3"], "no re-wake: the box was up");
  assert.deepEqual(result.perBox["a11y-worker-3"].causes, ["edge-updater-ready"]);
  assert.equal(h.messages.length, 0);
});

test("the same cause exhausted after 3 attempts ends failed and wakes the orchestrator ONCE", async () => {
  const h = harness({ plays: { provision: [edgeFailure("a11y-worker-3"), edgeFailure("a11y-worker-3"), edgeFailure("a11y-worker-3"), PASS] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, row: 5023, effects: h.effects });
  assert.equal(ATTEMPTS_PER_BOX, 3);
  assert.equal(result.status, "failed");
  assert.equal(attemptsOf(h.plays, "provision-role.yml"), 3, "three attempts and no fourth, though a passing one was queued");
  assert.equal(h.messages.length, 1, "one call, not one per attempt");
  assert.match(h.messages[0], /FAILED.*known cause that exhausted/);
  assert.equal(h.plays.filter((p) => p.script === "fleet-status.ts").length, 0, "a failed run does not go on to read the fleet as if it had converged");
});

test("an unmatched error is unknown, is NOT retried, and wakes once", async () => {
  const other = { status: 2, output: ["TASK [worker : Install NVDA] ***", 'fatal: [a11y-worker-3]: FAILED! => {"msg": "msiexec exited 1603"}', recap([["a11y-worker-3", 0, 1]])].join("\n") };
  const h = harness({ plays: { deploy: [other, PASS] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "unknown");
  assert.equal(attemptsOf(h.plays, "deploy.yml"), 1, "positive control: a known cause WOULD have been retried (the tests above)");
  assert.equal(attemptsOf(h.plays, "provision-role.yml"), 0, "the run stopped at the first unknown");
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /UNKNOWN/);
  assert.match(result.reason ?? "", /msiexec exited 1603/);
});

test("one unknown box among known ones stops the run: retrying the others would bury it", async () => {
  const mixed = { status: 2, output: [UPDATER_TASK, UPDATER_FATAL("a11y-worker-2"), "TASK [worker : Install NVDA] ***", 'fatal: [a11y-worker-3]: FAILED! => {"msg": "boom"}'].join("\n") };
  const h = harness({ plays: { provision: [mixed, PASS] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "unknown");
  assert.equal(attemptsOf(h.plays, "provision-role.yml"), 1);
});

test("a nonzero exit that names no box (a refusal) is unknown, and the whole fleet is the box", async () => {
  const refusal = { status: 2, output: "REFUSING deploy.yml: fleet:status holds this write at layer 2 (#1313).\n  off the network:  a11y-worker-7" };
  const h = harness({ plays: { deploy: [refusal] } });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "unknown");
  assert.ok(result.perBox[WHOLE_FLEET], "the play's failure is recorded against a name no inventory box has");
  assert.match(result.reason ?? "", /layer 2/);
});

test("a box that will not wake again ends failed at once, without spending the play's retries", async () => {
  const h = harness({ plays: { deploy: [unreachableFailure("a11y-worker-3"), PASS] },
    wakes: [[], ["a11y-worker-3"], ["a11y-worker-3"], ["a11y-worker-3"]] });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "failed");
  assert.equal(attemptsOf(h.plays, "deploy.yml"), 1);
  assert.match(result.reason ?? "", /would not wake again/);
  assert.equal(h.messages.length, 1);
});

test("a box that does not come up in the first sweep is re-woken up to the cap, then the run ends failed", async () => {
  const down = ["a11y-worker-2"];
  const h = harness({ wakes: [down, down, down] });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "failed");
  assert.equal(h.plays.length, 0, "no play runs against a fleet that is not up");
  assert.equal(h.events.filter((e) => e.startsWith("wake:")).length, ATTEMPTS_PER_BOX);
  assert.equal(h.messages.length, 1);
});

test("a clean run wakes nobody, posts once on the row, and reads fleet:status last", async () => {
  const h = harness();
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, row: 5023, effects: h.effects });
  assert.equal(result.status, "ok");
  assert.equal(h.messages.length, 0);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].row, 5023);
  assert.deepEqual(h.events.filter((e) => e.startsWith("play:")), ["play:deploy", "play:provision", "play:status"]);
  assert.match(recapOf(result), /^fleet-converge: OK/);
  assert.equal(wakeMessage(result), null);
});

test("provision runs --serial=0, and no play is handed a flag it would refuse", async () => {
  const h = harness();
  await converge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  const provision = h.plays.find((p) => p.args[0] === "--playbook=provision-role.yml");
  assert.ok(provision?.args.includes("--serial=0"));
  assert.ok(!h.plays.find((p) => p.args[0] === "--playbook=deploy.yml")?.args.includes("--serial=0"));
});

// ---------------------------------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------------------------------

test("the lock is taken as operation `wake` BEFORE the first step, and ended after the last", async () => {
  const h = harness();
  await converge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.deepEqual(h.events.slice(0, 2), [`take:${WAKE_LOCK_OPERATION}`, "wake:a11y-worker-2,a11y-worker-3"]);
  assert.equal(h.events.at(-1), `end:${WAKE_LOCK_OPERATION}`);
  assert.equal(WAKE_LOCK_OPERATION, "wake");
  assert.ok(WAKE_LOCK_RUN_MS > 0);
});

test("the lock is ended on EVERY exit: a failed run, an unknown one, and a play that THROWS", async () => {
  const failed = harness({ plays: { provision: [edgeFailure("a11y-worker-3"), edgeFailure("a11y-worker-3"), edgeFailure("a11y-worker-3")] } });
  assert.equal((await converge({ workers: WORKERS, layerRefs: REFS, effects: failed.effects })).status, "failed");
  assert.equal(failed.events.at(-1), "end:wake");

  const unknown = harness({ plays: { deploy: [{ status: 1, output: "boom" }] } });
  assert.equal((await converge({ workers: WORKERS, layerRefs: REFS, effects: unknown.effects })).status, "unknown");
  assert.equal(unknown.events.at(-1), "end:wake");

  const thrown = harness({ throwOn: "provision" });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: thrown.effects });
  assert.equal(result.status, "unknown");
  assert.match(result.reason ?? "", /provision blew up/);
  assert.equal(thrown.events.filter((e) => e === "end:wake").length, 1, "ended once, though the step threw");
  assert.equal(thrown.messages.length, 1);
});

test("a lock another operation holds means the run does not start, wakes nobody's boxes, and ends nothing it never took", async () => {
  const held = { operation: "provision-role.yml", holder: "other:1", takenAt: 1, expiresAt: 9_999_999_999 };
  const h = harness({ take: () => ({ taken: false, held }) });
  const result = await runConverge({ workers: WORKERS, layerRefs: REFS, effects: h.effects });
  assert.equal(result.status, "unknown");
  assert.match(result.reason ?? "", /provision-role\.yml.*did not start/);
  assert.deepEqual(h.events.filter((e) => /^(wake|play|end)/.test(e)), [], "no step, and no end of a lock that was not ours");
  assert.equal(h.messages.length, 1);
});

/** The control plane's filesystem as a directory of this machine's, running the REAL lock command (as `fleet-lock.test.ts`). */
function controlPlane() {
  const root = mkdtempSync(join(tmpdir(), "converge-lock-"));
  const transport = (command: string) => execFileSync("sh", ["-c", command.replaceAll(CONTROL_PLANE_CHECKOUT_PATH, root)], { encoding: "utf8" });
  return { transport, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("a lock under the name `wake` is taken over by the run's own deploy; under ANY other name it is refused (the negative control)", () => {
  const NOW = 5_000_000;
  const plane = controlPlane();
  try {
    const take = (call: Parameters<typeof takeFleetLock>[0]) => takeFleetLock({ ...call, transport: plane.transport });
    const end = (call: Parameters<typeof expireFleetLock>[0]) => expireFleetLock({ ...call, transport: plane.transport });

    assert.equal(take({ operation: WAKE_LOCK_OPERATION, longestRunMs: WAKE_LOCK_RUN_MS, now: NOW, holder: "run:1" }).taken, true);
    const own = lockTakeStep({ chosen: "deploy.yml", followBudgetMs: 1_800_000, now: NOW + 1, take, end });
    assert.equal(own.refusal, null, "the run's own deploy takes a `wake` lock over");
    assert.match(own.notice ?? "", /took over/);
    // The deploy ended the wake lock by ITS holder name, so the run's own end finds the lock is no longer its own.
    const ended = expireFleetLock({ operation: WAKE_LOCK_OPERATION, holder: "run:1", now: NOW + 2, transport: plane.transport });
    assert.equal(ended.ended, false, "a play took it over: nothing the run does shortens the play's lock");
    assert.equal(readFleetLock(NOW + 3, { transport: plane.transport }).state, "held", "the play's lock still stands");
  } finally {
    plane.dispose();
  }

  const other = controlPlane();
  try {
    const take = (call: Parameters<typeof takeFleetLock>[0]) => takeFleetLock({ ...call, transport: other.transport });
    const end = (call: Parameters<typeof expireFleetLock>[0]) => expireFleetLock({ ...call, transport: other.transport });
    assert.equal(take({ operation: "fleet-converge", longestRunMs: WAKE_LOCK_RUN_MS, now: NOW, holder: "run:1" }).taken, true);
    const refused = lockTakeStep({ chosen: "deploy.yml", followBudgetMs: 1_800_000, now: NOW + 1, take, end });
    assert.match(refused.refusal ?? "", /REFUSING deploy\.yml: the fleet lock is held by fleet-converge/,
      "a lock under the run's own name would refuse the run's own deploy");
  } finally {
    other.dispose();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The layer refs
// ---------------------------------------------------------------------------------------------------------------------

const LAYERS = [
  { name: "nvda-worker", remote: "https://example.test/screenreader-worker.git", laidAt: "/root/a11y-witness/packages/nvda-worker/.layer-ref" },
  { name: "screenreader-fleet", remote: "https://example.test/screenreader-fleet.git", laidAt: "/root/a11y-witness/packages/worker-fleet/.layer-ref" },
];
const LAID: Record<string, string> = { "nvda-worker": "v0.9.0\n", "screenreader-fleet": "v0.7.3\n" };
const COMMITS: Record<string, string> = { "v0.9.0": "dc8f506c".padEnd(40, "0"), "v0.7.3": "c355b8ed".padEnd(40, "0") };

test("the pair is derived from the laid tags, and BOTH plays are passed it", async () => {
  const pinned = resolveLayerRefs({ layers: LAYERS, readLaidTag: (l) => LAID[l.name], commitOfTag: ({ tag }) => COMMITS[tag] });
  assert.deepEqual(pinned, { refs: { "nvda-worker": COMMITS["v0.9.0"], "screenreader-fleet": COMMITS["v0.7.3"] } });
  assert.ok("refs" in pinned);

  const h = harness();
  await converge({ workers: WORKERS, layerRefs: pinned.refs, effects: h.effects });
  for (const playbook of ["deploy.yml", "provision-role.yml"]) {
    const play = h.plays.find((p) => p.args[0] === `--playbook=${playbook}`);
    assert.ok(play, `${playbook} ran`);
    assert.deepEqual(play.args.filter((a) => a.startsWith("--layer-ref=")),
      [`--layer-ref=nvda-worker=${COMMITS["v0.9.0"]}`, `--layer-ref=screenreader-fleet=${COMMITS["v0.7.3"]}`]);
  }
});

test("a tag that does not resolve is a refusal NAMING the layer, its tag and its remote; every such layer is named at once", () => {
  const refusal = resolveLayerRefs({ layers: LAYERS, readLaidTag: (l) => LAID[l.name], commitOfTag: ({ tag }) => (tag === "v0.9.0" ? undefined : COMMITS[tag]) });
  assert.ok("refusal" in refusal);
  assert.match(refusal.refusal, /layer nvda-worker is laid at v0\.9\.0, and https:\/\/example\.test\/screenreader-worker\.git holds no such tag/);
  assert.doesNotMatch(refusal.refusal, /layer screenreader-fleet/, "the layer that resolved is not named as a problem");
  const both = resolveLayerRefs({ layers: LAYERS, readLaidTag: (l) => LAID[l.name], commitOfTag: () => undefined });
  assert.ok("refusal" in both && /nvda-worker/.test(both.refusal) && /screenreader-fleet/.test(both.refusal));
});

test("an unreadable laid tag, a value that is not a tag, git not answering, and no layers at all are each a refusal, never a default", () => {
  const unreadable = resolveLayerRefs({ layers: LAYERS, readLaidTag: () => { throw new Error("ENOENT"); }, commitOfTag: () => undefined });
  assert.ok("refusal" in unreadable && /could not be read.*ENOENT/.test(unreadable.refusal));
  const notATag = resolveLayerRefs({ layers: LAYERS, readLaidTag: () => "main; rm -rf /", commitOfTag: () => COMMITS["v0.9.0"] });
  assert.ok("refusal" in notATag && /is not a tag/.test(notATag.refusal));
  const gitDown = resolveLayerRefs({ layers: LAYERS, readLaidTag: (l) => LAID[l.name], commitOfTag: () => ({ failed: "network is unreachable" }) });
  assert.ok("refusal" in gitDown && /could not be asked for v0\.9\.0 \(network is unreachable\)/.test(gitDown.refusal));
  const none = resolveLayerRefs({ layers: [], readLaidTag: () => "", commitOfTag: () => undefined });
  assert.ok("refusal" in none && /nothing to pin/.test(none.refusal));
});
