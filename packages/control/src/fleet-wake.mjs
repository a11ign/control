// @ts-check
/**
 * Wake the fleet, from the LAB, without holding any credential.
 *
 *     npm run fleet:wake                  # every worker in the inventory
 *     npm run fleet:wake -- a11y-worker-2 # one
 *
 * ## Why this exists next to `wake.yml`, which does the same thing
 *
 * It is not duplication of the interesting kind, and the reason is the whole point of ADR 0012.
 *
 * A magic packet is an unauthenticated UDP broadcast. Waking a machine needs **no secret at all** —
 * which is what lets the lab container start the workers a run needs while holding none of the fleet's
 * SSH key. Shutting one down, provisioning it, or deploying to it all need that key, so they stay in the
 * control container. The privilege split therefore falls out of the physics rather than out of policy:
 * the lab can turn machines ON, and cannot turn them off or reconfigure them.
 *
 * `wake.yml` remains the operator's tool on the control plane, where Ansible already is. This is the
 * same packet, sent by the process that actually wants the worker.
 *
 * ## No dependencies, deliberately
 *
 * `node:dgram` and nothing else. The lab has a 100 MB dependency tree, but a run should not be unable to
 * start its own workers because of an install problem in something unrelated.
 */
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// MOVED here from packages/worker-fleet/src 2026-09-06 (architecture audit §3.2) -- see fleet-status.mjs's
// header for why. `fleet-discover.mjs` moved alongside it, so that import stays local; the other two
// cross back to worker-fleet the SANCTIONED way, by relative path.
import { inventoryHosts } from "./fleet-discover.mjs";
import { requestJson } from "../../worker-fleet/src/worker-http.mjs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
// #1683/#1684: SHARED, not restated -- both this file and fleet-discover.mjs need "the durable copy
// first, the in-tree checkout second", and defining it here would make fleet-discover.mjs (which this
// file already imports `inventoryHosts` from) import back FROM here, a cycle. `control-plane-fleet.mjs`
// is neither's dependent, so it is the shared home.
import { inventoryPathFor } from "./control-plane-fleet.mjs";

/**
 * takes no flags: it wakes every box in the inventory.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags([], { entry: import.meta.url, command: "npm run fleet:wake" });

/** Port 9 (discard) by convention; nothing listens, the NIC's firmware matches the frame. */
const WOL_PORT = 9;
/** UDP is unacknowledged, so the only mitigation for a dropped frame is another frame. */
const PACKETS = 3;
/**
 * THE PER-PROBE TIMEOUT, WITH ITS READING (#2655 done-when 5.1). A probe that outlives it is UNKNOWN,
 * never "down", so this number decides how much slowness a healthy box is allowed.
 *
 * What it is sized against, all READ by others on the real fleet and none measured by this row (the
 * resource ban bars an engineer from probing it):
 *   - the slowest HEALTHY box: 2.80 to 3.09 s on a11y-worker-13, -14 and -16, twelve others 0.53 to 0.76 s
 *     (`orchestrator`, #2671, from the control plane and from a laptop alike);
 *   - and that is the FIRST answer after the box has been quiet more than 5 s, because the worker
 *     rebuilds its environment block with two synchronous `powershell.exe` calls when it is older than
 *     that. A wake probe is more than 5 s after the last by construction, so it is ALWAYS the slow case;
 *   - a LOADED box (one that has just stopped a capture) can take up to about 10 s: each of the two calls is
 *     bounded at 5 s and they stop the worker's event loop for the whole time (#2671).
 * 12 s is that loaded ceiling plus 2 s, and 3.9x the slowest healthy reading. The old 4 s left 0.9 s over
 * the 3.09 s box and none over a loaded one. #2672 and #2673 bring the healthy readings down and move
 * nothing upward, so this stays correct after them. Cost of the generosity: a box that is really off costs
 * one 12 s probe, in parallel with its peers, before its wake starts.
 * `fleet:discover`'s 2 s (#2666) is NOT this number: it read those three healthy boxes as asleep.
 */
