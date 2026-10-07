// @ts-check
/**
 * An external heartbeat: the control plane reads the gate's last tick and messages the chairman when it is
 * older than ten minutes -- #3851, class fix 1c of the 2026-10-06 host-hang incident (#3846).
 *
 * The agents host hung for 2 h 15 min and nothing noticed, because every watcher this org has runs ON the
 * host that was frozen. **A host that freezes cannot report its own freeze**, so this runs on the control
 * plane and reads the tick from GitHub, never by ssh to the box it is watching (an ssh to a hung host blocks).
 *
 * ## The three questions the row asked, answered where the code is
 *
 *   1. READ FROM: the `updated_at` of the tick's standing comment, issue comment `6026375754` on
 *      `a11ign/a11ign#3880`, authored by `a11ign-ai-workers` and edited by the tick (agent-org#333, #3896). It was
 *      the Actions variable `GATE_LAST_TICK` until #3897: the control plane's #1875 token gets a 403 on
 *      `actions/variables` (measured 2026-10-06 22:04Z, #3851), and a comment is an object a tokenless read sees.
 *      The timestamp is GitHub's own, so the age needs no trust in the agents host's clock. Lag added: one API
 *      round trip after the tick's end, then up to one timer period (1 min) of this unit. Every read has a hard timeout.
 *   2. ROUTE: the control plane's own Telegram route. The credential files are the chairman's to place
 *      (`needs:chairman` on #3851); their paths are named below and are PROVISIONAL until he names them.
 *   3. WHAT IS A TICK: the comment is edited only after the completion record, on a tick that reached its
 *      end, so a tick that started and died writes nothing and goes stale like a tick that never ran.
 *
 * ## Three verdicts, and a missing answer is never `fresh`
 *
 *   - `fresh`        the last tick is at most ten minutes old
 *   - `stale`        older than ten minutes
 *   - `cannot-tell`  the read timed out or failed (a 404 for a deleted comment and a 403 are HTTP statuses named
 *                    in the message: a deleted object is not a dead tick), or the body is not a comment whose
 *                    `updated_at` is a time no earlier than its own `created_at`. **CANNOT_TELL is
 *                    not "alive"**: it is a message saying so, because a heartbeat that goes quiet when it
 *                    cannot see is the freeze it exists to catch, one level up.
 *
 * ## One message per outage, and one when it ends
 *
 * The standing verdict is kept in `$STATE_DIRECTORY` (systemd's `StateDirectory=`), so a run 11 minutes into
 * an outage and the next at 12 minutes send one message between them. A different bad verdict is a new
 * message; the first `fresh` after a bad one sends a recovery line and re-arms. **The standing verdict is
 * recorded only AFTER a send succeeded**: a message that did not leave is retried on the next run, never
 * counted as told, and the run exits non-zero so the failed unit is itself visible.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const STALE_AFTER_MS = 10 * 60_000;
export const READ_TIMEOUT_MS = 20_000;
export const SEND_TIMEOUT_MS = 20_000;
export const HEARTBEAT_REPO = "a11ign/a11ign";
/** The tick's standing comment, on a11ign/a11ign#3880 (#3897). Its `updated_at` is the last completed tick. */
export const HEARTBEAT_COMMENT_ID = "6026375754";

const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;
const NOT_STANDING = "none";

/**
 * Where the control plane's Telegram credential would live: beside `gh-token` (#1875), `root:root 0600`, never
 * in git. PROVISIONAL: #3851 carries `needs:chairman` because a credential is not this row's to mint, and the
 * chairman names the real paths there. Until a file exists at them every run says `no route` and exits 1, which
 * is a failed unit and not a quiet one. Overridable so the paths can move without editing this file.
 */
export const TELEGRAM_TOKEN_FILE = join(homedir(), ".config", "a11y-witness", "telegram-bot-token");
export const TELEGRAM_CHAT_FILE = join(homedir(), ".config", "a11y-witness", "telegram-chairman");

/**
 * @typedef {{ status: "fresh", ageMs: number, atMs: number } | { status: "stale", ageMs: number, atMs: number } | { status: "cannot-tell", reason: string }} Verdict
 * @typedef {"fresh" | "stale" | "cannot-tell" | typeof NOT_STANDING} Standing
 * @typedef {{ ok: true, value: string } | { ok: false, reason: string }} Read
 */

