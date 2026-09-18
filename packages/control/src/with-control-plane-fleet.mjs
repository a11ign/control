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
// A control-plane refusal does not block these two: both are DIAGNOSTICS (`doctor` says what this
// machine has; `worker:code` compares a fleet against this checkout), and a diagnostic that cannot run
// without the one thing it might be diagnosing the absence of is the wrong shape. So a refusal prints a
// warning and falls through to the child's own existing default (a local inventory.yml, or empty) --
// exactly today's behaviour, never a new hard failure.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readControlPlaneFleet } from "./control-plane-fleet.mjs";

/**
 * @param {string} bin the worker-fleet script to run, relative to the repo root
 * @param {string[]} argv forwarded to the child verbatim
 * @param {{ readFleet?: () => { workers: { name: string, url: string }[], refusal: string | null },
 *           run?: typeof spawnSync, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {{ status: number | null, env: NodeJS.ProcessEnv }}
 */
export function withControlPlaneFleet(bin, argv, { readFleet = readControlPlaneFleet, run = spawnSync, env = process.env } = {}) {
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
      childEnv.A11Y_WORKERS = fleet.workers.map((w) => w.url).join(",");
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
  const { status } = withControlPlaneFleet(bin, argv);
  process.exit(status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