export const HEALTH_TIMEOUT_MS = 12_000;
const POLL_MS = 5_000;
/**
 * THE OVERALL BOUNDED WAIT, a separate number from the probe timeout and with a weaker reading: 300 s is
 * INHERITED from `wake.yml` (30 retries x 10 s), which waits on the same boot for the same reason. It is not
 * a boot time measured on bare metal (the only figure in the repo, 15 to 42 s, is the deprecated UTM guest,
 * `docs/fleet-capacity-history.md`); the fleet-gated measurement row reads first-answer times per box and
 * checks this. A probe that times out INSIDE the wait keeps waiting; only this deadline ends it, and then in
 * the "packet sent and nothing answered" wording, never "down". A probe is not cut short by the deadline, so
 * the worst case is the deadline plus one probe timeout.
 */
export const WAKE_DEADLINE_MS = 300_000;

/**
 * The 102-byte magic packet: six 0xFF bytes, then the target MAC sixteen times.
 *
 * Built here rather than pulled from a package because it is six lines and a dependency in the wake path
 * is a dependency that can stop a run from starting.
 *
 * @param {string} mac
 * @returns {Buffer}
 */
export function magicPacket(mac) {
  const bytes = String(mac).replace(/[^0-9a-fA-F]/g, "");
  if (bytes.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const target = Buffer.from(bytes, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(target)]);
}

/**
 * @param {string} mac
 * @param {string} broadcast
 */
export function sendMagicPacket(mac, broadcast = "255.255.255.255") {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.bind(() => {
      socket.setBroadcast(true);
      let sent = 0;
      const send = () => socket.send(packet, 0, packet.length, WOL_PORT, broadcast, (error) => {
        if (error) { socket.close(); reject(error); return; }
        sent += 1;
        if (sent < PACKETS) return send();
        socket.close();
        resolve(sent);
      });
      send();
    });
  });
}

/**
 * WHAT ONE `/health` PROBE CAN SAY, and the two words that must never be confused (#2655 done-when 5.2):
 *
 *   KNOWN     ready       the box's own report: `ready: true`
 *             busy        the box's own report: `busy: true`, a capture is running. Up, not free, and
 *                         NOT to be woken or waited on
 *             not-ready   it answered, and its own `ready:false` says why (`reason`), or it answered with a
 *                         non-2xx status. Up, and to be waited on
 *             refused     the connection was refused: something answered the TCP handshake with a reset,
 *                         so the BOX IS UP and the worker is not listening yet
 *   UNKNOWN   no-answer   nothing came back inside the timeout, or the transport failed some other way
 *                         (unreachable, reset). One silent probe cannot separate "off" from "slow" from
 *                         "the path dropped it", so it is never called down. It carries the error's own
 *                         message.
 *
 * Until #2655 this was `answering()`, which returned `false` for a timeout, a refusal, a non-OK status and
 * any thrown error alike, and swallowed the error, so nothing downstream could tell slow from down.
 *
 * @typedef {{ outcome: "ready" } | { outcome: "busy" }
 *   | { outcome: "not-ready", reason: string }
 *   | { outcome: "refused", message: string }
 *   | { outcome: "no-answer", message: string }} Probe
 */

/**
 * @param {string} url the worker's base URL
 * @param {{ timeoutMs?: number, request?: typeof requestJson }} [options]
 * @returns {Promise<Probe>}
 */
export async function probeWorker(url, { timeoutMs = HEALTH_TIMEOUT_MS, request = requestJson } = {}) {
  let response;
  try {
    response = await request(`${url}/health`, { timeoutMs });
  } catch (error) {
    const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
    return code === "ECONNREFUSED"
      ? { outcome: "refused", message }
      : { outcome: "no-answer", message: `${code ? `${code}: ` : ""}${message}` };
  }
  if (!response.ok) return { outcome: "not-ready", reason: `/health answered HTTP ${response.status}` };
  if (response.json?.busy === true) return { outcome: "busy" };
  if (response.json?.ready === true) return { outcome: "ready" };
  return { outcome: "not-ready",
    reason: response.json?.reason ?? "/health answered without `ready: true` and without a reason" };
}

/**
 * @typedef {{ name: string, host: string, mac?: string | null }} WakeTarget
 * @typedef {{ port?: number, broadcast?: string, deadlineMs?: number, pollMs?: number, probeTimeoutMs?: number,
 *   log?: (line: string) => void, send?: (mac: string, broadcast?: string) => Promise<number>,
 *   request?: typeof requestJson, sleep?: (ms: number) => Promise<void>, now?: () => number }} WakeOptions
 * @typedef {Required<Omit<WakeOptions, "broadcast">> & { broadcast?: string }} WakeConfig
 * @typedef {WakeTarget & { state: string, packets: number, detail?: string }} WakeResult
 */

