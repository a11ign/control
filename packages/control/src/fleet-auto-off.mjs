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
 * ## A worker is powered off only while it has PROVED it comes back (#3227)
 *
 * The idle test says a box is not needed. It says nothing about whether the box can be brought BACK, and
 * auto-off used to remove any worker with a well-formed MAC, so two boxes that never woke on their reserved
 * address were in the pool (worker 4 never appeared on the network, worker 6 woke at another address).
 * The pool's admission is now a proof, written by `fleet-wake.mjs` when a worker that was SILENT came up
 * ready on its inventory address after one packet, and dropped by any wake that fails. Without a recent
 * proof the worker is `keep wake-unproven` and named so in every report, so a box that has never proved a
 * wake is a visible to-do and never a silent absence. A fresh checkout holds no proof: nothing is powered
 * off until an operator has put one box through `fleet:sleep` then `fleet:wake`, which is the safe direction.
 * The proof is read per worker, so one box's proof, revocation or shutdown moves no other box's decision.
 *
 * ## It refuses to power anything off when the files it RUNS differ from `main` (#3275, same class as #3269)
 *
 * The timer executes `/root/a11y-witness` on the control plane, and nothing moves that checkout when `main` moves:
 * its only fast-forward is `controlPlaneCheckout()`, a side effect of some play. So a safety property merged to `main`
 * (a wake proof, a busy check) is absent from the program that actually powers boxes off. Under `--apply`, and only
 * when some worker is about to be powered off, `checkAgainstMain` compares this program's own import closure (derived
 * by walking its `import`s, so a new import is covered the day it lands) plus `sleep.yml` and the two unit files
 * against `origin/main`, and `staleCheckoutVerdict` refuses on any difference. NOT all of `packages/control/`: 192
 * first-parent merges touched that in 30 days, the closure 7, and a refusal on the former would idle the timer most days.
 *
 * It fails CLOSED, the only direction auto-off may err in: a failed fetch, an unresolvable `origin/main`, an errored
 * diff or an empty closure each refuse (`CANNOT_TELL` is never `identical`). The fetch moves only the remote-tracking
 * ref, never the working tree, so it cannot race a running play; it is throttled to once a minute by a stamp in the
 * state file, and a failed fetch is a refusal whatever the stamp says, never "reuse the last answer".
 *
 * A refusal is LOUD, because fail-closed that nobody sees is a fleet left powered on for days (#2784): the tick prints
 * `refuse <reason>` on every tick that holds a shutdown back, exits 1 so the oneshot unit shows FAILED in
 * `systemctl --failed` and the journal, and records the refusal in the state file for `fleet-watch.mjs`.
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
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxGitEnv } from "../../guards/src/git-env.mjs";
import { requestJson } from "../../worker-fleet/src/worker-http.mjs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { inventoryHosts } from "./fleet-discover.mjs";
import { inventoryPathFor } from "./control-plane-fleet.mjs";
import { magicPacket, readWakeProof, DEFAULT_PROOF_PATH, PROOF_WINDOW_MS } from "./fleet-wake.mjs";
import { recordCaptures, DEFAULT_CAPTURES_STATE_PATH } from "./fleet-watch.mjs";

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
 * An answered probe also carries the worker's `vitals.captures` and `vitals.uptimeMinutes` when it reports
 * them, because this poll is the one that sees the worker's LAST reading before the power-off (#3208).
 *
 * @typedef {{ captures?: number, uptimeMinutes?: number }} Vitals
 * @typedef {({ outcome: "idle" } | { outcome: "busy" }) & Vitals | { outcome: "no-answer", detail: string }} IdleProbe
 */

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * @param {any} json a `/health` body
 * @returns {Vitals}
 */
function vitalsOf(json) {
  const captures = finiteNumber(json?.vitals?.captures);
  const uptimeMinutes = finiteNumber(json?.vitals?.uptimeMinutes);
  return {
    ...(captures === undefined ? {} : { captures }),
    ...(uptimeMinutes === undefined ? {} : { uptimeMinutes }),
  };
}

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
  if (response.json?.busy === true) return { outcome: "busy", ...vitalsOf(response.json) };
  if (response.json?.busy === false) return { outcome: "idle", ...vitalsOf(response.json) };
  return { outcome: "no-answer", detail: "/health answered without a boolean `busy`" };
}

