/**
 * THE FLEET JOB SERVICE: the long-lived process `a11y-fleet-jobs.service` runs on the control plane (A11-243).
 *
 *     node --import <tsx> src/fleet-jobs/service.ts
 *
 * It owns the job store, runs each job's captures against the fleet over the workers' own HTTP `/capture` (`captureTolerantly`, the one capture
 * client), and writes a heartbeat the CLI reads to know the service is there. It changes nothing on any box: the one play it runs, `ansible/facts.yml`
 * (A11-283, ADR 0005), only reads. On SIGTERM it stops dispatching,
 * lets the captures in flight end and be recorded, and exits; on start it resumes every job it finds running.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { captureTolerantly } from "@a11ign/screenreader-fleet/capture-client";
import { requestJson } from "@a11ign/screenreader-fleet/worker-http";
import { readDeployPins } from "../layer-pins.ts";
import { readFleetPins } from "../fleet-pins.ts";
import { sandboxGitEnv } from "../git-safe-env.ts";
import { inventoryResolver } from "./boxes.ts";
import { ledgerClaims } from "./claims.ts";
import { driftReader } from "./drift.ts";
import { factsReader } from "../fleet-facts/read.ts";
import { LeaseLedger } from "../fleet-leases/ledger.ts";
import { ledgerDirFromEnv, ledgerPathIn } from "../fleet-leases/paths.ts";
import { storeDirFromEnv } from "./paths.ts";
import { Runner } from "./runner.ts";
import type { RunnerDeps } from "./runner.ts";
import { JobStore, writeJsonAtomic } from "./store.ts";
import type { PinsReading } from "./manifest.ts";
import type { ServiceBeat } from "./view.ts";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

export const TICK_MS = 2_000;
export const HEARTBEAT_MS = 5_000;

export function commitOfCheckout(root: string = REPO_ROOT): string {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: sandboxGitEnv() }).trim(); } catch { return "unknown"; }
}

/** The pinned versions the manifest states; a pin that cannot be read is said, not defaulted. */
export function readPins(): PinsReading {
  try {
    const layers = readDeployPins();
    return { pins: {
      worker: layers.layers["nvda-worker"]?.version ?? null,
      fleet: layers.layers["screenreader-fleet"]?.version ?? null,
      core: layers.core?.commit ?? null,
      fleetVersions: readFleetPins(),
    } };
  } catch (error) { return { unreadable: (error as Error).message }; }
}

/** The real dependencies: the lease ledger, the drift record, the control plane's inventory, the pinned capture client, and each worker's `/health`. */
export function realDeps(store: JobStore, log: (line: string) => void): RunnerDeps {
  return {
    store, log,
    claims: ledgerClaims(new LeaseLedger(ledgerPathIn(ledgerDirFromEnv()), { log })),
    drift: driftReader(),
    boxes: inventoryResolver({ log }),
    capture: (box, body) => captureTolerantly({ worker: box.url, body }),
    health: async (box) => (await requestJson(`${box.url}/health`, { timeoutMs: 12_000 })).json ?? null,
    pins: readPins,
    readFacts: factsReader({ log }),
  };
}

export type RunningService = { stop(): Promise<void>; runner: Runner };

/** Start the loop: resume what a restart left, scan every `tickMs`, beat every `heartbeatMs`. The returned `stop` drains and ends both. */
export async function startService({ storeDir = storeDirFromEnv(), deps, tickMs = TICK_MS, heartbeatMs = HEARTBEAT_MS, commit = commitOfCheckout(), log = (line: string) => console.log(line) }: {
  storeDir?: string; deps?: (store: JobStore, log: (line: string) => void) => RunnerDeps; tickMs?: number; heartbeatMs?: number; commit?: string; log?: (line: string) => void;
} = {}): Promise<RunningService> {
  mkdirSync(storeDir, { recursive: true });
  const store = new JobStore(storeDir);
  const runner = new Runner((deps ?? realDeps)(store, log));
  const startedAt = new Date().toISOString();
  const beat = (): void => {
    const heartbeat: ServiceBeat = { pid: process.pid, commit, startedAt, heartbeatAt: new Date().toISOString() };
    try { writeJsonAtomic(store.servicePath(), heartbeat); } catch (error) { log(`heartbeat not written: ${(error as Error).message}`); }
  };
  beat();
  const beating = setInterval(beat, heartbeatMs);
  const scanning = setInterval(() => { void runner.tick(); }, tickMs);
  await runner.tick();
  log(`a11y-fleet-jobs started at ${commit.slice(0, 10)}, store ${storeDir}`);
  return {
    runner,
    async stop() {
      clearInterval(scanning);
      await runner.stop();
      clearInterval(beating);
    },
  };
}

/** SIGTERM (the unit's stop) and SIGINT: stop dispatching, let the captures in flight end and be recorded, exit 0. */
export function exitOnSignals(service: RunningService): void {
  const shutdown = (signal: string) => {
    console.log(`${signal}: stopping, waiting for the captures in flight`);
    void service.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  exitOnSignals(await startService());
}