/**
 * The states a worker can end in, each a different remedy. The last four are the NAMED errors of #2655
 * done-when 3, and only the second and third say "packet sent" or "answered", because that is all that was
 * observed:
 *
 *   already-up  answered ready, sent nothing         busy       up mid-capture, sent nothing, waited on nothing
 *   woken       our one packet, then ready           came-up    ready without a packet (it was up, still starting)
 *   no-mac      silent and no `mac` in inventory     -> add it to inventory.yml
 *   no-answer   packet sent, nothing ever answered   -> Wake-on-LAN, the broadcast path, or the box is off
 *   never-ready answered, `ready` never true         -> its own `reason` says why
 *   not-listening  refused throughout, no packet     -> the box is up and the worker is not: `fleet:recover`
 */

/**
 * ONE worker: probe, send AT MOST ONE packet, wait for `ready`.
 *
 * THE RULE FOR AN UNKNOWN FIRST PROBE (#2655 done-when 5.3): a silent first probe gets exactly ONE packet
 * (three frames, one `send`), and no probe after it ever sends another. A powered-off box on a LAN
 * typically fails to answer rather than refusing (reasoning, not read on this fleet), so one silence cannot
 * separate off from slow. The smallest action that cannot leave a slow box woken twice is one packet, ever:
 * a frame to a box that is already running changes nothing on it (ADR 0012: the packet is unauthenticated
 * and only ever turns machines ON), and with the timeout above the slowest healthy reading a healthy box
 * does not reach here at all. A REFUSED or not-ready first probe means the box is up, so it gets none.
 *
 * @param {WakeTarget} w
 * @param {WakeConfig} cfg
 * @returns {Promise<WakeResult>}
 */
async function wakeOne(w, cfg) {
  const url = `http://${w.host}:${cfg.port}`;
  const probe = () => probeWorker(url, { timeoutMs: cfg.probeTimeoutMs, request: cfg.request });
  const first = await probe();
  if (first.outcome === "ready") return { ...w, state: "already-up", packets: 0 };
  if (first.outcome === "busy") return { ...w, state: "busy", packets: 0 };

  let packets = 0;
  if (first.outcome === "no-answer") {
    if (!w.mac) return { ...w, state: "no-mac", packets, detail: first.message };
    await cfg.send(w.mac, cfg.broadcast);
    packets = 1;
    cfg.log(`  ${w.name}: magic packet sent to ${w.mac} (first probe: ${first.message})`);
  }

  // Waiting for the CONDITION, not sleeping a guess. A cold boot has to POST, start Windows, auto-log-on,
  // fire the at-logon task and warm NVDA up; a deadline that expires early turns "still coming up" into
  // "did not wake", and those have completely different remedies.
  const deadline = cfg.now() + cfg.deadlineMs;
  /** @type {Probe} */
  let last = first;
  /** the last KNOWN answer: what the box said before the deadline, which the timeout must not overwrite
   * @type {Probe | null} */
  let lastKnown = first.outcome === "no-answer" ? null : first;
  while (cfg.now() < deadline) {
    await cfg.sleep(cfg.pollMs);
    last = await probe();
    if (last.outcome === "ready") return { ...w, state: packets ? "woken" : "came-up", packets };
    if (last.outcome === "busy") return { ...w, state: "busy", packets };
    if (last.outcome !== "no-answer") lastKnown = last;
  }
  return { ...w, packets, ...verdictAtDeadline(lastKnown, last) };
}

/**
 * The state a wait that ran out ends in, from what the box last SAID. A silent probe after an answer does
 * not erase the answer, and silence throughout is `no-answer`, never "down".
 *
 * @param {Probe | null} lastKnown
 * @param {Probe} last
 */
function verdictAtDeadline(lastKnown, last) {
  if (lastKnown?.outcome === "not-ready") return { state: "never-ready", detail: lastKnown.reason };
  if (lastKnown?.outcome === "refused") return { state: "not-listening", detail: lastKnown.message };
  return { state: "no-answer", detail: last.outcome === "no-answer" ? last.message : "" };
}

