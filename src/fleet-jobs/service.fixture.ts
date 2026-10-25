/**
 * THE SERVICE OVER FAKE WORKERS, as a process a test can kill (A11-243). The real `service.ts` with the one thing that cannot run off the control
 * plane swapped: the inventory. `FAKE_FLEET` is a JSON list of `{ name, url }`; the store is `A11Y_FLEET_JOBS_DIR` and the lease ledger `A11Y_FLEET_LEASES_DIR`. The capture client is the real one.
 */
import { captureTolerantly } from "@a11ign/screenreader-fleet/capture-client";
import { requestJson } from "@a11ign/screenreader-fleet/worker-http";
import { LeaseLedger } from "../fleet-leases/ledger.ts";
import { ledgerDirFromEnv, ledgerPathIn } from "../fleet-leases/paths.ts";
import { ledgerClaims } from "./claims.ts";
import { staticResolver } from "./fake-fleet.ts";
import { exitOnSignals, startService } from "./service.ts";
import type { Box } from "./types.ts";

const fleet = JSON.parse(process.env.FAKE_FLEET ?? "[]") as Box[];

exitOnSignals(await startService({
  tickMs: 200, heartbeatMs: 500, commit: "fixture",
  deps: (store, log) => ({
    store, log, claims: ledgerClaims(new LeaseLedger(ledgerPathIn(ledgerDirFromEnv()), { log })), boxes: staticResolver(fleet),
    capture: (box, body) => captureTolerantly({ worker: box.url, body }),
    health: async (box) => (await requestJson(`${box.url}/health`)).json,
    pins: () => ({ pins: { fixture: true } }),
    busyPollMs: 200,
  }),
}));