/** @typedef {Record<string, number>} SinceState */

/**
 * @typedef {{ reason: string, detail: string, at: number }} Refusal why a shutdown was held back, and when
 * @typedef {{ idleSince: SinceState, shutdownRequestedAt: SinceState, fetchedAt: number | null,
 *   refusal: Refusal | null }} AutoOffState
 */

/** @param {unknown} value @returns {Record<string, number>} */
const recordOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {any} */ (value) : {});

/**
 * The persisted state: idle-since, shutdown-requested-at, when `origin/main` was last fetched, and the refusal the
 * last tick made (#3275). Missing or corrupt reads as EMPTY, never a crash -- `fleet-watch.mjs`'s own rule, one file
 * over: a tick must not take itself down over its own bookkeeping. An empty `fetchedAt` only costs a fetch.
 *
 * @param {string} path
 * @param {(path: string, encoding: "utf8") => string} read
 * @returns {AutoOffState}
 */
export function readState(path, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(path, "utf8"));
    const refusal = parsed?.refusal;
    return {
      idleSince: recordOf(parsed?.idleSince),
      shutdownRequestedAt: recordOf(parsed?.shutdownRequestedAt),
      fetchedAt: finiteNumber(parsed?.fetchedAt) ?? null,
      refusal: refusal && typeof refusal.reason === "string" ? refusal : null,
    };
  } catch {
    return { idleSince: {}, shutdownRequestedAt: {}, fetchedAt: null, refusal: null };
  }
}

/**
 * @param {string} path
 * @param {Partial<AutoOffState> & { idleSince: SinceState, shutdownRequestedAt: SinceState }} state
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
 *   idleSince: number | null, shutdownRequestedAt: number | null, wakeProvenAt: number | null,
 *   batchQueued: boolean, leasePending: boolean,
 * }} DecisionInput
 * @typedef {{ action: "off" | "keep", reason: string }} Decision
 */

/**
 * Did this worker prove a wake inside `PROOF_WINDOW_MS`? A proof stamped in the future is a clock fault, and
 * is no proof: the answer to "can it be brought back" is never guessed in the direction of powering off.
 *
 * @param {number | null} provenAt
 * @param {number} now
 * @returns {boolean}
 */
function hasRecentWakeProof(provenAt, now) {
  return provenAt !== null && provenAt <= now && now - provenAt <= PROOF_WINDOW_MS;
}

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
  if (!hasRecentWakeProof(input.wakeProvenAt, now)) return { action: "keep", reason: "wake-unproven" };
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
 * The files this program RUNS, repo-relative: `entry` and everything reachable from it by a relative `import`,
 * `export … from` or `import("…")`. Derived rather than listed, so an import added tomorrow is compared tomorrow.
 * Bare specifiers (`node:`, packages) are not followed: they are not files of this checkout. A file that cannot be
 * read throws, which the caller turns into `CANNOT_TELL`.
 *
 * @param {string} entry repo-relative path
 * @param {(path: string) => string} readSource repo-relative path in, file text out
 * @returns {string[]} sorted
 */