/**
 * Wake the named workers and wait until they are READY, sending each at most one packet.
 *
 * Returns per-worker outcomes rather than throwing on the first failure: a fleet where one box has a
 * flat firmware setting should still bring the other eleven up, and the report should name which.
 *
 * Only the workers passed in are touched: a job that needs three passes three, and a worker that is up
 * (ready or busy) is sent nothing (#2655 done-when 2). The socket, the health read, the clock and the sleep
 * are all injectable, so a test reads no network and waits no time.
 *
 * @param {WakeTarget[]} workers
 * @param {WakeOptions} [options]
 * @returns {Promise<WakeResult[]>}
 */
export async function wakeFleet(workers, options = {}) {
  /** @type {WakeConfig} */
  const cfg = {
    port: 8765, deadlineMs: WAKE_DEADLINE_MS, pollMs: POLL_MS, probeTimeoutMs: HEALTH_TIMEOUT_MS,
    log: () => {}, send: sendMagicPacket, request: requestJson,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now,
    ...options,
  };
  return Promise.all(workers.map((w) => wakeOne(w, cfg)));
}

/**
 * One line per worker, in the words of what was OBSERVED: "did not answer" and "is down" are different
 * claims and this file only ever makes the first (#2655 done-when 5.2). `answered` is a fact about the box,
 * `nothing answered` a fact about the wait.
 *
 * @param {{ name: string, host: string, state: string, packets?: number, detail?: string }} r
 */
export function wakeReportLine(r) {
  const said = r.detail ? ` (${r.detail})` : "";
  const detail = /** @type {Record<string, string>} */ ({
    "already-up": "already up and ready, no packet sent",
    busy: "up and busy with a capture: not woken, not waited on",
    woken: "one packet sent, then ready",
    "came-up": "was up but not ready, no packet sent; now ready",
    "no-mac": `did not answer and has no mac in inventory.yml, so it cannot be woken${said}`,
    "no-answer": `one packet sent and NOTHING ANSWERED within the deadline${said} — Wake-on-LAN and Deep Sleep in its `
      + "firmware, or the broadcast not reaching it from here. Not known to be down",
    "never-ready": `answered but never became ready: ${r.detail}`,
    "not-listening": `the box refuses connections (it is up) and the worker never started listening${said} `
      + "— `fleet:recover`",
  })[r.state] ?? r.state;
  return `  ${r.name.padEnd(16)} ${r.host.padEnd(15)} ${detail}`;
}

/** Did this worker end somewhere a capture cannot use? (`busy` is a worker that is fine and taken.) */
export const wakeFailed = (/** @type {{ state: string }} */ r) =>
  !["already-up", "busy", "woken", "came-up"].includes(r.state);

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const inventory = inventoryPathFor();
  // `inventory.yml` is gitignored (real addresses, restored from the secrets store at bring-up) --
  // absence is now a state a fresh clone hits routinely, not an edge case, so it gets a named error
  // rather than an uncaught ENOENT stack. Same message shape as `fleet-status.mjs`'s `fleetToProbe()`.
  let declared;
  try {
    declared = inventoryHosts(readFileSync(inventory, "utf8"));
  } catch (error) {
    process.stderr.write("No fleet to wake: inventory.yml could not be read "
      + `(${/** @type {Error} */ (error).message}). Restore it from the secrets store, or add a host.\n`);
    process.exit(2);
  }
  const workers = wanted.length ? declared.filter((w) => wanted.includes(w.name)) : declared;

  if (!workers.length) {
    process.stderr.write(wanted.length
      ? `No worker named ${wanted.join(", ")} in inventory.yml\n`
      : "No workers in inventory.yml\n");
    process.exit(2);
  }

  const results = await wakeFleet(workers, { log: (l) => process.stdout.write(`${l}\n`) });
  process.stdout.write("\n");
  for (const r of results) process.stdout.write(`${wakeReportLine(r)}\n`);
  // Non-zero only when a worker we were ASKED to wake did not come back. Nothing here can shut a box
  // down, so the worst case is a run that finds fewer workers than it hoped -- which the dispatcher
  // already handles by using the ones that answered.
  process.exit(results.some(wakeFailed) ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
