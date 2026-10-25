/**
 * A RUNNER OVER A REAL STORE AND A REAL LEASE LEDGER, both in temp directories, with the capture and the health read handed in (A11-243, A11-244). Test
 * support only; the service never imports it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { LeaseLedger } from "../fleet-leases/ledger.ts";
import { ledgerClaims } from "./claims.ts";
import { staticResolver } from "./fake-fleet.ts";
import { Runner } from "./runner.ts";
import type { CaptureResult, RunnerDeps } from "./runner.ts";
import { JobStore, newJobId } from "./store.ts";
import { STORE_VERSION } from "./types.ts";
import type { Box, BoxRequest, JobRequest, JobStateFile } from "./types.ts";

export const BOXES: Box[] = ["w2", "w3", "w4"].map((name) => ({ name, url: `http://127.0.0.1:1/${name}` }));
export const PAGES = ["https://x.test/a", "https://x.test/b", "https://x.test/c", "https://x.test/d"];
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export function harness(over: Partial<RunnerDeps> = {}, { ledger: shared }: { ledger?: LeaseLedger } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fleet-jobs-"));
  const store = new JobStore(dir);
  const ledgerDir = mkdtempSync(join(tmpdir(), "fleet-leases-"));
  const ledger = shared ?? new LeaseLedger(join(ledgerDir, "ledger.json"), { now: over.now });
  const log: string[] = [];
  const asked: { box: string; page: string }[] = [];
  const holding = new Map<string, number>();
  const peak = new Map<string, number>();
  const capture = async (box: Box, body: Record<string, unknown>): Promise<CaptureResult> => {
    holding.set(box.name, (holding.get(box.name) ?? 0) + 1);
    peak.set(box.name, Math.max(peak.get(box.name) ?? 0, holding.get(box.name)!));
    asked.push({ box: box.name, page: body.url as string });
    await tick();
    holding.set(box.name, holding.get(box.name)! - 1);
    return { status: 200, json: { transcript: [body.url] } };
  };
  const deps: RunnerDeps = {
    store, claims: ledgerClaims(ledger), boxes: staticResolver(BOXES), capture, health: async () => ({ busy: false, code: "c", environment: {}, policy: {} }),
    pins: () => ({ pins: {} }), log: (line) => log.push(line), retryQueuedMs: 0, busyPollMs: 1, busyWaitMs: 5, ...over };
  const runner = new Runner(deps);
  let submitted = 0;
  const submit = (boxes: BoxRequest = { kind: "count", count: 2 }, over: Partial<JobRequest> = {}): string => {
    // one second apart in the ID's own clock, so the jobs sort in the order they were submitted
    const id = newJobId(new Date(Date.UTC(2026, 9, 25, 9, 0, submitted)), () => (submitted++).toString(16).padStart(3, "0"));
    const request: JobRequest = { version: STORE_VERSION, id, label: "A11-243", pages: PAGES, boxes, passes: 1, body: { steps: 600 }, freeze: null, submittedBy: "t@h",
      submittedAt: new Date(Date.UTC(2026, 9, 25, 9, 0, submitted)).toISOString(), ...over };
    store.writeRequest(request);
    return request.id;
  };
  const state = (id: string): JobStateFile => {
    const read = store.readState(id);
    assert.ok(read?.ok, `no readable state for ${id}`);
    return (read as { ok: true; value: JobStateFile }).value;
  };
  const drain = async (runner_: Runner = runner) => { await runner_.tick(); await runner_.settled(); };
  return { dir, store, ledger, runner, deps, log, asked, peak, submit, state, drain, done: () => { rmSync(dir, { recursive: true, force: true }); rmSync(ledgerDir, { recursive: true, force: true }); } };
}

