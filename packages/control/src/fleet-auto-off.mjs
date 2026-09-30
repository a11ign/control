// @ts-check
/**
 * A worker idle five minutes powers itself off -- never mid-capture. #2656. (It does not check
 * `Fleet-hold-until:` -- #2737, see below.)
 *
 *     npm run fleet:auto-off                # report only: prints off/keep + reason, powers nothing off
 *     npm run fleet:auto-off -- --apply      # for every worker decided `off`, dispatch sleep.yml at it
 *
 * ## Where this runs, and why it needs no SSH
 *
 * ON THE CONTROL PLANE ITSELF, as the systemd timer `auto-off-schedule.yml` installs (live since #2734,
 * with `--apply` in its unit since #2784). `fleet-playbook.mjs` cannot be reused for the dispatch half -- its whole job is to SSH
 * INTO the control plane from an operator machine that holds `A11Y_PVE_KEY`, and a timer already standing
 * on the control plane is not that machine. This file talks to workers the way `sleep.yml` itself does:
 * plain HTTP to `/health`, and `ansible-playbook` invoked LOCALLY, no ssh hop needed because it is already
 * where the fleet SSH key lives.
 *
 * ## The shutdown is `sleep.yml`, reused and not reimplemented (done-when 2)
 *
 * `dispatchShutdown` below shells out to `ansible-playbook sleep.yml -l <worker>` -- the exact playbook
 * `npm run fleet:sleep` runs, untouched. `sleep.yml`'s own busy check re-asks `/health` immediately before
 * the shutdown, so a worker that started a capture in the gap between THIS file's poll and the actual
 * dispatch is still protected by a SECOND, independent read -- not because this file re-derives that
 * safety, but because it never had to.
 *
 * ## The idle-since state file is `fleet-watch.mjs`'s own shape, one field over
 *
 * `readState`/`writeState`/`advance` here are the identical pattern `fleet-watch.mjs` already proved for
 * "how long has this been true, across a fresh process every tick" -- a first-seen timestamp per worker,
 * dropped the instant the condition clears rather than marked resolved. The one difference: a `no-answer`
 * probe RESETS the streak here (see `advance`'s own comment), where `fleet-watch.mjs` never has to make
 * that call because its own probe (`fleetStatus`) never returns "unknown".
 *
 * ## `Fleet-hold-until:` does NOT gate this file (ceo's ruling on #2726/#2728, #2737)
 *
 * This file used to read `Fleet-hold-until:` before deciding, on the theory that a power cycle mid-hold
 * could strand a multi-round same-build capture sequence the way #1767/#1768 lost their baselines. Re-read
 * against what #1839's hold actually protects: only `fleet:deploy`/`fleet:provision` can change a worker's
 * `codeVersion`/`provisionRevision` stamp, and both already refuse while a hold is active (`fleet-playbook.mjs`'s
 * own `enforceSequenceHold`). A power-off/wake cycle changes neither, so the hold read here protected
 * nothing. It also would have needed a durable GitHub credential on the control plane (#2726) purely to
 * answer a question whose answer never mattered -- removed instead of provisioned. The "never mid-capture"
 * guard below is unrelated and unaffected: it is `probeIdle`'s own per-worker `busy` read, re-confirmed by
 * `sleep.yml` itself immediately before any shutdown.
 *
 * ## `batchQueued` and `leasePending` are an honest gap
 *
 * Done-when 1 names them as keep reasons a pure function must carry. Nothing in this codebase today
 * produces either signal for a bare-metal worker -- no lab-side queue record, no per-worker lease --
 * so `main()` always passes `false` for both. They are real parameters of `autoOffDecision` (tested
 * directly, positive and negative) so that the day a producer exists, only `main()` changes.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requestJson } from "../../worker-fleet/src/worker-http.mjs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { inventoryHosts } from "./fleet-discover.mjs";
import { inventoryPathFor } from "./control-plane-fleet.mjs";
import { magicPacket } from "./fleet-wake.mjs";

refuseUnknownFlags(["--apply"], { entry: import.meta.url, command: "npm run fleet:auto-off" });

const MS_PER_MINUTE = 60_000;

/** Chairman's constraint via `ceo`, 2026-09-26: idle five minutes, not sooner. */
export const IDLE_THRESHOLD_MS = 5 * MS_PER_MINUTE;

