// @ts-check
/**
 * What is every worker doing, right now?
 *
 *     npm run fleet:status
 *     npm run fleet:status -- --json
 *
 * ## Why this exists
 *
 * The request that started this was "switch to webhooks instead of polling for status". The efficiency
 * half of that premise does not survive measurement — a full 1,061-case corpus run makes ~3,192 worker
 * requests in four hours, two thirds of which are the captures themselves — but the half underneath it
 * is exactly right: **you cannot see what your boxes are doing.** `capture-status.mjs` prints one
 * `worker:` line and probes that one worker, even for a twelve-machine pool.
 *
 * So: this IS polling, and calling it anything else would be dishonest. What makes it cheap is that it
 * polls only when a human asks, and that both endpoints it reads are already deployed.
 *
 * ## `/progress` was already there, consumed by nothing
 *
 * Every worker has served `GET /progress` since the day a capture that hung for five minutes could only
 * tell you that it had died. It exposes the in-flight capture's URL, elapsed time and phase marks — free
 * visibility, already on every box, read by no code anywhere in this repo until now. That is why this
 * command needs no worker-side change and therefore no redeploy.
 *
 * ## The three questions it answers that a per-worker curl cannot
 *
 * - **Which box is degrading?** `assessWorker` judges on the RECOVERY RATE, not failures, because the
 *   worker's own retry absorbs faults and `failures` stays 0 while a guest runs at three times the cost
 *   of its neighbours.
 * - **Are these boxes still interchangeable?** `fleetConsistency` compares the fields that are in the
 *   CAPTURE CACHE KEY. A split fleet does not error; it just stops hitting the cache, "which reads as
 *   ordinary churn rather than as a split fleet".
 * - **Is a box that does not answer on the network at all?** (#1298) The control plane's neighbour table
 *   says OFF THE NETWORK, ON THE NETWORK, or that it cannot tell -- printed before the table, because a
 *   loose cable and a dead worker look identical from the capture port.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// MOVED here from packages/worker-fleet/src 2026-09-06 (architecture audit §3.2): this file has zero
// cross-package dependents, so keeping it in the published worker-fleet package while it reads control's
// own inventory was the cycle with nothing on the other side to justify it. `fleet-env.mjs` stays in
// worker-fleet -- published bins (doctor.mjs, check-worker-code.mjs) depend on it -- so these imports
// cross the boundary the SANCTIONED way, relative, exactly like `fleet-playbook.mjs` and `lab-job.mjs`
// already do.
import { requestJson } from "../../worker-fleet/src/worker-http.mjs";
import { configuredWorkers, workersFromInventory, workerNamesFromInventory, portFromGroupVars }
  from "../../worker-fleet/src/fleet-env.mjs";
import { assessWorker } from "../../worker-fleet/src/worker-health.mjs";
import { fleetConsistency, describeMismatches } from "../../worker-fleet/src/fleet-consistency.mjs";
import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.mjs";
import { requireControlPlaneHost, requireControlPlaneKey } from "./control-plane-host.mjs";

/**
 * as `doctor`.
 *
 * An unrecognised flag is otherwise IGNORED, so it runs the default and reports success.
 */
refuseUnknownFlags(["--json"], { entry: import.meta.url, command: "npm run fleet:status" });

/** Short: a status table is unreadable if one slow box holds it up. */
const PROBE_TIMEOUT_MS = 5_000;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * The fleet, from the environment if it names one, otherwise from the inventory.
 *
 * Both, because the two are used at different moments: `A11Y_WORKERS` is what a run has set, and the
 * inventory is the durable definition. Falling back rather than requiring the env var means this works
 * in a fresh shell, which is when you most want to ask what the fleet is doing.
 */
export function fleetToProbe() {
  const named = configuredWorkers();
  if (named.length) return named;
  try {
    const inventory = readFileSync(fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)), "utf8");
    const groupVars = readFileSync(
      fileURLToPath(new URL("../ansible/group_vars/a11y_workers.yml", import.meta.url)), "utf8");
    const port = portFromGroupVars(groupVars);
    // The INVENTORY NAME beside the address, because every command that acts on a worker takes the name
    // (`fleet:deploy --limit=a11y-worker-4`, `fleet:sleep`, `lab:job -e worker=`) while this report showed
    // only the address. On 2026-08-24 that cost a wrong action: this table named .224 as the box whose Edge
    // had drifted, and .224 is a11y-worker-FIVE — so `fleet:sleep --limit=a11y-worker-4` put a healthy
    // machine to sleep and left the drifted one serving. A report and a command that cannot be matched up
    // is a report you have to translate, and translation is where the mistake goes.
    const names = workerNamesFromInventory(inventory, { port });
    return workersFromInventory(inventory, { port })
      .map((url) => ({
        name: names[url] ? `${names[url]}  ${url.replace(/^https?:\/\//, "")}` : url.replace(/^https?:\/\//, ""),
        url,
      }));
  } catch (error) {
    throw new Error(
      "No fleet to report on: A11Y_WORKERS is unset and the inventory could not be read "
      + `(${/** @type {Error} */ (error).message}). Set one, or add a host to packages/control/ansible/inventory.yml.`,
      { cause: error });
  }
}

