/**
 * #3851: the control plane's external heartbeat. Every clock, read, send and file is injected, so the decision is
 * proven offline -- the resource ban bars a live read of the fleet and nothing here reaches a network.
 *
 * The tick is the `updated_at` of a standing comment on a11ign/a11ign#3880 (#3897), so a fixture is the comment's
 * `{created_at, updated_at}` as the reader asks for them.
 */
// no-token: gh -- the CLI tests below put a FAKE `gh` first on PATH; nothing here spawns the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STALE_AFTER_MS, READ_TIMEOUT_MS, HEARTBEAT_COMMENT_ID, TELEGRAM_TOKEN_FILE, GH_TOKEN_FILE, judgeTick, messageFor, run, readGateLastTick, telegramSender,
} from "./gate-heartbeat.mjs";
import { shippedControlUnits } from "./control-unit-drift.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ANSIBLE = join(HERE, "..", "ansible");
const MINUTE = 60_000;
const NOW = Date.parse("2026-10-06T20:00:00Z");
const CREATED = Date.parse("2026-10-06T10:00:00Z");

/** The comment body the reader returns for a tick at `updatedMs`; GitHub stamps whole seconds. */
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000", "");
const comment = (updatedMs: number, createdMs = CREATED) => JSON.stringify({ created_at: iso(createdMs), updated_at: iso(updatedMs) });

/** A run of the whole decision against a scripted clock, recording what was sent and what was remembered. */
function harness({ stateFile = "none", sendResult = { ok: true } } = {}) {
  let standing = stateFile;
  const sent: string[] = [];
  let tickAt: number | null = NOW;
  let clock = NOW;
  let readFails: string | null = null;
  let sendOk = sendResult.ok;
  const step = (minutesLater: number) => {
    clock = NOW + minutesLater * MINUTE;
    return run({
      now: () => clock,
      read: () => (readFails ? { ok: false, reason: readFails } : { ok: true, value: comment(tickAt!) }),
      send: async (text: string) => { if (sendOk) sent.push(text); return sendOk ? { ok: true } : { ok: false, reason: "refused" }; },
      loadStanding: () => standing as never,
      saveStanding: (s: string) => { standing = s; },
    });
  };
  return {
    step, sent, standing: () => standing,
    lastTickAt: (minutesAfterNow: number) => { tickAt = NOW + minutesAfterNow * MINUTE; },
    failRead: (reason: string | null) => { readFails = reason; },
    sendWorks: (ok: boolean) => { sendOk = ok; },
  };
}

// ---------------------------------------------------------------------------------------------------------
// judgeTick -- the boundary, and the values that are not a time.
// ---------------------------------------------------------------------------------------------------------

test("judgeTick: nine minutes is fresh, exactly ten is fresh, eleven is stale", () => {
  for (const [minutes, status] of [[9, "fresh"], [10, "fresh"], [11, "stale"]] as const) {
    const verdict = judgeTick(comment(NOW - minutes * MINUTE), NOW);
    assert.equal(verdict.status, status, `${minutes} min`);
  }
  assert.equal(STALE_AFTER_MS, 10 * MINUTE);
});

test("judgeTick: a body that is not a comment with two times is CANNOT_TELL, never fresh", () => {
  const good = { created_at: "2026-10-06T10:00:00Z", updated_at: "2026-10-06T19:59:00Z" };
  assert.equal(judgeTick(JSON.stringify(good), NOW).status, "fresh", "the control: this shape reads");
  for (const body of [
    "", "   ", "null", "yesterday", "[]", "1791318587803", "{}", '{"message":"Not Found","status":"404"}',
    JSON.stringify({ ...good, updated_at: null }), JSON.stringify({ ...good, updated_at: "1791318587803" }),
    JSON.stringify({ ...good, updated_at: "2026-13-45T99:99:99Z" }), JSON.stringify({ updated_at: good.updated_at }),
  ]) {
    assert.equal(judgeTick(body, NOW).status, "cannot-tell", JSON.stringify(body));
  }
});

test("judgeTick: an updated_at earlier than the comment's own created_at is CANNOT_TELL, not stale", () => {
  const verdict = judgeTick(comment(CREATED - MINUTE), NOW);
  assert.equal(verdict.status, "cannot-tell");
  assert.match(verdict.status === "cannot-tell" ? verdict.reason : "", /earlier than its created_at/);
});

test("judgeTick: a stamp a little ahead of this clock is fresh at age zero (GitHub's clock is the reference)", () => {
  const verdict = judgeTick(comment(NOW + 30_000), NOW);
  assert.deepEqual(verdict, { status: "fresh", ageMs: 0, atMs: NOW + 30_000 });
});