const PORT = 8765;

/**
 * THE PER-PROBE TIMEOUT, WITH ITS READING (done-when 7.2) -- this row's OWN derivation, agreeing with
 * `fleet-wake.mjs`'s `HEALTH_TIMEOUT_MS` on the READING rather than copying the number by assumption.
 *
 * `orchestrator`'s #2671, read on the real fleet: `/health` is slow on the FIRST request after 5 s idle,
 * not after a minute -- the worker rebuilds its environment block with two synchronous `powershell.exe`
 * calls once a request arrives more than 5 s after the last one. A scheduled poll is *always* more than
 * 5 s after its predecessor by construction (the timer fires at most once every `POLL_INTERVAL_MS`, far
 * above 5 s), so it is ALWAYS the slow case: 2.80-3.09 s on three boxes, 0.53-0.76 s on twelve. A LOADED
 * box (one that has just stopped a capture) can take up to ~10 s, because the same two calls block the
 * worker's whole event loop for that long. 12 s is that loaded ceiling plus 2 s of headroom -- the same
 * number `fleet-wake.mjs` arrived at from the same reading, for the same reason.
 */
export const PROBE_TIMEOUT_MS = 12_000;

/**
 * THE POLL INTERVAL, stated with why it cannot miss a capture (done-when 3). The shortest capture measured
 * anywhere in this repo is 12 s (`sleep.yml`'s own header). A poll every `POLL_INTERVAL_MS` is GUARANTEED
 * to land at least one sample inside any real capture only if the gap between polls is strictly shorter
 * than that 12 s floor -- otherwise a capture that starts and finishes entirely between two polls would
 * never be observed `busy` at all. 10 s clears that with 2 s to spare. (This is a poll cadence, never a
 * cron: `auto-off-schedule.yml`'s `.timer` fires it, matching `.claude/rules/org-routing-and-timers.md`'s
 * "a cron is right only for a WALL-CLOCK event".)
 */
export const POLL_INTERVAL_MS = 10_000;

/** `runs/` in the control plane's own checkout -- gitignored local state, `fleet-watch.mjs`'s own home. */
export const DEFAULT_STATE_PATH = "runs/fleet-auto-off-state.json";

const ANSIBLE_DIR = fileURLToPath(new URL("../ansible/", import.meta.url));

/**
 * Does the inventory's `mac:` field for this worker actually accept a magic packet? "Has a MAC" means
 * accepted by `magicPacket()` (12 hex digits once separators are stripped), never merely a non-empty
 * string (#2655/#2656 chairman's constraint via `ceo`, 2026-09-26).
 *
 * @param {string | null | undefined} mac
 * @returns {boolean}
 */
export function hasWakeableMac(mac) {
  if (!mac) return false;
  try { magicPacket(mac); return true; } catch { return false; }
}

/**
 * WHAT ONE `/health` PROBE CAN SAY FOR THE PURPOSE OF AUTO-OFF -- a NARROWER question than
 * `fleet-wake.mjs`'s `probeWorker` (which asks about readiness, not idleness), because "busy" is the only
 * field this row cares about (done-when 7.1). A response that answers but cannot be read -- non-OK, or a
 * `busy` field that is not a plain boolean -- is folded into `no-answer`: it is "answered but unreadable",
 * which done-when 7.1 says must `keep`, exactly as a true timeout does.
 *
 * @typedef {{ outcome: "idle" } | { outcome: "busy" } | { outcome: "no-answer", detail: string }} IdleProbe
 */

/**
 * @param {string} url the worker's base URL
 * @param {{ timeoutMs?: number, request?: typeof requestJson }} [options]
 * @returns {Promise<IdleProbe>}
 */