/**
 * One worker's state, from both endpoints.
 *
 * Unreachable is a RESULT, not a throw: a fleet report whose job is to say which box is missing must not
 * be taken down by the box that is missing.
 */
/**
 * @param {{ name: string, url: string }} worker
 * @returns {Promise<{ name: string, url: string, reachable: boolean,
 *                     health?: Record<string, any>, progress?: Record<string, any>, error?: string }>}
 */
export async function probeWorker({ name, url }) {
  const ask = async (/** @type {string} */ path) => {
    const response = await requestJson(`${url}${path}`, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json ?? {};
  };
  try {
    // Both at once. Twelve workers probed serially at a 5 s timeout is a minute of staring at nothing.
    const [health, progress] = await Promise.all([ask("/health"), ask("/progress")]);
    return { name, url, reachable: true, health, progress };
  } catch (error) {
    return { name, url, reachable: false, error: /** @type {Error} */ (error).message ?? String(error) };
  }
}

/** `ready`, `busy`, `warming` or `unreachable` — four states, because collapsing any two loses the point. */
/**
 * @param {WorkerProbe} probe
 * @returns {string}
 */
export function stateOf(probe) {
  if (!probe.reachable) return "unreachable";
  if (probe.health?.busy) return "busy";
  // `ready !== false`, matching workerIsUsable: a worker predating the field reports neither, and
  // calling that "warming" forever would be wrong about a perfectly good older guest.
  if (probe.health?.ready === false) return "warming";
  return "ready";
}

/**
 * What a busy worker is actually doing, in one line.
 *
 * **Gated on `busy`, which this function's own comment always claimed and the code never checked.**
 * `/progress` keeps the last capture's record after it finishes, so an IDLE worker reported the case it
 * had already completed — and `elapsedMs` keeps growing, so it presents as a capture that has been stuck
 * for however long the box has been sitting there. Observed: a `ready` worker showing
 * `36m41s @browserKeptAlive` half an hour after its run ended.
 *
 * That is not cosmetic. A long-running phase is precisely the signature this column exists to surface —
 * "a phase current for four minutes is the one that is stuck" — so a stale record is indistinguishable
 * from the fault it was built to detect, and it gets worse the longer the fleet is healthy. The repo's
 * "404 and 202 are different answers" rule, applied to a status display: *finished* and *still going*
 * must never render the same.
 */
/** @typedef {{ name: string, url: string, reachable: boolean, health?: Record<string, any>,
 *               progress?: Record<string, any>, error?: string }} WorkerProbe */

/** @param {WorkerProbe} probe */
export function activityOf(probe) {
  const progress = probe.progress;
  // `progress.busy`, not `health.busy`: `capturing` comes from this same payload, and health and progress
  // are two separate requests, so reading the flag from one and the case from the other samples two
  // different instants. Measured on a11y-worker-2: `{busy: false, capturing: ".../table-unassociated-
  // hilltown/bad.html", elapsedMs: 2526239}` -- 42 minutes after that capture finished, and still climbing.
  if (!progress?.busy) return "";
  if (!progress?.capturing) return "";
  const seconds = Math.round((progress.elapsedMs ?? 0) / MS_PER_SECOND);
  const elapsed = seconds >= SECONDS_PER_MINUTE
    ? `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}s`
    : `${seconds}s`;
  // The phase it is IN is the one after the last completed mark, so the mark's NAME plus its age is what
  // identifies a hang: a phase current for four minutes is the one that is stuck.
  const phase = progress.lastPhase ? ` @${progress.lastPhase}` : "";
  return `${elapsed}${phase}  ${shortUrl(progress.capturing)}`;
}

/** @param {string} url */
function shortUrl(url) {
  try {
    const { pathname, host } = new URL(url);
    return `${host}${pathname}`;
  } catch {
    return String(url);
  }
}

/** The per-worker rows, as data, so the renderer and `--json` cannot disagree about what was found. */
/** @param {WorkerProbe[]} probes */
export function summarise(probes) {
  return probes.map((probe) => {
    const vitals = probe.health?.vitals ?? null;
    const assessment = assessWorker(vitals);
    return {
      name: probe.name,
      url: probe.url,
      state: stateOf(probe),
      code: probe.health?.code ?? null,
      captures: vitals?.captures ?? null,
      recoveries: vitals?.recoveries ?? null,
      degraded: assessment.degraded,
      degradedReason: assessment.reason,
      activity: activityOf(probe),
      error: probe.error ?? null,
    };
  });
}

/**
 * @typedef {ReturnType<typeof summarise>[number]} WorkerRow
 *
 * DERIVED from `summarise` rather than written out again. The renderer and `--json` must not disagree
 * about what a row is -- which is what the docstring on `summarise` already says the rows exist for --
 * and a second hand-written description of the same object is how those two come apart.
 */

/**
 * What to DO about a degraded worker, or "" when none is.
 *
 * DEGRADED IS THE FAULT THAT PRODUCES ZERO FAILURES, which makes it the one a reader is least equipped to
 * act on and most likely to skim past. The worker's own retry absorbs every recovery, so captures keep
 * SUCCEEDING and `failures` stays 0 while that box runs at roughly three times a healthy peer's cost --
 * measured 122.9 s against 40.6 s. The eviction rule counts consecutive FAILURES, so it can never fire.
 *
 * Naming the repair beside the state is the whole of this: a reader who has not read the runbook cannot
 * get from "2 recoveries DEGRADED" to "reinstall NVDA on that box", and the row this closes is about
 * exactly that gap.
 *
 * PURE and exported so the advice can be tested without a fleet. It was first written inline in `main`
 * reading a `degradedNames` array built in `renderTable` -- a scope error that would have thrown only
 * when a worker was actually degraded, which is the one moment it must work.
 *
 * @param {Array<{name: string, degraded?: boolean}> | undefined} rows
 * @returns {string}
 */
export function degradedAdvice(rows) {
  const names = (rows ?? []).filter((r) => r?.degraded).map((r) => String(r.name).split(/\s+/)[0]);
  if (!names.length) return "";
  return `  ${names.length} worker(s) DEGRADED: ${names.join(", ")}.\n`
    + "  Their own retry is absorbing a fault, so captures still SUCCEED and `failures` stays 0 while\n"
    + "  they run at roughly three times a healthy peer's cost. This is the fault that HIDES.\n"
    + "  Repair: `npm run fleet:provision -- --limit=<name>` reinstalls NVDA on that box. Confirm with\n"
    + "  `npm run worker:compare -- <page> <healthy> <degraded>` \u2014 wall time says slower without\n"
    + "  saying where; the phase table says which phase.\n";
}

/** @param {WorkerRow[]} rows */
function renderTable(rows) {
  const width = (/** @type {(row: WorkerRow) => unknown} */ pick) =>
    Math.max(...rows.map((r) => String(pick(r) ?? "").length), 0);
  const nameWidth = Math.max(width((r) => r.name), "worker".length);
  const stateWidth = Math.max(width((r) => r.state), "state".length);

  const lines = [
    `  ${"worker".padEnd(nameWidth)}  ${"state".padEnd(stateWidth)}  ${"code".padEnd(16)}  vitals / doing`,
    `  ${"-".repeat(nameWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(16)}  ${"-".repeat(30)}`,
  ];
  for (const row of rows) {
    const vitals = row.captures === null
      ? (row.error ?? "")
      : `${row.captures} captures, ${row.recoveries} recoveries${row.degraded ? "  DEGRADED" : ""}`;
    // DEGRADED IS THE FAULT THAT PRODUCES ZERO FAILURES, so a reader is least likely to know what to do
    // about it and most likely to read it as noise. The worker's own retry absorbs every recovery, so
    // `failures` stays 0 while that box runs at ~3x its neighbours' cost -- measured 122.9 s against a
    // healthy peer's 40.6 s. Naming the repair beside it is the difference between a number a reader must
    // interpret and an instruction they can follow.

    lines.push(`  ${row.name.padEnd(nameWidth)}  ${row.state.padEnd(stateWidth)}  `
      + `${String(row.code ?? "-").padEnd(16)}  ${row.activity || vitals}`);
    // A degraded worker still SERVES, so it is a line under the row rather than a state: pulling it
    // from a small pool costs more throughput than it saves, and the run retires it on its own terms.
    if (row.degraded) lines.push(`  ${" ".repeat(nameWidth)}  -> ${row.degradedReason}`);
  }
  return lines;
}

/**
 * THE CONSISTENCY VERDICT, WITH ITS DENOMINATOR — #920.
 *
 * NAMED `consistencyVerdict`, NOT `fleetVerdict`, and the first version was the second. `fleetVerdict`
 * is the shared gate helper in `packages/lab/src/gates/fleet.mjs`, and `exit-code-contract.test.ts`
 * detects adoption of the exit-code contract by that name — so a same-named function here made this
 * file read as adopting a contract it does not use, while also being listed as DOCUMENTED. CI caught
 * it as "a script cannot adopt the contract AND carry its own". A name that is already somebody
 * else's identifier is a claim about what the code does, in exactly the way a comment is.
 *
 * `fleetStatus` compared only the boxes that answered and printed `fleet CONSISTENT` over them, while the
 * reachability count sat on a separate line. **An unreachable box that has drifted reads as agreement.**
 * Measured: the status read CONSISTENT over nine boxes, and the tenth — excluded for not answering — was
 * `a11y-worker-4`, on Windows `10.0.26200` where the other nine are on `10.0.22631`. The OS is a
 * capture-cache key, so the fleet was inconsistent, the command said otherwise for a day, and five
 * captures (#29) were taken on the divergent box in that time.
 *
 * `ceo`'s ruling: **never CONSISTENT over a subset.** Three states, and two of them must not collapse:
 *
 *   `CONSISTENT`    every box in the inventory was compared, and they agree
 *   `INCONSISTENT`  the boxes that WERE compared disagree — a real finding whatever the rest would say
 *   `UNKNOWN`       the compared ones agree, but not all of them could be compared
 *
 * "Nine agree and one did not answer" is not "ten disagree", and a reader acts differently on each: the
 * first is a box to reach, the second is a fleet to re-provision.
 *
 * **The denominator is `compared`, not `reachable`**, and the difference is the same defect one level
 * down. `fleetConsistency` drops a guest that reports no `environment` before comparing, so a box can
 * answer `/health` and still not be in the set the verdict is about. Using the reachable count here would
 * have fixed the instance and left the class.
 *
 * `doctor`'s `checkFleetConsistency` already says "N of M guests agree … the rest could not be asked". It
 * learned this first; this command, whose whole job is to describe the fleet, never did.
 *
 * **AND A CLEAN ENVIRONMENT COMPARISON IS NOT A USABLE FLEET — #1029.** This function used to take no
 * readiness input at all, so its verdict was byte-identical whether or not a box could capture. Measured:
 * `a11y-worker-4` sat `warming` behind a `PhoneExperienceHost` dialog for ~19.7 hours while this line read
 * `fleet CONSISTENT across 10 of 10 — these workers are interchangeable for capture`. They were not
 * interchangeable; one of them could not capture at all.
 *
 * That is THE SAME CLASS as the denominator lesson above, one field over: it was applied to which boxes
 * were COMPARED and never to whether a compared box can WORK. A guest that answers `/health`, reports a
 * matching environment and cannot start NVDA was counted as agreeing, and the headline called the set
 * interchangeable. `ready` is the field this repo already ruled you dispatch on; the headline verdict was
 * the one place that did not.
 *
 * **Two facts, one verdict, and the verdict is the pessimistic one.** The consistency answer is not
 * deleted — it is real, separate, and still printed in the BLOCKED line — it simply may no longer stand
 * in for usability.
 *
 * **AND NO READINESS SUPPLIED IS `UNKNOWN`, NOT `CONSISTENT`.** `rows` has no default: a caller that omits
 * it has not asked whether the fleet can capture, and answering the permissive way is the same defect this
 * function was fixed for, one door over. worker-judge's tiebreak, reviewing #1048: when the safe direction
 * and the permissive direction are one line apart, take the safe one.
 *
 * `busy` IS NOT A FAULT. A worker mid-capture is the system working, and refusing a healthy fleet under
 * load is the easy wrong fix; only `warming` and `unreachable` may hold the headline down.
 *
 * @param {{ consistent: boolean, compared: number, total: number, mismatches?: unknown[],
 *           rows?: { name?: string, state?: string }[] }} input `rows` carries each box's `stateOf`
 * @returns {{ state: "CONSISTENT" | "INCONSISTENT" | "UNKNOWN" | "BLOCKED", line: string }}
 */
export function consistencyVerdict({ consistent, compared, total, mismatches = [], rows }) {
  const across = `across ${compared} of ${total}`;
  if (compared === 0) {
    return { state: "UNKNOWN",
      line: `fleet UNKNOWN — 0 of ${total} boxes reported an environment to compare` };
  }
  if (!consistent) {
    return { state: "INCONSISTENT",
      line: `fleet INCONSISTENT ${across} — ${describeMismatches(/** @type {any} */ (mismatches)).join("; ")}` };
  }
  if (compared < total) {
    return { state: "UNKNOWN",
      line: `fleet UNKNOWN — the ${compared} compared agree, and ${total - compared} of ${total} could not be `
        + "compared. A box that did not answer and has drifted reads exactly like one that agrees, so this "
        + "is not a consistent fleet until it answers" };
  }
  // NO READINESS SUPPLIED IS CANNOT ASK, NOT "ALL READY". A default that silently answers the permissive
  // way is the 19.7 hours in miniature: this function's whole defect was answering a question it had not
  // been given the inputs for. There is exactly one production caller and it passes `rows`, so this
  // changes no real verdict -- it closes the door through which the same bug walks back in.
  if (rows === undefined) {
    return { state: "UNKNOWN",
      line: `fleet UNKNOWN — the environments agree ${across}, and no readiness was supplied, so whether `
        + "these boxes can capture was never asked. A consistent environment is not a usable fleet" };
  }
  // NAMED, NEVER COUNTED. "blocked" and "blocked on a11y-worker-4, warming" are different instructions:
  // one sends a reader to `fleet:status` again, the other sends them to a box.
  const blocked = rows.filter((row) => row.state === "warming" || row.state === "unreachable");
  if (blocked.length > 0) {
    const named = blocked.map((row) => `${row.name ?? "an unnamed box"}, ${row.state}`).join("; ");
    return { state: "BLOCKED",
      line: `fleet BLOCKED — the environments agree ${across}, and ${blocked.length} of ${total} cannot `
        + `capture: ${named}. A consistent environment is not a usable fleet, and this line used to read `
        + "CONSISTENT for 19.7 hours while a box was held behind a dialog" };
  }
  return { state: "CONSISTENT",
    line: `fleet CONSISTENT ${across} — these workers are interchangeable for capture` };
}

// --- #1298: IS A BOX THAT DOES NOT ANSWER ON THE NETWORK AT ALL? ---

/**
 * THE LINK-LAYER READ'S WINDOW. On a send, Linux moves a STALE neighbour entry to DELAY, waits
 * `delay_first_probe_time` (5 s by default) for a confirmation, then sends `ucast_solicit` (3) probes a
 * second apart before FAILED -- roughly nine seconds from the ping to an answer. Twelve polls a second
 * apart cover that, and the read is paid only when a box did not answer `/health`.
 */
const NEIGHBOUR_POLLS = 12;
const NEIGHBOUR_READ_TIMEOUT_MS = 45_000;
/** ssh's own exit status for a connection it could not make, as distinct from the remote command's. */
const SSH_OWN_FAILURE = 255;
/** The injection guard for `neighbourScript`, not tidiness: that string is parsed by a remote shell. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * THE FOUR LAYER-2 ANSWERS for a box that did not answer `/health` -- #1298, amended by `ceo` 2026-09-13.
 *
 * The chairman's direction: "We need to be able to easily determine when a machine is offline." During
 * #918's rollout a worker with a loose Ethernet cable read `EHOSTDOWN` on the capture port and UNREACHABLE
 * to the provisioning play -- the signature of a powered-off box, a wedged NIC, a wrong address and a
 * firewall alike -- and nothing said "this box is not on the network at all" before a key install was
 * attempted on it.
 *
 * FOUR, NOT THREE. `on` and `off` are the two answers the link layer gives. `unasked` is the control plane
 * not being there to ask. `noVerdict` is asking and getting a cached entry that never settled: measured
 * 2026-09-13 by `fleet-link-view.yml`, 8 of 10 HEALTHY boxes still read STALE after a probe, so folding it
 * into either answer would send somebody on the wrong errand.
 */
export const LINK = Object.freeze({ ON: "on", OFF: "off", NO_VERDICT: "noVerdict", UNASKED: "unasked" });

/** @typedef {{ verdict: string, detail: string }} LinkAnswer */
/** @typedef {Map<string, LinkAnswer>} LinkAnswers */

/**
 * One box's answer from its neighbour-table lines over the polling window, oldest first.
 *
 * ONLY `REACHABLE` AND `FAILED` ARE ANSWERS -- the rule `fleet-link-view.yml` measured its way to -- and the
 * LAST one seen is reported, because the question is whether the box is on the wire now. An address that
 * never appeared at all was never resolved from the control plane, so it is not on that segment: that is
 * no verdict, never OFF. Not seen is not absent.
 *
 * @param {string[]} lines `ip neigh show <address>` per poll, "" where the table had no entry
 * @returns {LinkAnswer}
 */
export function linkVerdictOf(lines) {
  const states = lines.map((line) => line.trim().split(/\s+/).pop() ?? "").filter(Boolean);
  const answer = states.filter((state) => state === "REACHABLE" || state === "FAILED").pop();
  if (answer === "REACHABLE") return { verdict: LINK.ON, detail: answer };
  if (answer === "FAILED") return { verdict: LINK.OFF, detail: answer };
  if (!states.length) {
    return { verdict: LINK.NO_VERDICT,
      detail: "never in the control plane's neighbour table, so not on its segment" };
  }
  return { verdict: LINK.NO_VERDICT,
    detail: `last read ${states[states.length - 1]}, a cached entry that never settled` };
}

/**
 * The command the control plane runs: one ping per address so the kernel re-resolves it, then each
 * address's neighbour entry once a second. Every address has matched `IPV4` before it is interpolated.
 *
 * @param {string[]} addresses
 * @returns {string}
 */
export function neighbourScript(addresses) {
  const refused = addresses.filter((address) => !IPV4.test(address));
  if (refused.length) {
    throw new Error(`neighbourScript: not IPv4 addresses, refusing to send them to a shell: ${refused.join(", ")}`);
  }
  const list = addresses.join(" ");
  return `for a in ${list}; do ping -c 1 -W 1 "$a" >/dev/null 2>&1 & done; i=0; `
    + `while [ "$i" -lt ${NEIGHBOUR_POLLS} ]; do for a in ${list}; do `
    + `printf '%s|%s\\n' "$a" "$(ip neigh show "$a")"; done; `
    + "sleep 1; i=$((i+1)); done; wait";
}

/**
 * `address|neighbour line`, one per poll, into each address's lines in order.
 *
 * @param {string} stdout
 * @returns {Map<string, string[]>}
 */
export function parseNeighbourPolls(stdout) {
  /** @type {Map<string, string[]>} */
  const polls = new Map();
  for (const line of stdout.split("\n")) {
    const bar = line.indexOf("|");
    if (bar < 0) continue;
    const address = line.slice(0, bar);
    polls.set(address, [...(polls.get(address) ?? []), line.slice(bar + 1)]);
  }
  return polls;
}

/** @param {string} url */
function addressOf(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return `${url} (${/** @type {Error} */ (error).message})`;
  }
}

