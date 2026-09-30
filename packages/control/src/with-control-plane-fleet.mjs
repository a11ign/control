#!/usr/bin/env node
// @ts-check
// command: run an unchanged, PUBLISHED worker-fleet bin (doctor, worker:code) with A11Y_WORKERS set from
// the control plane's own inventory -- never a checkout's inventory.yml, and never a code change to the
// bin itself.
//
// ceo's ruling on #1356 (2026-09-18), choosing this over duplicating a control-plane reader INTO
// `@a11ign/worker-fleet`: that package is PUBLISHED, with real external consumers, and is exactly the
// supply-chain surface ADR 0012 keeps the control-plane SSH key away from -- "the credential able to
// reconfigure the entire fleet would sit next to the largest supply-chain surface in the system." Code
// that KNOWS HOW TO REACH THE CONTROL PLANE sitting in a published tarball is the coupling the ADR calls
// decisive, regardless of whether that copy happens to run without a key today.
//
// This wrapper achieves the identical operational outcome with zero risk to that boundary:
// `resolveWorkerPool`'s own precedence (`packages/worker-fleet/src/fleet-env.mjs`) already puts
// `A11Y_WORKER(S)` first, before it ever touches a local inventory.yml -- so supplying that one
// environment variable is enough. Nothing about ssh, `A11Y_PVE_KEY`, or the control plane ever enters
// `@a11ign/worker-fleet`'s source or its published surface; `doctor.mjs`/`check-worker-code.mjs` run
// exactly as they ship, unaware anything upstream of them changed. An operator's own explicit
// `A11Y_WORKER(S)` is never overridden -- naming workers means you are managing them.
//
// #2790: THE ADDRESSES ARE RESOLVED WHERE THEY ARE USED. Pinned addresses come from DHCP and drift (workers 3
// and 6 each moved within hours on 2026-09-28), so a worker that does not answer `/health` at its pin is looked
// up by its declared `mac` (`resolveMovedByMacLive`, #2752), the move is reported on stderr, and one that cannot
// be found is named and left out -- it never holds the run. A run with no worker left refuses (exit 1).
//
// A control-plane refusal does not block these two: both are DIAGNOSTICS (`doctor` says what this
// machine has; `worker:code` compares a fleet against this checkout), and a diagnostic that cannot run
// without the one thing it might be diagnosing the absence of is the wrong shape. So a refusal prints a
// warning and falls through to the child's own existing default (a local inventory.yml, or empty) --
// exactly today's behaviour, never a new hard failure.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readControlPlaneFleet } from "./control-plane-fleet.mjs";
import { resolveMovedByMacLive, subnetOf } from "./fleet-status.mjs";
import { requestJson } from "../../worker-fleet/src/worker-http.mjs";

const HEALTH_TIMEOUT_MS = 5_000;
const NO_WORKER_LEFT_STATUS = 1;

/** @typedef {{ name: string, url: string, mac?: string }} PoolWorker */
/** @typedef {{ name: string, from: string, to: string }} MovedWorker */
/** @typedef {{ name: string, url: string, why: string }} MissingWorker */

/** @param {string} url the worker's own `/health` base, e.g. `http://192.0.2.2:8765` */
async function answersHealth(url) {
  try {
    return (await requestJson(`${url}/health`, { timeoutMs: HEALTH_TIMEOUT_MS })).ok;
  } catch {
    return false;
  }
}

/** @param {string} url @param {string} address the same URL, aimed at another host */
function withHost(url, address) {
  return url.replace(new URL(url).hostname, address);
}

/**
 * #2790: WHERE A MOVED WORKER IS NOW, and only when two independent reads agree and the worker itself answers.
 *
 * A neighbour entry is a cache, and DHCP hands an address on: one read of it can aim a run at whichever
 * machine holds that address next (the worker has no authentication, SECURITY.md). So the MAC read is made
 * TWICE and must name the same address both times, and then that address must answer `/health` before it is
 * used -- `/health` carries no identity, so the repeated read is the identity check and `/health` proves only
 * that something serving a worker is there.
 *
 * @param {PoolWorker[]} silent workers that did not answer at their pin
 * @param {{ macRead: typeof resolveMovedByMacLive, probe: (url: string) => Promise<boolean> }} deps
 * @returns {Promise<{ found: Map<string, string>, why: Map<string, string> }>} name -> verified url, name -> reason
 */
async function locateByMac(silent, { macRead, probe }) {
  /** @type {Map<string, string>} */
  const found = new Map();
  /** @type {Map<string, string>} */
  const why = new Map();
  const candidates = [];
  for (const { name, url, mac } of silent) {
    const host = new URL(url).hostname;
    if (!mac) why.set(name, "no answer at its pin and the inventory declares no mac to look it up by");
    else if (!subnetOf(host)) why.set(name, `no answer at its pin, and ${host} is not an IPv4 address to search around`);
    else candidates.push({ name, host, mac });
  }
  const first = candidates.length ? await macRead(candidates) : new Map();
  const second = first.size ? await macRead(candidates.filter((c) => first.has(c.name))) : new Map();
  for (const { name } of candidates) {
    const address = first.get(name);
    if (!address) why.set(name, "no answer at its pin, and its mac is not on the network segment");
    else if (second.get(name) !== address) why.set(name, `its mac read as ${address} once and not again, so no address is trusted`);
  }
  for (const { name, url } of silent) {
    const address = first.get(name);
    if (!address || second.get(name) !== address) continue;
    const candidate = withHost(url, address);
    if (await probe(candidate)) found.set(name, candidate);
    else why.set(name, `its mac reads at ${address} twice, but nothing answers /health there`);
  }
  return { found, why };
}