export async function probeIdle(url, { timeoutMs = PROBE_TIMEOUT_MS, request = requestJson } = {}) {
  let response;
  try {
    response = await request(`${url}/health`, { timeoutMs });
  } catch (error) {
    const { code, message } = /** @type {NodeJS.ErrnoException} */ (error);
    return { outcome: "no-answer", detail: `${code ? `${code}: ` : ""}${message}` };
  }
  if (!response.ok) return { outcome: "no-answer", detail: `/health answered HTTP ${response.status}` };
  if (response.json?.busy === true) return { outcome: "busy" };
  if (response.json?.busy === false) return { outcome: "idle" };
  return { outcome: "no-answer", detail: "/health answered without a boolean `busy`" };
}

/** @typedef {Record<string, number>} SinceState */

/**
 * The persisted idle-since / shutdown-requested-at state. Missing or corrupt reads as EMPTY, never a
 * crash -- `fleet-watch.mjs`'s own rule, one file over: a tick must not take itself down over its own
 * bookkeeping.
 *
 * @param {string} path
 * @param {(path: string, encoding: "utf8") => string} read
 * @returns {{ idleSince: SinceState, shutdownRequestedAt: SinceState }}
 */
export function readState(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    const idleSince = parsed?.idleSince;
    const shutdownRequestedAt = parsed?.shutdownRequestedAt;
    return {
      idleSince: idleSince && typeof idleSince === "object" && !Array.isArray(idleSince) ? idleSince : {},
      shutdownRequestedAt: shutdownRequestedAt && typeof shutdownRequestedAt === "object"
        && !Array.isArray(shutdownRequestedAt) ? shutdownRequestedAt : {},
    };
  } catch {
    return { idleSince: {}, shutdownRequestedAt: {} };
  }
}

/**
 * @param {string} path
 * @param {{ idleSince: SinceState, shutdownRequestedAt: SinceState }} state
 * @param {(path: string, data: string) => void} write
 */