/** @returns {{ host: string, key: string }} */
function controlPlaneFromEnvironment() {
  return { host: requireControlPlaneHost(), key: requireControlPlaneKey() };
}

/**
 * WHICH FAILURE decides the words -- worker-capture's should-fix on #1311.
 *
 * Only ssh's own 255, or ssh never starting, means the control plane was NOT ASKED. Any other non-zero
 * status means it answered and the script failed there, and a timeout or a kill cannot say which -- so
 * those are no verdict, never "control plane unreachable", which would send somebody to check a network
 * path that worked. The gate holds on every one of them alike; only the errand differs.
 *
 * @param {{ error?: NodeJS.ErrnoException, status: number | null }} result what `spawnSync` returned
 * @returns {LinkAnswer | null} null when the read succeeded
 */
export function failedRead({ error, status }) {
  if (error?.code === "ETIMEDOUT") {
    return { verdict: LINK.NO_VERDICT, detail: `the read did not finish within ${NEIGHBOUR_READ_TIMEOUT_MS / MS_PER_SECOND} s, `
      + "so whether the control plane answered is not known" };
  }
  if (error) return { verdict: LINK.UNASKED, detail: `ssh could not be started (${error.message})` };
  if (status === SSH_OWN_FAILURE) return { verdict: LINK.UNASKED, detail: "ssh exit 255, ssh's own connection failure" };
  if (status === null) {
    return { verdict: LINK.NO_VERDICT, detail: "ssh was killed before the read finished, so whether the control plane answered is not known" };
  }
  if (status !== 0) {
    return { verdict: LINK.NO_VERDICT, detail: `the control plane answered, but the read failed there (remote exit ${status})` };
  }
  return null;
}