/**
 * What the comment says about the last tick, or why it cannot be read as one.
 *
 * `updated_at` is GitHub's clock, so there is no skew verdict: the tick is never stamped by a host this unit
 * does not trust. A stamp before the comment's own `created_at` is a body that is not this comment, not a tick.
 *
 * @param {string} body the comment's `{created_at, updated_at}` as `readGateLastTick` asks for them
 * @param {number} nowMs
 * @returns {Verdict}
 */
export function judgeTick(body, nowMs) {
  const times = readTimes(body);
  if (!times.ok) return { status: "cannot-tell", reason: times.reason };
  const { createdMs, updatedMs } = times;
  if (updatedMs < createdMs) return { status: "cannot-tell", reason: "the comment's updated_at is earlier than its created_at" };
  const ageMs = nowMs - updatedMs;
  const age = { ageMs: Math.max(ageMs, 0), atMs: updatedMs };
  return ageMs > STALE_AFTER_MS ? { status: "stale", ...age } : { status: "fresh", ...age };
}

/**
 * @param {string} body
 * @returns {{ ok: true, createdMs: number, updatedMs: number } | { ok: false, reason: string }}
 */
function readTimes(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: `the body is not JSON: ${JSON.stringify(body.trim().slice(0, 40))}` };
  }
  const createdMs = isoMs(parsed?.created_at);
  const updatedMs = isoMs(parsed?.updated_at);
  if (createdMs === null || updatedMs === null) return { ok: false, reason: "the body has no created_at and updated_at that are times" };
  return { ok: true, createdMs, updatedMs };
}

/** @param {unknown} value @returns {number | null} epoch ms of an ISO-8601 string, else null */
function isoMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** @param {number} ms @returns {string} */
function minutes(ms) {
  return ms < MS_PER_MINUTE ? `${Math.round(ms / MS_PER_SECOND)} s` : `${Math.round(ms / MS_PER_MINUTE)} min`;
}

/**
 * The message for a change of verdict, or null when there is nothing new to say.
 *
 * @param {Standing} standing what the chairman was last told
 * @param {Verdict} verdict
 * @returns {{ text: string, standing: Standing } | null}
 */
export function messageFor(standing, verdict) {
  if (verdict.status === "fresh") {
    if (standing === NOT_STANDING) return null;
    return { standing: NOT_STANDING, text: `Gate heartbeat RECOVERED: the last tick is ${minutes(verdict.ageMs)} old (${new Date(verdict.atMs).toISOString()}).` };
  }
  if (verdict.status === standing) return null;
  if (verdict.status === "stale") {
    return { standing: "stale", text: `Gate heartbeat STALE: the agents host's last completed tick is ${minutes(verdict.ageMs)} old (${new Date(verdict.atMs).toISOString()}), over the ${minutes(STALE_AFTER_MS)} limit. The host may be frozen.` };
  }
  return { standing: "cannot-tell", text: `Gate heartbeat CANNOT TELL: the control plane could not read the gate's last tick (${verdict.reason}). This is not "alive".` };
}

/**
 * One run: read, judge, and message only on a change. Every effect is injected.
 *
 * @param {{ now: () => number, read: () => Promise<Read> | Read, send: (text: string) => Promise<{ ok: true } | { ok: false, reason: string }>,
 *   loadStanding: () => Standing, saveStanding: (s: Standing) => void }} deps
 * @returns {Promise<{ verdict: Verdict, sent: string | null, failure: string | null }>}
 */
export async function run({ now, read, send, loadStanding, saveStanding }) {
  const reading = await read();
  const verdict = reading.ok ? judgeTick(reading.value, now()) : { status: /** @type {const} */ ("cannot-tell"), reason: reading.reason };
  const message = messageFor(loadStanding(), verdict);
  if (!message) return { verdict, sent: null, failure: null };
  const sent = await send(message.text);
  if (!sent.ok) return { verdict, sent: null, failure: `message not sent, will retry next run: ${sent.reason}` };
  saveStanding(message.standing);
  return { verdict, sent: message.text, failure: null };
}

/**
 * `gh api` for the standing comment, under a hard timeout that KILLS: a hung `gh` must not hold the unit.
 *
 * @param {{ spawn?: typeof spawnSync, env?: NodeJS.ProcessEnv, readToken?: () => string }} [options]
 * @returns {Read}
 */