// ---------------------------------------------------------------------------------------------------------
// run -- one message per outage, a recovery, a re-arm.
// ---------------------------------------------------------------------------------------------------------

test("an 11-minute-old tick sends ONE message naming the age; 11 then 12 minutes sends none more; a fresh tick sends one recovery and re-arms", async () => {
  const h = harness();
  h.lastTickAt(0);

  await h.step(11);
  assert.equal(h.sent.length, 1, "the first run past ten minutes must send exactly one message");
  assert.match(h.sent[0], /STALE/);
  assert.match(h.sent[0], /11 min/, "the message names the age");

  await h.step(12);
  await h.step(13);
  assert.equal(h.sent.length, 1, "the same outage, still stale: no second message");

  h.lastTickAt(14);
  await h.step(14.5);
  assert.equal(h.sent.length, 2, "a fresh tick after the outage sends one recovery line");
  assert.match(h.sent[1], /RECOVERED/);

  await h.step(15);
  assert.equal(h.sent.length, 2, "recovered and still fresh: quiet");

  await h.step(14 + 11);
  assert.equal(h.sent.length, 3, "the re-armed alert fires again on the NEXT outage");
  assert.match(h.sent[2], /STALE/);
});

test("POSITIVE CONTROL: a tick of 9 minutes sends nothing, and the same harness sends for 11", async () => {
  const quiet = harness();
  quiet.lastTickAt(0);
  const nine = await quiet.step(9);
  assert.equal(quiet.sent.length, 0, "9 minutes is within the limit");
  assert.equal(nine.verdict.status, "fresh");

  const loud = harness();
  loud.lastTickAt(0);
  await loud.step(11);
  assert.equal(loud.sent.length, 1, "the identical harness DOES send past the limit -- so a sender never called fails here, not silently passes");
});

test("a read that cannot say is a message saying so, once, and never silence", async () => {
  const h = harness();
  h.failRead("gh did not answer inside 20 s (ETIMEDOUT)");
  await h.step(1);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /CANNOT TELL/);
  assert.match(h.sent[0], /ETIMEDOUT/);
  assert.match(h.sent[0], /not "alive"/);

  await h.step(2);
  assert.equal(h.sent.length, 1, "the same unreadable state sends no second message");

  h.failRead(null);
  h.lastTickAt(2);
  await h.step(2.5);
  assert.match(h.sent[1], /RECOVERED/, "being able to read again, and fresh, ends it");
});

test("a malformed record is CANNOT_TELL through the whole run, not fresh", async () => {
  let said = "";
  const result = await run({
    now: () => NOW, read: () => ({ ok: true, value: "not-json" }), send: async (text) => { said = text; return { ok: true }; },
    loadStanding: () => "none", saveStanding: () => {},
  });
  assert.equal(result.verdict.status, "cannot-tell");
  assert.match(said, /CANNOT TELL/);
});

test("a change of bad verdict is a new message: stale then unreadable tells the chairman both", async () => {
  const h = harness();
  h.lastTickAt(0);
  await h.step(11);
  h.failRead("exit 1");
  await h.step(12);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1], /CANNOT TELL/);
});

test("a message that did not leave is not counted as told: the next run retries it and the run reports the failure", async () => {
  const h = harness();
  h.lastTickAt(0);
  h.sendWorks(false);
  const first = await h.step(11);
  assert.equal(h.standing(), "none", "standing is recorded only after a send succeeded");
  assert.match(first.failure ?? "", /not sent, will retry/);

  h.sendWorks(true);
  const second = await h.step(12);
  assert.equal(h.sent.length, 1, "the retry went out");
  assert.equal(second.failure, null);
  assert.equal(h.standing(), "stale");
});

test("messageFor: nothing to say while fresh and nothing standing", () => {
  assert.equal(messageFor("none", { status: "fresh", ageMs: MINUTE, atMs: NOW }), null);
});

// ---------------------------------------------------------------------------------------------------------
// The reader -- a hard timeout and a refusal that names itself.
// ---------------------------------------------------------------------------------------------------------