/**
 * One ssh to the control plane for every address, or the answer every box gets when the read failed.
 *
 * @param {string[]} addresses
 * @param {{ run: typeof spawnSync, controlPlane: () => { host: string, key: string } }} deps
 * @returns {{ failed: LinkAnswer | null, polls: Map<string, string[]> }}
 */
function askControlPlane(addresses, { run, controlPlane }) {
  /** @type {{ host: string, key: string }} */
  let target;
  try {
    target = controlPlane();
  } catch (error) {
    const why = String(/** @type {Error} */ (error).message ?? error).split(" -- ")[0];
    return { failed: { verdict: LINK.UNASKED, detail: `this shell was never told where it is (${why})` }, polls: new Map() };
  }
  const result = run("ssh", ["-i", target.key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10", `root@${target.host}`, neighbourScript(addresses)],
  { encoding: "utf8", timeout: NEIGHBOUR_READ_TIMEOUT_MS });
  const failed = failedRead(result);
  return { failed, polls: failed ? new Map() : parseNeighbourPolls(String(result.stdout ?? "")) };
}

/**
 * @param {Map<string, string[]>} polls
 * @param {string} address
 * @returns {LinkAnswer}
 */
function answerFor(polls, address) {
  const lines = polls.get(address);
  return lines ? linkVerdictOf(lines)
    : { verdict: LINK.NO_VERDICT, detail: "the read returned nothing for this address" };
}

/**
 * Asks the control plane's neighbour table about the boxes that did not answer `/health`.
 *
 * FROM THE CONTROL PLANE, because it sits on the workers' segment and this shell may not: the operator Mac
 * could not resolve most of the fleet at layer 2. The ssh call is built from `control-plane-host.mjs` the
 * way `lab-pipeline.mjs` builds its own, since `fleet-playbook.mjs`'s helper is private to that file.
 *
 * NEVER THROWS, for the reason `probeWorker` does not: a report on which box is missing must not be taken
 * down by the question it asks about that box.
 *
 * @param {{ name: string, url: string }[]} rows
 * @param {{ run?: typeof spawnSync, controlPlane?: () => { host: string, key: string } }} [deps]
 * @returns {LinkAnswers} keyed by row name
 */
export function readLinkLayer(rows, { run = spawnSync, controlPlane = controlPlaneFromEnvironment } = {}) {
  /** @type {LinkAnswers} */
  const answers = new Map();
  /** @type {{ name: string, address: string }[]} */
  const askable = [];
  for (const { name, url } of rows) {
    const address = addressOf(url);
    if (IPV4.test(address)) askable.push({ name, address });
    else answers.set(name, { verdict: LINK.NO_VERDICT, detail: `named by hostname (${address}), which no neighbour table lists` });
  }
  if (!askable.length) return answers;
  const { failed, polls } = askControlPlane(askable.map(({ address }) => address), { run, controlPlane });
  for (const { name, address } of askable) answers.set(name, failed ?? answerFor(polls, address));
  return answers;
}

/** @param {string} name a row name, `<inventory name>  <address>` when the inventory supplied it */
function inventoryName(name) {
  return String(name).split(/\s+/)[0];
}

/**
 * The words, one line per box. The four never share a line: they are four different errands.
 *
 * @param {string} name
 * @param {LinkAnswer} link
 * @returns {string}
 */
export function linkLine(name, { verdict, detail }) {
  if (verdict === LINK.OFF) return `OFF THE NETWORK (no layer-2 answer from ${name}: check cable and power)`;
  if (verdict === LINK.ON) {
    return `ON THE NETWORK, worker not answering (${name} answers at layer 2: the machine is on the wire, `
      + "the worker on it is not serving)";
  }
  if (verdict === LINK.UNASKED) return `unknown (control plane unreachable) for ${name}: ${detail}`;
  return `unknown (no layer-2 verdict for ${name}: ${detail})`;
}

/** What a person can do about OFF, and what layer 2 cannot tell them -- #1298's "the message says so". */
const OFF_ADVICE = [
  "  Layer 2 cannot tell a powered-off box, an OS that is not up, and a running machine whose link is down",
  "  (#918: a loose cable, uptime 1303 min throughout). Try `npm run fleet:wake -- <name>` once; if it stays",
  "  OFF it is a walk to the machine. Report it to the chairman by inventory name before anything else is tried.",
];

/**
 * The link-layer lines, printed FIRST, and the gate a fleet write reads -- #1298 as amended.
 *
 * UNKNOWN GATES EXACTLY AS OFF DOES (`ceo`, 2026-09-13): a write proceeds only when every box that did not
 * answer reads a positive ON, and a HOLD names the OFF boxes and the UNKNOWN boxes in separate lists,
 * because one is a walk to a machine and the other is a better read.
 *
 * @param {{ name: string, link: LinkAnswer }[]} asked the boxes that did not answer, with their answers
 * @returns {{ lines: string[], gate: { hold: boolean, off: string[], unknown: string[] } | null }}
 */
export function linkLayerReport(asked) {
  if (!asked.length) return { lines: [], gate: null };
  const named = asked.map(({ name, link }) => ({ name: inventoryName(name), link }));
  const off = named.filter(({ link }) => link.verdict === LINK.OFF).map(({ name }) => name);
  const unknown = named.filter(({ link }) => link.verdict !== LINK.OFF && link.verdict !== LINK.ON)
    .map(({ name }) => name);
  const hold = off.length > 0 || unknown.length > 0;
  const gateLine = hold
    ? `fleet write: HOLD — off the network: ${off.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}`
    : "fleet write: may proceed — every box that did not answer is ON THE NETWORK, so it is the worker, not the wire";
  return {
    lines: [...named.map(({ name, link }) => linkLine(name, link)), ...(off.length ? OFF_ADVICE : []), gateLine],
    gate: { hold, off, unknown },
  };
}

/**
 * @param {WorkerRow[]} rows
 * @param {(rows: { name: string, url: string }[]) => LinkAnswers | Promise<LinkAnswers>} linkRead
 */
async function linkLayerFor(rows, linkRead) {
  const silent = rows.filter((row) => row.state === "unreachable");
  if (!silent.length) return linkLayerReport([]);
  const answers = await linkRead(silent);
  return linkLayerReport(silent.map((row) => ({
    name: row.name,
    link: answers.get(row.name) ?? { verdict: LINK.NO_VERDICT, detail: "the read returned nothing for this box" },
  })));
}

/**
 * What a reader sees first: the link-layer lines for any box that did not answer, THEN the table -- #1298's
 * "prints that FIRST". A function rather than two writes in `main`, so the order is asserted, not hoped.
 *
 * @param {{ rows: WorkerRow[], linkLayer: { lines: string[] } }} status
 * @returns {string[]}
 */
export function renderHead(status) {
  const table = renderTable(status.rows);
  if (!status.linkLayer.lines.length) return table;
  return [...status.linkLayer.lines.map((line) => `  ${line}`), "", ...table];
}

/**
 * @param {{ workers?: () => { name: string, url: string }[],
 *           probe?: (worker: { name: string, url: string }) => Promise<any>,
 *           linkRead?: (rows: { name: string, url: string }[]) => LinkAnswers | Promise<LinkAnswers> }} [deps]
 *   injectable ONLY so a
 *   test can drive THIS FUNCTION rather than the pure one below it. #1029's defect was never inside
 *   `consistencyVerdict` -- both halves were computed here and never crossed -- so a test that drives only
 *   the verdict holds the function and leaves the CALL unheld, which is where the 19.7 hours happened.
 *   Production passes nothing and the defaults are the real probes.
 */
export async function fleetStatus(deps) {
  const workers = (deps?.workers ?? fleetToProbe)();
  const probes = await Promise.all(workers.map(deps?.probe ?? probeWorker));
  const rows = summarise(probes);
  // #1298: only the boxes that did not answer are asked about at LAYER 2, so a healthy fleet pays nothing.
  const linkLayer = await linkLayerFor(rows, deps?.linkRead ?? readLinkLayer);
  const guests = probes
    .filter((p) => p.reachable)
    // `policy: undefined`, not null. `fleetConsistency` takes `policy?: Record<string, unknown>` -- an
    // OPTIONAL field, meaning "this probe did not collect one", which is exactly true here since
    // `/health` carries no policy block. `null` would be a claim that it collected an empty policy.
    .map((p) => ({ worker: p.url, environment: p.health?.environment, policy: undefined }));
  const { consistent, mismatches, compared } = fleetConsistency(guests);
  // WHICH CODE EACH BOX SERVES, COMPARED — the column has been printed since this file existed and
  // nothing ever read it. A fleet part-way through a deploy shows two hashes, and that is the ONLY
  // symptom it has: `consistent` above cannot see it, because `workerCode` is deliberately outside
  // `fleet-consistency`'s MUST_MATCH (that answers "is this evidence still valid", a different question).
  //
  // Measured 2026-09-05: a deploy was killed mid-`Reboot`, leaving some boxes on the new code and one
  // unreachable, and NOTHING said so. It surfaced when the next capture refused with `10 stale worker(s)`
  // — the safety net working, one step too late. A split is a fact about the fleet and this is the
  // command that describes the fleet.
  const codes = [...new Set(rows.map((r) => r.code).filter(Boolean))];
  // `comparedAgree`, not `consistent`: the field says agreement AMONG THE COMPARED SET, and a bare
  // `consistent: true` over nine of ten is the exact misreading #920 is about, one serialisation away.
  // `verdict` is the answer; this is one of its inputs.
  // `rows` carries each box's `stateOf`, which this verdict had no way to see until #1029. Passing it
  // is the whole fix: the two halves were both computed here and never crossed.
  const verdict = consistencyVerdict({ consistent, compared, total: workers.length, mismatches, rows });
  return { rows, linkLayer, comparedAgree: consistent, verdict, mismatches, codes, compared,
    reachable: guests.length, total: workers.length,
    // DEPRECATED, kept one release for scripts reading `fleet:status --json` from outside this repo.
    //
    // Removing it outright fails SILENTLY: `undefined` is falsy, so `if (status.consistent)` would read
    // every fleet as inconsistent and nothing would throw. So it stays -- but it does NOT alias
    // `comparedAgree`, which would keep the exact misreading #920 fixes. It carries the CORRECTED answer:
    // true only when every box in the inventory was compared and they agree. A legacy consumer gets the
    // fix without changing a line, which is the one thing a compatibility field should do.
    consistent: verdict.state === "CONSISTENT" };
}

async function main() {
  const status = await fleetStatus();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${renderHead(status).join("\n")}\n\n`);
    // "reachable" said more than it measured. This probes ONE channel — HTTP :8765 — and a worker can serve
    // it perfectly while being unmanageable: on 2026-08-23 all four reported reachable and CONSISTENT while
    // `ansible-playbook deploy.yml` answered UNREACHABLE on every one, because the tailnet ACL grants
    // tcp:8765 and not tcp:22. Nothing here was wrong; the word invited a conclusion it does not support,
    // and an afternoon went into diagnosing a fleet that was healthy.
    process.stdout.write(`  ${status.reachable}/${status.total} serving /health (the capture channel)\n`);
    if (status.reachable === status.total) {
      process.stdout.write("  This says nothing about whether you can DEPLOY to them — that is SSH, and it "
        + "is\n  a separate channel with separate access. `npm run worker:code` compares what they serve\n"
        + "  against this checkout.\n");
    }
    // THE VERDICT CARRIES ITS OWN DENOMINATOR (#920), so it prints whatever the count is — including 0
    // and 1, which the old `reachable >= 2` gate silenced. A verdict the reader never sees is not safer.
    process.stdout.write(`  ${status.verdict.line}\n`);
    if (status.verdict.state === "INCONSISTENT") {
      // NAME THE REMEDY, not just the state. A reader who has not read the runbook cannot get from
          // "browserVersion differs" to "re-provision the WHOLE fleet, never one box", and the difference
          // matters: `provisionRevision` is a capture CACHE KEY and a MUST_MATCH field, so a single box
          // provisioned alone gets a stamp its peers lack and splits the fleet further. That is why
      // `--serial=0` is right here and wrong almost everywhere else.
      process.stdout.write("  These guests are NOT interchangeable for capture, so a corpus run must not start: two\n"
          + "  workers on different values would share a cache key while producing different evidence.\n"
          + "  Re-provision the WHOLE fleet together — `npm run fleet:provision -- --serial=0`. Never one\n"
          + "  box alone: a lone re-provision splits the fleet rather than converging it.\n");
    }
    // SPLIT CODE IS A SEPARATE VERDICT FROM INCONSISTENT, and collapsing them would be wrong in both
    // directions. INCONSISTENT means the guests are not interchangeable for capture — a cache-key field
    // differs. This means a DEPLOY did not finish, which is a fixable operational state rather than an
    // evidence problem, and it has its own remedy.
    const degraded = degradedAdvice(status.rows);
    if (degraded) process.stdout.write(degraded);
    if (status.codes.length > 1) {
      const byCode = status.codes.map((c) =>
        `${c.slice(0, 12)} on ${status.rows.filter((r) => r.code === c).length}`);
      process.stdout.write(`  fleet SPLIT — ${status.codes.length} different code hashes: `
        + `${byCode.join(", ")}.\n`
        + "  A deploy did not finish. Nothing is broken and no evidence is invalid, but a capture will\n"
        + "  REFUSE until it is fixed. Re-run `npm run fleet:deploy` — it is idempotent.\n");
    }
  }
  // Exit 1 when nothing answered. Every worker being down is a fault; ONE being down is not, because a
  // run evicts a dead worker and carries on — the same rule doctor applies.
  process.exit(status.reachable === 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