export function readGateLastTick({ spawn = spawnSync, env = process.env, readToken = readGhToken } = {}) {
  const token = env.GH_TOKEN || readToken().trim();
  if (!token) return { ok: false, reason: "this host has no GitHub credential" };
  const result = spawn("gh", ["api", `repos/${HEARTBEAT_REPO}/issues/comments/${HEARTBEAT_COMMENT_ID}`, "--jq", "{created_at, updated_at}"], {
    env: { ...env, GH_TOKEN: token }, encoding: "utf8", timeout: READ_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  if (result.error) return { ok: false, reason: `gh did not answer inside ${READ_TIMEOUT_MS / MS_PER_SECOND} s (${/** @type {NodeJS.ErrnoException} */ (result.error).code ?? "error"})` };
  if (result.status !== 0) return { ok: false, reason: `gh exited ${result.status}: ${firstLine(result.stderr)}` };
  return { ok: true, value: String(result.stdout) };
}

/** @param {string | null | undefined} text @returns {string} */
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200) || "no message";
}

/** The #1875 token path, read here rather than imported: `fleet-playbook.mjs` parses flags at import. */
export const GH_TOKEN_FILE = join(homedir(), ".config", "a11y-witness", "gh-token");

/** @returns {string} the token file's contents, or "" when it is absent. */
function readGhToken() {
  return readOptionalFile(GH_TOKEN_FILE);
}

/** @param {string} path @returns {string} */
function readOptionalFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    // ABSENT IS AN ANSWER, reported by the caller by name; any other failure is a real one and rethrown.
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return "";
    throw new Error(`could not read ${path}`, { cause: error });
  }
}

/**
 * Telegram's `sendMessage`, under a hard timeout. The token is in the URL Telegram requires, so NO error text
 * here is built from the URL: a failure names the status or the error class and nothing else.
 *
 * @param {{ fetchImpl?: typeof fetch, readFile?: (path: string) => string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {(text: string) => Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export function telegramSender({ fetchImpl = fetch, readFile = readOptionalFile, env = process.env } = {}) {
  const tokenFile = env.A11Y_HEARTBEAT_TELEGRAM_TOKEN_FILE || TELEGRAM_TOKEN_FILE;
  const chatFile = env.A11Y_HEARTBEAT_TELEGRAM_CHAT_FILE || TELEGRAM_CHAT_FILE;
  return async (text) => {
    const token = readFile(tokenFile).trim();
    const chatId = readFile(chatFile).trim();
    if (!token || !chatId) return { ok: false, reason: `no route: ${!token ? tokenFile : chatFile} is absent or empty (the chairman places it, #3851)` };
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      return response.ok ? { ok: true } : { ok: false, reason: `Telegram answered HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, reason: `Telegram did not answer (${/** @type {Error} */ (error).name})` };
    }
  };
}

/** @returns {string} the state file, under systemd's `StateDirectory=` (`$STATE_DIRECTORY`). */
function standingPath() {
  return join(process.env.STATE_DIRECTORY || join(homedir(), ".local", "state", "a11y-gate-heartbeat"), "standing.json");
}

/** @returns {Standing} what the chairman was last told; a missing or unreadable file is "nothing told". */
function loadStanding() {
  const raw = readOptionalFile(standingPath());
  if (!raw) return NOT_STANDING;
  try {
    const { standing } = JSON.parse(raw);
    return standing === "stale" || standing === "cannot-tell" ? standing : NOT_STANDING;
  } catch (error) {
    // A torn file must not become silence about an outage: say so, and re-tell the chairman rather than skip.
    console.error(`standing file unreadable, treated as nothing told: ${/** @type {Error} */ (error).message}`);
    return NOT_STANDING;
  }
}

/** @param {Standing} standing */
function saveStanding(standing) {
  const path = standingPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ standing })}\n`);
  renameSync(`${path}.tmp`, path);
}

async function main() {
  const result = await run({ now: Date.now, read: readGateLastTick, send: telegramSender(), loadStanding, saveStanding });
  const { verdict } = result;
  const age = verdict.status === "cannot-tell" ? verdict.reason : `last tick ${minutes(verdict.ageMs)} old`;
  console.log(`gate heartbeat: ${verdict.status} (${age})${result.sent ? " -- chairman messaged" : ""}`);
  if (result.failure) {
    console.error(result.failure);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