export function writeState(path, state, write = writeFileSync) {
  write(path, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The idle-since ledger, one tick on. A worker probed `idle` keeps its EXISTING first-idle timestamp, or
 * gets `now` if this is the first idle tick since it was last busy or unreadable. A worker probed `busy`
 * is dropped (the streak ends the instant it clears -- `fleet-watch.mjs`'s own choice, one condition over).
 *
 * A worker probed `no-answer` is ALSO dropped -- done-when 7.3's own question, decided RESET rather than
 * HOLD: a worker mid-capture is plausibly the one slow to answer (`#2671`: the same synchronous calls that
 * make a probe slow also block the worker's whole event loop, so a box doing real work can miss a `busy`
 * answer and simply not answer at all). Holding the old idle-since across a no-answer would let that
 * capture's own duration count as CONFIRMED idle time the moment the worker answers again -- exactly the
 * miss done-when 7.3 warns against. Resetting costs one full re-accumulation of `IDLE_THRESHOLD_MS` after
 * every blip; that is the safe direction, the same "cost of generosity" shape `fleet-wake.mjs`'s own
 * `HEALTH_TIMEOUT_MS` comment argues from.
 *
 * @param {{ name: string, outcome: string }[]} probes
 * @param {SinceState} previous
 * @param {number} now
 * @returns {SinceState}
 */
export function advance(probes, previous, now) {
  /** @type {SinceState} */
  const next = {};
  for (const probe of probes) {
    if (probe.outcome !== "idle") continue;
    next[probe.name] = previous[probe.name] ?? now;
  }
  return next;
}

/**
 * The shutdown-requested-at ledger, one tick on. A dispatch (`main`, under `--apply`) stamps `now` the
 * moment it asks `sleep.yml` to act; that stamp is KEPT across every tick the worker stays silent
 * afterwards (the expected shape of a box actually going down), and DROPPED the moment the worker answers
 * again -- `idle` (the shutdown never actually happened, or the box came back) or `busy` (a capture raced
 * the shutdown and `sleep.yml`'s own refusal won, which is the whole point of done-when 2).
 *
 * @param {{ name: string, outcome: string }[]} probes
 * @param {SinceState} previous
 * @returns {SinceState}
 */
export function advanceShutdownRequested(probes, previous) {
  /** @type {SinceState} */
  const next = {};
  for (const probe of probes) {
    if (probe.outcome === "no-answer" && previous[probe.name] !== undefined) next[probe.name] = previous[probe.name];
  }
  return next;
}

/**
 * @typedef {{
 *   name: string, hasMac: boolean, probe: "idle" | "busy" | "no-answer",
 *   idleSince: number | null, shutdownRequestedAt: number | null,
 *   batchQueued: boolean, leasePending: boolean,
 * }} DecisionInput
 * @typedef {{ action: "off" | "keep", reason: string }} Decision
 */

/**
 * THE DECISION, PURE (done-when 1). Given every named input, `off` or `keep` and exactly one reason.
 * Order matters only in that each `if` is a strictly narrower question than the last is not required --
 * every branch is independently reachable and independently tested, positive and negative.
 *
 * @param {DecisionInput} input
 * @param {number} now
 * @param {number} idleThresholdMs
 * @returns {Decision}
 */
export function autoOffDecision(input, now, idleThresholdMs = IDLE_THRESHOLD_MS) {
  if (!input.hasMac) return { action: "keep", reason: "no-mac" };
  if (input.shutdownRequestedAt !== null) return { action: "keep", reason: "already-off" };
  if (input.probe === "no-answer") return { action: "keep", reason: "no-answer" };
  if (input.probe === "busy") return { action: "keep", reason: "busy" };
  if (input.batchQueued) return { action: "keep", reason: "batch-queued" };
  if (input.leasePending) return { action: "keep", reason: "lease-pending" };
  if (input.idleSince === null) return { action: "keep", reason: "idle-since-unknown" };
  if (now - input.idleSince < idleThresholdMs) return { action: "keep", reason: "not-yet-five-minutes" };
  return { action: "off", reason: "idle-five-minutes" };
}

/**
 * THE SHUTDOWN, going through `sleep.yml` -- REUSED, NOT REIMPLEMENTED (done-when 2). `sleep.yml` itself
 * re-asks `/health` for `busy` immediately before the shutdown, so this file's own poll -- which could be
 * `POLL_INTERVAL_MS` stale by the time this runs -- is never the last word.
 *
 * No ssh hop: this runs where the fleet SSH key already lives (the control plane), so `ansible-playbook`
 * is invoked LOCALLY, exactly as a human typing `sleep.yml`'s own header comment would.
 *
 * @param {string} name
 * @param {{ run?: typeof spawnSync }} [deps]
 * @returns {{ status: number | null, log: string }}
 */
export function dispatchShutdown(name, { run = spawnSync } = {}) {
  const result = run("ansible-playbook", [`${ANSIBLE_DIR}sleep.yml`, "-l", name], {
    env: { ...process.env, ANSIBLE_CONFIG: `${ANSIBLE_DIR}ansible.cfg` },
    encoding: "utf8",
  });
  // `result.error` is `spawnSync`'s OWN signal that the process never ran at all (ENOENT when
  // `ansible-playbook` is not on PATH, the #2725 defect) -- folded into `log` here because it is the
  // only field the caller reads, and a dropped `error` is exactly how that defect went silent before.
  const errorDetail = result.error ? `${result.error.message}\n` : "";
  return { status: result.status, log: `${errorDetail}${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * One line per worker, in the words of what was decided -- `fleet-wake.mjs`'s `wakeReportLine` shape,
 * one file over. `no-answer` names the seconds waited (done-when 7.4), read off the probe's own timeout
 * rather than re-measured.
 *
 * @param {{ name: string, host: string }} worker
 * @param {Decision} decision
 * @param {number} probeTimeoutMs
 * @returns {string}
 */
export function reportLine(worker, decision, probeTimeoutMs = PROBE_TIMEOUT_MS) {
  const waited = decision.reason === "no-answer" ? ` (waited ${(probeTimeoutMs / 1000).toFixed(1)}s)` : "";
  return `  ${worker.name.padEnd(16)} ${worker.host.padEnd(15)} ${decision.action.padEnd(4)} ${decision.reason}${waited}`;
}

/**
 * ONE TICK: probe every worker, advance the state, decide, and (only under `--apply`) dispatch. Every
 * dependency is injectable with a real default, matching `fleet-watch.mjs`'s `watch()` shape, so a test
 * drives this without a network, a clock, or a fleet.
 *
 * @param {{
 *   workers?: { name: string, host: string, mac: string | null }[],
 *   probe?: typeof probeIdle, now?: () => number, statePath?: string,
 *   read?: typeof readFileSync, write?: typeof writeFileSync,
 *   batchQueued?: () => boolean, leasePending?: () => boolean,
 *   apply?: boolean, dispatch?: typeof dispatchShutdown,
 * }} [deps]
 */
export async function tick(deps = {}) {
  const workers = deps.workers ?? [];
  const probe = deps.probe ?? probeIdle;
  const now = (deps.now ?? Date.now)();
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH;
  // `batchQueued`/`leasePending` DEFAULT FALSE -- the honest gap this file's header names: nothing today
  // produces either signal for a bare-metal worker.
  const batchQueued = deps.batchQueued ?? (() => false);
  const leasePending = deps.leasePending ?? (() => false);
  const apply = deps.apply ?? false;
  const dispatch = deps.dispatch ?? dispatchShutdown;

  const previous = readState(statePath, deps.read);

  const probes = await Promise.all(workers.map(async (w) => ({
    name: w.name, host: w.host, ...(await probe(`http://${w.host}:${PORT}`)),
  })));

  const idleSince = advance(probes, previous.idleSince, now);
  const shutdownRequestedAt = advanceShutdownRequested(probes, previous.shutdownRequestedAt);

  const decisions = workers.map((w) => {
    const p = probes.find((probed) => probed.name === w.name);
    /** @type {DecisionInput} */
    const input = {
      name: w.name,
      hasMac: hasWakeableMac(w.mac),
      probe: /** @type {"idle" | "busy" | "no-answer"} */ (p?.outcome ?? "no-answer"),
      idleSince: idleSince[w.name] ?? null,
      shutdownRequestedAt: shutdownRequestedAt[w.name] ?? null,
      batchQueued: batchQueued(),
      leasePending: leasePending(),
    };
    return { worker: w, decision: autoOffDecision(input, now) };
  });

  if (apply) {
    for (const { worker, decision } of decisions) {
      if (decision.action !== "off") continue;
      const dispatched = dispatch(worker.name);
      // SURFACE A FAILED DISPATCH (done-when 2) -- before this, a `spawnSync` failure (ENOENT when
      // `ansible-playbook` was not on PATH, #2725) was silently discarded here, so a broken dispatch
      // environment read as an infinite, successful-looking retry instead of a visible error. A failed
      // dispatch never actually reached `sleep.yml`, so it does not stamp `shutdownRequestedAt` either --
      // that field means a shutdown was requested, and none was.
      if (dispatched.status !== 0) {
        process.stderr.write(`fleet-auto-off: dispatchShutdown failed for ${worker.name} `
          + `(status=${dispatched.status}): ${dispatched.log}\n`);
        continue;
      }
      shutdownRequestedAt[worker.name] = now;
    }
  }

  writeState(statePath, { idleSince, shutdownRequestedAt }, deps.write);
  return { decisions };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const inventory = inventoryPathFor();
  /** @type {{ name: string, host: string, mac: string | null }[]} */
  let declared;
  try {
    declared = inventoryHosts(readFileSync(inventory, "utf8"));
  } catch (error) {
    process.stderr.write("No fleet to consider: inventory.yml could not be read "
      + `(${/** @type {Error} */ (error).message}).\n`);
    process.exit(2);
    return;
  }
  if (!declared.length) {
    process.stderr.write("No workers in inventory.yml\n");
    process.exit(2);
    return;
  }

  const { decisions } = await tick({ workers: declared, apply });
  for (const { worker, decision } of decisions) process.stdout.write(`${reportLine(worker, decision)}\n`);
  process.stdout.write(apply
    ? "\n  --apply: every `off` above was just dispatched to sleep.yml.\n"
    : "\n  report only: nothing was powered off. Pass --apply to actually dispatch a shutdown.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
