import { join } from "node:path";

/**
 * WHERE THE LEDGER LIVES ON THE CONTROL PLANE: a systemd `StateDirectory` of `a11y-fleet-jobs.service`, outside every checkout, as the job store is, so
 * `reset-checkout.yml` or a re-clone cannot take it. It is written from two checkouts (`/root/fleet-jobs` and `/root/control`), which is why it carries a version.
 */
export const LEDGER_DIR = "/var/lib/a11y-fleet-leases";
export const LEDGER_DIR_ENV = "A11Y_FLEET_LEASES_DIR";

export const ledgerDirFromEnv = (env: NodeJS.ProcessEnv = process.env): string => env[LEDGER_DIR_ENV] || LEDGER_DIR;
export const ledgerPathIn = (dir: string): string => join(dir, "ledger.json");
