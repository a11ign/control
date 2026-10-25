/**
 * WHAT THE FACTS PLAY SAID, AND HOW IT IS RUN (A11-283): the JSON callback's document read for one box, and the real reader's wake, command line and environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { m720q } from "./facts.fixture.ts";
import { FACTS_TASK, jsonOf, playOutcome } from "./play-result.ts";
import { FACTS_PLAYBOOK, factsReader, playEnv } from "./read.ts";
import type { PlayRun } from "./read.ts";

const BOX = "a11y-worker-2";

const document = (over: { host?: Record<string, unknown>; stats?: Record<string, unknown> | null; task?: string } = {}) => JSON.stringify({
  plays: [
    { play: { name: "The workers must be in the inventory" }, tasks: [] },
    { play: { name: "Read the workers' hardware" }, tasks: [{ task: { name: over.task ?? FACTS_TASK }, hosts: { [BOX]: { changed: false, result: m720q(), output: [], ...over.host } } }] },
  ],
  stats: over.stats === null ? {} : { [BOX]: { ok: 1, changed: 0, failures: 0, unreachable: 0, skipped: 0 }, ...over.stats },
});

test("a box the play read: its changed count and the structure the task returned", () => {
  const outcome = playOutcome(document(), BOX);
  assert.ok(outcome.ok);
  assert.equal(outcome.read.changed, 0);
  assert.deepEqual(outcome.read.output, m720q());
});

test("the changed count is the callback's own, so a play that changed a thing says so", () => {
  const outcome = playOutcome(document({ stats: { [BOX]: { ok: 1, changed: 3, failures: 0, unreachable: 0 } } }), BOX);
  assert.ok(outcome.ok);
  assert.equal(outcome.read.changed, 3);
});

test("a task whose output is a JSON string is read as the structure it holds", () => {
  const outcome = playOutcome(document({ host: { result: {}, output: [JSON.stringify(m720q())] } }), BOX);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.read.output, m720q());
});

test("an unreachable box is said, with the message ssh gave", () => {
  const outcome = playOutcome(document({ host: { unreachable: true, msg: "ssh: connect to host a11y-worker-2 port 22: No route to host", result: undefined }, stats: { [BOX]: { unreachable: 1, changed: 0, failures: 0 } } }), BOX);
  assert.deepEqual(outcome, { ok: false, error: `${BOX} was unreachable over ssh: ssh: connect to host a11y-worker-2 port 22: No route to host` });
});

test("a failed task is said, with its name and message", () => {
  const outcome = playOutcome(document({ host: { failed: true, msg: "The term 'Get-Tpm' is not recognized" }, stats: { [BOX]: { failures: 1, changed: 0, unreachable: 0 } } }), BOX);
  assert.deepEqual(outcome, { ok: false, error: `the play failed on ${BOX} at "${FACTS_TASK}": The term 'Get-Tpm' is not recognized` });
});

test("a box the play never reached has no stats and is a failure, not a box with nothing to report", () => {
  assert.deepEqual(playOutcome(document({ stats: null }), BOX), { ok: false, error: `the play reached no host named ${BOX}` });
});

test("a play that ran no facts task on the box is a failure", () => {
  assert.match((playOutcome(document({ task: "Something else" }), BOX) as { error: string }).error, /ran no "Read the box's hardware" task/);
});

test("stdout that is not the callback's document is a failure that quotes it", () => {
  const outcome = playOutcome("ERROR! the playbook could not be found", BOX);
  assert.deepEqual(outcome, { ok: false, error: `the play printed no result for ${BOX}: ERROR! the playbook could not be found` });
});

test("a line printed after the document does not hide it", () => {
  assert.deepEqual(jsonOf(`{\n "stats": {}\n}\nPLAYBOOK RECAP took 3s\n`), { stats: {} });
});

test("the play runs with the JSON callback, the profile callback off, the checkout's config, and a HOME when the unit has none", () => {
  const env = playEnv("/root/fleet-jobs", { PATH: "/usr/bin" });
  assert.equal(env.ANSIBLE_STDOUT_CALLBACK, "json");
  assert.equal(env.ANSIBLE_CALLBACKS_ENABLED, "");
  assert.equal(env.ANSIBLE_CONFIG, "/root/fleet-jobs/ansible/ansible.cfg");
  assert.equal(env.HOME, "/root");
  assert.equal(playEnv("/x", { HOME: "/home/svc" }).HOME, "/home/svc");
});

const inventory = () => [{ name: BOX, url: "http://10.0.0.2:8765", mac: "aa:bb:cc:dd:ee:ff" }];
const woken = (state: string) => async (targets: { name: string; mac?: string | null }[]) => targets.map((t) => ({ ...t, host: "10.0.0.2", state, packets: 3 }));

test("the real reader wakes the one box with its MAC, then runs facts.yml limited to it from the service's checkout", async () => {
  const woke: unknown[] = [];
  const runs: PlayRun[] = [];
  const read = factsReader({
    checkout: "/root/fleet-jobs", inventory,
    wake: async (targets) => { woke.push(targets); return woken("already-up")(targets); },
    run: async (run) => { runs.push(run); return { stdout: document() }; },
  });
  const result = await read({ name: BOX, url: "http://10.0.0.2:8765" });
  assert.deepEqual(woke, [[{ name: BOX, host: "10.0.0.2", mac: "aa:bb:cc:dd:ee:ff" }]]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.file, "ansible-playbook");
  assert.deepEqual(runs[0]!.args, [FACTS_PLAYBOOK, "--limit", BOX]);
  assert.equal(runs[0]!.cwd, "/root/fleet-jobs");
  assert.equal(runs[0]!.timeoutMs, 600_000);
  assert.equal(result.changed, 0);
});

test("a box that does not come up when woken rejects with the reason, and the play is never run", async () => {
  let ran = false;
  const read = factsReader({ inventory, wake: woken("no-answer"), run: async () => { ran = true; return { stdout: "" }; } });
  await assert.rejects(read({ name: BOX, url: "http://10.0.0.2:8765" }), new RegExp(`^Error: ${BOX} did not come up when woken`));
  assert.equal(ran, false);
});

test("a play that finds the box unreachable rejects with the play's reason", async () => {
  const read = factsReader({ inventory, wake: woken("already-up"), run: async () => ({ stdout: document({ host: { unreachable: true, msg: "Permission denied (publickey)" }, stats: { [BOX]: { unreachable: 1, changed: 0, failures: 0 } } }) }) });
  await assert.rejects(read({ name: BOX, url: "http://10.0.0.2:8765" }), /was unreachable over ssh: Permission denied \(publickey\)/);
});

test("a box that is not in the inventory is refused before anything is woken", async () => {
  const read = factsReader({ inventory: () => [], wake: async () => { throw new Error("woke"); }, run: async () => { throw new Error("ran"); } });
  await assert.rejects(read({ name: BOX, url: "http://10.0.0.2:8765" }), new RegExp(`${BOX} is not in the inventory`));
});