export function importClosure(entry, readSource) {
  const seen = new Set([entry]);
  const pending = [entry];
  const specifier = /(?:^\s*(?:import|export)\b[^;'"]*?\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/gm;
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (!/\.m?[jt]s$/.test(file)) continue;
    for (const [, relative] of readSource(file).matchAll(specifier)) {
      const target = posix.join(posix.dirname(file), relative);
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
    }
  }
  return [...seen].sort();
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Repo-relative, derived from where this file is rather than typed, so a move of the package moves the comparison. */
const THIS_FILE = fileURLToPath(import.meta.url).slice(REPO_ROOT.length);

/** Files that decide what a shutdown does but are not imported: the playbook it dispatches and the unit that runs it. */
const RUN_BESIDE_THE_CODE = [
  `${ANSIBLE_DIR.slice(REPO_ROOT.length)}sleep.yml`,
  `${ANSIBLE_DIR.slice(REPO_ROOT.length)}files/a11y-fleet-auto-off.service`,
  `${ANSIBLE_DIR.slice(REPO_ROOT.length)}files/a11y-fleet-auto-off.timer`,
];

export const FETCH_THROTTLE_MS = MS_PER_MINUTE;

const FETCH_TIMEOUT_MS = 20_000;

/** @typedef {(args: string[]) => { status: number | null, stdout: string, stderr: string }} Git */

/**
 * THE DECISION, PURE. `differing` is the repo-relative files whose content differs from `origin/main`, or `null`
 * when that could not be established (unresolvable `origin/main`, errored diff, empty closure): "could not tell" and
 * "identical" never share a value. `fetchOk` is whether `origin/main` is known to be at most `FETCH_THROTTLE_MS`
 * old. Only a fresh ref and an empty difference proceed.
 *
 * @param {{ differing: string[] | null, fetchOk: boolean }} input
 * @returns {{ action: "proceed" } | { action: "refuse", reason: "fetch-failed" | "cannot-tell" | "stale-checkout",
 *   detail: string }}
 */
export function staleCheckoutVerdict({ differing, fetchOk }) {
  if (!fetchOk) return { action: "refuse", reason: "fetch-failed", detail: "`git fetch origin main` did not succeed" };
  if (differing === null) {
    return { action: "refuse", reason: "cannot-tell", detail: "origin/main could not be compared with the files that run" };
  }
  if (differing.length) {
    return { action: "refuse", reason: "stale-checkout",
      detail: `${differing.length} ${differing.length === 1 ? "file differs" : "files differ"}: ${differing.join(", ")}` };
  }
  return { action: "proceed" };
}

/**
 * Files of `paths` that differ from `origin/main`, in the working tree (what RUNS, not what is committed). A file
 * `git diff` cannot see because the checkout does not track it counts as differing.
 *
 * @param {string[]} paths
 * @param {Git} git
 * @returns {string[] | null} `null` when `git` could not say
 */
function filesDifferingFromMain(paths, git) {
  const diff = git(["diff", "--name-only", "origin/main", "--", ...paths]);
  const tracked = git(["ls-files", "--", ...paths]);
  if (diff.status !== 0 || tracked.status !== 0) return null;
  const known = new Set(tracked.stdout.split("\n"));
  const untracked = paths.filter((path) => !known.has(path));
  return [...new Set([...diff.stdout.split("\n").filter(Boolean), ...untracked])].sort();
}

/**
 * Is the checkout this program runs from the same, where it matters, as `origin/main`?
 *
 * @param {{ now: number, fetchedAt: number | null, git: Git, readSource: (path: string) => string }} where
 * @returns {{ verdict: ReturnType<typeof staleCheckoutVerdict>, fetchedAt: number | null }}
 */
export function checkAgainstMain({ now, fetchedAt, git, readSource }) {
  // A stamp from the future is a clock fault, not a fresh fetch.
  const fresh = fetchedAt !== null && fetchedAt <= now && now - fetchedAt < FETCH_THROTTLE_MS;
  const fetchOk = fresh || git(["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]).status === 0;
  const stamp = fetchOk && !fresh ? now : fetchedAt;
  let differing = null;
  if (fetchOk) {
    try {
      const closure = importClosure(THIS_FILE, readSource);
      // This file imports plenty; a closure of just itself means the walk found nothing, which is not "no differences".
      differing = closure.length > 1 ? filesDifferingFromMain([...closure, ...RUN_BESIDE_THE_CODE], git) : null;
    } catch {
      differing = null;
    }
  }
  return { verdict: staleCheckoutVerdict({ differing, fetchOk }), fetchedAt: stamp };
}

/** @type {Git} */
const gitInRepo = (args) => {
  const result = spawnSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8", timeout: FETCH_TIMEOUT_MS, env: sandboxGitEnv(),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** @param {string} path repo-relative */
const readFromRepo = (path) => readFileSync(`${REPO_ROOT}${path}`, "utf8");

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
 * Feed what the probes read into the capture ledger `fleet-watch.mjs` keeps hourly (#3208). That poll sees a
 * worker only while it is up AT the poll, and this idle auto-off keeps a worker up for its job plus five
 * minutes, so a short job's worker came and went between two polls and its captures vanished with its
 * process. This loop reads every up worker every `POLL_INTERVAL_MS`, so the last reading before a power-off
 * lands here. A worker that answered without `vitals.captures` (or not at all) is no reading and records
 * nothing. Rows are named as `fleet-status.mjs` names them, `<name>  <address>`, so the two writers agree
 * on a worker's key whichever of them saw it first.
 *
 * Bookkeeping never takes the tick down: a ledger that cannot be read or written is reported on stderr and
 * the shutdown decisions go on, since a worker left up because of a bad file is a cost, not a safeguard.
 *
 * @param {(IdleProbe & { name: string, host: string })[]} probes
 * @param {{ path: string, at: number, read?: typeof readFileSync, write?: typeof writeFileSync }} where
 */
function recordProbedCaptures(probes, where) {
  const rows = probes.flatMap((probe) => (probe.outcome === "no-answer" || probe.captures === undefined ? [] : [{
    name: probe.name === probe.host ? probe.host : `${probe.name}  ${probe.host}`,
    state: probe.outcome,
    captures: probe.captures,
    uptimeMinutes: probe.uptimeMinutes ?? null,
  }]));
  if (!rows.length) return;
  try {
    recordCaptures(rows, where);
  } catch (cause) {
    process.stderr.write(`fleet-auto-off: the capture ledger was not updated (${where.path}): `
      + `${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}

/**
 * One worker's decision input, from what the tick knows about the whole fleet. Every field is read BY NAME,
 * so no worker's proof, idle streak or shutdown stamp can reach another worker's decision (#3227).
 *
 * @param {{ name: string, mac: string | null }} w
 * @param {string} outcome
 * @param {{ idleSince: SinceState, shutdownRequestedAt: SinceState, wakeProof: Record<string, number>,
 *   batchQueued: () => boolean, leasePending: () => boolean }} known
 * @returns {DecisionInput}
 */
function decisionInput(w, outcome, known) {
  return {
    name: w.name,
    hasMac: hasWakeableMac(w.mac),
    probe: /** @type {"idle" | "busy" | "no-answer"} */ (outcome),
    idleSince: known.idleSince[w.name] ?? null,
    shutdownRequestedAt: known.shutdownRequestedAt[w.name] ?? null,
    wakeProvenAt: known.wakeProof[w.name] ?? null,
    batchQueued: known.batchQueued(),
    leasePending: known.leasePending(),
  };
}

/**
 * Dispatch `sleep.yml` at every worker decided `off`, stamping each success into `shutdownRequestedAt`.
 *
 * @param {{ worker: { name: string }, decision: Decision }[]} decisions
 * @param {{ dispatch: typeof dispatchShutdown, shutdownRequestedAt: SinceState, now: number }} where
 */
function dispatchOff(decisions, { dispatch, shutdownRequestedAt, now }) {
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

/**
 * Hold every shutdown back while this checkout differs from `main` (#3275). Asked only when something is about to be
 * powered off, so an idle fleet costs no fetch; the held workers read `keep <reason>` in the report, which is where an
 * operator looks.
 *
 * @param {{ worker: { name: string, host: string }, decision: Decision }[]} decisions
 * @param {{ now: number, fetchedAt: number | null,
 *   checkout: (where: { now: number, fetchedAt: number | null }) => ReturnType<typeof checkAgainstMain> }} where
 */
function holdBackIfStale(decisions, { now, fetchedAt, checkout }) {
  if (!decisions.some(({ decision }) => decision.action === "off")) return { decisions, refusal: null, fetchedAt };
  const checked = checkout({ now, fetchedAt });
  if (checked.verdict.action === "proceed") return { decisions, refusal: null, fetchedAt: checked.fetchedAt };
  const { reason, detail } = checked.verdict;
  return {
    decisions: decisions.map(({ worker, decision }) => ({
      worker, decision: decision.action === "off" ? { action: /** @type {const} */ ("keep"), reason } : decision,
    })),
    refusal: { reason, detail, at: now },
    fetchedAt: checked.fetchedAt,
  };
}

/**
 * ONE TICK: probe every worker, advance the state, decide, and (only under `--apply`) dispatch. Every
 * dependency is injectable with a real default, matching `fleet-watch.mjs`'s `watch()` shape, so a test
 * drives this without a network, a clock, or a fleet.
 *
 * @param {{
 *   workers?: { name: string, host: string, mac: string | null }[],
 *   probe?: typeof probeIdle, now?: () => number, statePath?: string, capturesPath?: string, proofPath?: string,
 *   read?: typeof readFileSync, write?: typeof writeFileSync,
 *   batchQueued?: () => boolean, leasePending?: () => boolean,
 *   apply?: boolean, dispatch?: typeof dispatchShutdown,
 *   checkout?: (where: { now: number, fetchedAt: number | null }) => ReturnType<typeof checkAgainstMain>,
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
  const checkout = deps.checkout
    ?? ((/** @type {{ now: number, fetchedAt: number | null }} */ where) => checkAgainstMain({
      ...where, git: gitInRepo, readSource: readFromRepo,
    }));

  const previous = readState(statePath, deps.read);
  const wakeProof = readWakeProof(deps.proofPath ?? DEFAULT_PROOF_PATH, deps.read);

  const probes = await Promise.all(workers.map(async (w) => ({
    name: w.name, host: w.host, ...(await probe(`http://${w.host}:${PORT}`)),
  })));

  recordProbedCaptures(probes, { path: deps.capturesPath ?? DEFAULT_CAPTURES_STATE_PATH, at: now, read: deps.read, write: deps.write });

  const idleSince = advance(probes, previous.idleSince, now);
  const shutdownRequestedAt = advanceShutdownRequested(probes, previous.shutdownRequestedAt);

  const known = { idleSince, shutdownRequestedAt, wakeProof, batchQueued, leasePending };
  const decided = workers.map((w) => {
    const p = probes.find((probed) => probed.name === w.name);
    return { worker: w, decision: autoOffDecision(decisionInput(w, p?.outcome ?? "no-answer", known), now) };
  });
  const { decisions, refusal, fetchedAt } = apply
    ? holdBackIfStale(decided, { now, fetchedAt: previous.fetchedAt, checkout })
    : { decisions: decided, refusal: null, fetchedAt: previous.fetchedAt };

  if (apply) dispatchOff(decisions, { dispatch, shutdownRequestedAt, now });

  writeState(statePath, { idleSince, shutdownRequestedAt, fetchedAt, refusal }, deps.write);
  return { decisions, refusal };
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

  const { decisions, refusal } = await tick({ workers: declared, apply });
  for (const { worker, decision } of decisions) process.stdout.write(`${reportLine(worker, decision)}\n`);
  if (refusal) {
    // Every tick that holds a shutdown back says so, and the unit FAILS: a refusal nobody sees is a fleet left on.
    process.stdout.write(`\n  refuse ${refusal.reason} -- ${refusal.detail}\n`);
    process.exitCode = 1;
  }
  const unproven = decisions.filter(({ decision }) => decision.reason === "wake-unproven").map(({ worker }) => worker.name);
  if (unproven.length) {
    process.stdout.write(`\n  kept on for want of a recent wake proof: ${unproven.join(", ")}. A proof is earned by `
      + "`fleet:sleep` then `fleet:wake` of that one worker, answering on its own address.\n");
  }
  process.stdout.write(refusal
    ? "\n  --apply: NOTHING was dispatched; the checkout this runs from is not main's (see `refuse` above).\n"
    : apply
    ? "\n  --apply: every `off` above was just dispatched to sleep.yml.\n"
    : "\n  report only: nothing was powered off. Pass --apply to actually dispatch a shutdown.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