test("readGateLastTick: asks for the standing comment under a KILLING timeout and returns its body", () => {
  const seen = { args: [] as string[], options: {} as Record<string, unknown> };
  const spawn = ((_cmd: string, args: string[], options: Record<string, unknown>) => {
    seen.args = args;
    seen.options = options;
    return { status: 0, stdout: `${comment(NOW)}\n`, stderr: "" };
  }) as unknown as typeof spawnSync;
  const read = readGateLastTick({ spawn, env: { GH_TOKEN: "x" }, readToken: () => "" });
  assert.deepEqual(read, { ok: true, value: `${comment(NOW)}\n` });
  assert.equal(seen.args[1], `repos/a11ign/a11ign/issues/comments/${HEARTBEAT_COMMENT_ID}`);
  assert.equal(HEARTBEAT_COMMENT_ID, "6026375754", "the id #3897 names, on a11ign/a11ign#3880");
  assert.ok(!seen.args.join(" ").includes("actions/variables"), "POSITIVE CONTROL: the old variable path is what this assertion is red on");
  assert.equal(seen.options.timeout, READ_TIMEOUT_MS);
  assert.equal(seen.options.killSignal, "SIGKILL", "a hung gh must be killed, not asked politely");
});

test("readGateLastTick: a timeout, a failure and a missing credential are each a refusal to say, with the reason", () => {
  const timedOut = (() => ({ error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), status: null })) as unknown as typeof spawnSync;
  const failed = (() => ({ status: 1, stdout: "", stderr: "gh: Resource not accessible by personal access token (HTTP 403)\nmore" })) as unknown as typeof spawnSync;
  const gone = (() => ({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)\n" })) as unknown as typeof spawnSync;
  const never = (() => { throw new Error("must not spawn without a credential"); }) as unknown as typeof spawnSync;
  const withToken = { env: { GH_TOKEN: "x" }, readToken: () => "" };

  const a = readGateLastTick({ ...withToken, spawn: timedOut });
  assert.ok(!a.ok && /ETIMEDOUT/.test(a.reason));
  const b = readGateLastTick({ ...withToken, spawn: failed });
  assert.ok(!b.ok && /exited 1: .*HTTP 403/.test(b.reason) && !/more/.test(b.reason), "only the first line of stderr");
  const d = readGateLastTick({ ...withToken, spawn: gone });
  assert.ok(!d.ok && /HTTP 404/.test(d.reason), "a deleted comment names its status and is not a verdict about the tick");
  const c = readGateLastTick({ spawn: never, env: {}, readToken: () => "  \n" });
  assert.ok(!c.ok && /no GitHub credential/.test(c.reason));
});

test("readGateLastTick: the token file is used when GH_TOKEN is unset, and the path is #1875's", () => {
  // Read as text, not imported: `fleet-playbook.mjs` parses flags at import and needs the laid fleet layer.
  const playbookSource = readFileSync(join(HERE, "fleet-playbook.mjs"), "utf8");
  assert.ok(playbookSource.includes('export const GH_TOKEN_FILE = join(homedir(), ".config", "a11y-witness", "gh-token");'), "#1875's path moved");
  assert.match(GH_TOKEN_FILE, /\/\.config\/a11y-witness\/gh-token$/, "one credential path, not two");
  let token = "";
  const spawn = ((_c: string, _a: string[], options: { env: NodeJS.ProcessEnv }) => {
    token = options.env.GH_TOKEN ?? "";
    return { status: 0, stdout: comment(NOW), stderr: "" };
  }) as unknown as typeof spawnSync;
  readGateLastTick({ spawn, env: {}, readToken: () => "from-file\n" });
  assert.equal(token, "from-file");
});

// ---------------------------------------------------------------------------------------------------------
// The sender -- no route is loud, and the token never leaves in an error.
// ---------------------------------------------------------------------------------------------------------

const SECRET = "123456:SECRET-TOKEN-VALUE";
const files: Record<string, string> = { "/tok": `${SECRET}\n`, "/chat": "424242\n" };
const env = { A11Y_HEARTBEAT_TELEGRAM_TOKEN_FILE: "/tok", A11Y_HEARTBEAT_TELEGRAM_CHAT_FILE: "/chat" };

test("telegramSender: posts to sendMessage with the chat id and the text", async () => {
  let call: { url: string, body: Record<string, string> } | null = null;
  const fetchImpl = (async (url: string, init: { body: string }) => { call = { url, body: JSON.parse(init.body) }; return { ok: true, status: 200 }; }) as never;
  const result = await telegramSender({ fetchImpl, readFile: (p) => files[p] ?? "", env })("hello");
  assert.deepEqual(result, { ok: true });
  assert.equal(call!.url, `https://api.telegram.org/bot${SECRET}/sendMessage`);
  assert.deepEqual(call!.body, { chat_id: "424242", text: "hello" });
});

test("telegramSender: an absent credential is `no route` naming the file, and nothing is fetched", async () => {
  const fetchImpl = (async () => { throw new Error("must not fetch"); }) as never;
  const result = await telegramSender({ fetchImpl, readFile: () => "", env })("hello");
  assert.ok(!result.ok && /no route/.test(result.reason) && /\/tok/.test(result.reason));
  assert.match(TELEGRAM_TOKEN_FILE, /\/\.config\/a11y-witness\/telegram-bot-token$/);
});

test("telegramSender: neither an HTTP failure nor a thrown error carries the token", async () => {
  const http401 = (async () => ({ ok: false, status: 401 })) as never;
  const thrown = (async (url: string) => { throw Object.assign(new Error(`failed ${url}`), { name: "TimeoutError" }); }) as never;
  for (const fetchImpl of [http401, thrown]) {
    const result = await telegramSender({ fetchImpl, readFile: (p) => files[p] ?? "", env })("hello");
    assert.ok(!result.ok);
    assert.ok(!result.reason.includes(SECRET), `the reason must not carry the token: ${result.reason}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// The whole CLI, against a FAKE `gh` first on PATH and no network: the entry point, the state file and the exit.
// ---------------------------------------------------------------------------------------------------------

function cli(updatedMs: number, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${comment(updatedMs)}'\n`);
  chmodSync(gh, 0o755);
  const result = spawnSync(process.execPath, [join(HERE, "gate-heartbeat.mjs")], {
    encoding: "utf8", timeout: 30_000,
    env: {
      PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: "fake", STATE_DIRECTORY: dir, HOME: dir,
      A11Y_HEARTBEAT_TELEGRAM_TOKEN_FILE: join(dir, "absent-token"), A11Y_HEARTBEAT_TELEGRAM_CHAT_FILE: join(dir, "absent-chat"),
      ...extraEnv,
    },
  });
  return { dir, result };
}

test("CLI: a fresh tick exits 0 and says fresh", () => {
  const { dir, result } = cli(Date.now());
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gate heartbeat: fresh/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI: a stale tick with no Telegram route FAILS the unit loudly and leaves nothing recorded as told", () => {
  const { dir, result } = cli(Date.now() - 11 * MINUTE);
  try {
    assert.equal(result.status, 1, "a heartbeat that cannot message must fail, not exit 0");
    assert.match(result.stdout, /gate heartbeat: stale \(last tick 11 min old\)/);
    assert.match(result.stderr, /no route/);
    assert.throws(() => readFileSync(join(dir, "standing.json")), /ENOENT/, "not counted as told");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------
// What ships: the unit, the timer and the playbook.
// ---------------------------------------------------------------------------------------------------------

const text = (path: string) => readFileSync(join(ANSIBLE, path), "utf8");

test("the timer fires every 5 minutes or less (done-when 1)", () => {
  const timer = text("files/a11y-gate-heartbeat.timer");
  const [, count, unit] = timer.match(/^OnUnitActiveSec=(\d+)(min|s)$/m) ?? [];
  assert.ok(count, "OnUnitActiveSec must be present in a form this test reads");
  const minutes = unit === "min" ? Number(count) : Number(count) / 60;
  assert.ok(minutes <= 5, `period ${minutes} min`);
  assert.match(timer, /^Unit=a11y-gate-heartbeat\.service$/m);
});

test("the service says in its header that it does not need the agents host (done-when 3), runs the script, and has a state directory", () => {
  const service = text("files/a11y-gate-heartbeat.service");
  assert.match(service.split("[Service]")[0], /DOES NOT NEED THE AGENTS HOST TO RUN/);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/root\/a11y-witness\/packages\/control\/src\/gate-heartbeat\.mjs$/m);
  assert.match(service, /^StateDirectory=a11y-gate-heartbeat$/m);
  assert.match(service, /^Type=oneshot$/m);
});

test("the service reads nothing from the agents host: no ssh, no agents-host path, in the script or the unit", () => {
  for (const source of [readFileSync(join(HERE, "gate-heartbeat.mjs"), "utf8"), text("files/a11y-gate-heartbeat.service")]) {
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line)).join("\n");
    assert.ok(!/\bssh\b/i.test(code), "an ssh to a frozen host blocks");
    assert.ok(!/work-tick-completion|\.local\/state\/agent-org/.test(code), "the tick is read from GitHub, not the host's file");
  }
});

test("the playbook installs both units, and control-unit-drift derives them from it", () => {
  const playbook = text("gate-heartbeat-schedule.yml");
  assert.match(playbook, /a11y-gate-heartbeat\.timer/);
  assert.match(playbook, /a11y-gate-heartbeat\.service/);
  const derived = shippedControlUnits({
    playbooks: () => [playbook], shippedText: (unit) => text(`files/${unit}`),
  });
  assert.ok("shipped" in derived, JSON.stringify(derived));
  assert.deepEqual(Object.keys(derived.shipped).sort(), ["a11y-gate-heartbeat.service", "a11y-gate-heartbeat.timer"]);
});
