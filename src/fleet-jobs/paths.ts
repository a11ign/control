/**
 * WHERE THE FLEET JOB SERVICE LIVES ON THE CONTROL PLANE (A11-243, ADR `A11-243-adr-0001`).
 *
 * One literal each, because a static unit file and a playbook can say them only as literals, and `fleet-jobs-unit.test.ts` holds the unit and the
 * playbook equal to these. The store is a systemd `StateDirectory`, outside every checkout, so a re-clone or `reset-checkout.yml` cannot take it. The
 * service runs from its OWN checkout, moved only by `fleet-jobs-install.yml`, so `/root/control`'s follow-`main` step cannot move the tree under a
 * long-lived process.
 */
export const STORE_DIR = "/var/lib/a11y-fleet-jobs";
export const SERVICE_CHECKOUT = "/root/fleet-jobs";
export const SERVICE_UNIT = "a11y-fleet-jobs.service";
export const CONTROL_TSX_LOADER = "/opt/a11y-tsx/node_modules/tsx/dist/esm/index.mjs";
/** The store's directory for tests and for a service started somewhere else; the unit does not set it. */
export const STORE_DIR_ENV = "A11Y_FLEET_JOBS_DIR";

export const storeDirFromEnv = (env: NodeJS.ProcessEnv = process.env): string => env[STORE_DIR_ENV] || STORE_DIR;