/**
 * THE POOL A RUN IS GIVEN, built from addresses resolved AT USE TIME (#2790, the chairman's "work around
 * it for now"): a worker that answers at its pin is used as pinned and asked nothing more, so a healthy
 * fleet pays one `/health` each; one that does not is looked up by MAC; one that cannot be found is left
 * out and NAMED, never allowed to hold the run. The inventory is read, never rewritten.
 *
 * @param {PoolWorker[]} workers the control plane's inventory, pinned addresses
 * @param {{ probe?: (url: string) => Promise<boolean>, macRead?: typeof resolveMovedByMacLive }} [deps]
 * @returns {Promise<{ pool: string[], moved: MovedWorker[], missing: MissingWorker[] }>}
 */
export async function resolvePoolAtUseTime(workers, { probe = answersHealth, macRead = resolveMovedByMacLive } = {}) {
  const answered = await Promise.all(workers.map(({ url }) => probe(url)));
  const silent = workers.filter((_, index) => !answered[index]);
  const { found, why } = silent.length ? await locateByMac(silent, { macRead, probe }) : { found: new Map(), why: new Map() };
  return {
    pool: workers.flatMap(({ name, url }, index) => (answered[index] ? [url] : found.has(name) ? [found.get(name)] : [])),
    moved: silent.filter(({ name }) => found.has(name)).map(({ name, url }) => ({ name, from: url, to: found.get(name) })),
    missing: silent.filter(({ name }) => !found.has(name)).map(({ name, url }) => ({ name, url, why: why.get(name) ?? "unresolved" })),
  };
}

/** @param {{ moved: MovedWorker[], missing: MissingWorker[] }} resolved @returns {string[]} */
function reportLines({ moved, missing }) {
  return [
    ...moved.map(({ name, from, to }) => `with-control-plane-fleet: MOVED ${name}: pinned ${from}, answers by MAC at ${to} `
      + "-- using that address for this run; inventory.yml is not rewritten (fix it, and ask for a DHCP reservation, #2752)"),
    ...missing.map(({ name, url, why }) => `with-control-plane-fleet: MISSING ${name} (${url}): ${why} -- left out of this run`),
  ];
}

/**
 * @param {string} bin the worker-fleet script to run, relative to the repo root
 * @param {string[]} argv forwarded to the child verbatim
 * @param {{ readFleet?: () => { workers: PoolWorker[], refusal: string | null },
 *           run?: typeof spawnSync, env?: NodeJS.ProcessEnv,
 *           resolvePool?: typeof resolvePoolAtUseTime }} [deps]
 * @returns {Promise<{ status: number | null, env: NodeJS.ProcessEnv }>}
 */
export async function withControlPlaneFleet(bin, argv, {
  readFleet = readControlPlaneFleet, run = spawnSync, env = process.env, resolvePool = resolvePoolAtUseTime,
} = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...env };
  // Already named means managing them explicitly, which beats a fleet this wrapper would go fetch
  // instead -- so the control plane is not even asked.
  if (!childEnv.A11Y_WORKER && !childEnv.A11Y_WORKERS) {
    const fleet = readFleet();
    if (fleet.refusal) {
      process.stderr.write(`with-control-plane-fleet: could not ask the control plane for its inventory `
        + `(${fleet.refusal}) -- running ${bin} with whatever it resolves on its own.\n`);
    } else {
      const resolved = await resolvePool(fleet.workers);
      for (const line of reportLines(resolved)) process.stderr.write(`${line}\n`);
      if (!resolved.pool.length) {
        process.stderr.write(`with-control-plane-fleet: no worker is left to run ${bin} against -- refusing.\n`);
        return { status: NO_WORKER_LEFT_STATUS, env: childEnv };
      }
      childEnv.A11Y_WORKERS = resolved.pool.join(",");
    }
  }
  const result = run(process.execPath, [bin, ...argv], { stdio: "inherit", env: childEnv });
  return { status: result.status, env: childEnv };
}

async function main() {
  const [bin, ...argv] = process.argv.slice(2);
  if (!bin) {
    process.stderr.write("usage: node packages/control/src/with-control-plane-fleet.mjs <bin> [args...]\n");
    process.exit(2);
  }
  const { status } = await withControlPlaneFleet(bin, argv);
  process.exit(status ?? 1);
}

// REALPATH'D: `import.meta.url` is resolved through symlinks by Node's ESM loader and `process.argv[1]`
// is not -- reaching this file through npm's `.bin` symlink or similar would otherwise silently skip
// `main()` and exit 0, with no error and no output (`#1086`'s own ratchet, matching every other CLI entry
// in this repo, e.g. `doctor.mjs`, `check-worker-code.mjs`).
if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
