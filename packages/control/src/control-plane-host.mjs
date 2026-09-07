import { readFileSync } from "node:fs";

// THE CONTROL PLANE'S ADDRESS AND KEY HAVE NO DEFAULT, DELIBERATELY -- and both used to, which is #83/#85.
//
// `packages/control/README.md`'s "Reaching the control plane itself" section is explicit: `A11Y_CONTROL_HOST`
// and `A11Y_PVE_KEY` are "deliberately undocumented as specific values anywhere public ... and they do not
// belong in git." `fleet-playbook.mjs` and `lab-pipeline.mjs` both violated that for BOTH values, one file
// away from where it is written down: each hardcoded a real, specific LAN address as
// `process.env.A11Y_CONTROL_HOST || "..."` (#83) and a real, specific key filename as
// `process.env.A11Y_PVE_KEY || \`${HOME}/.ssh/...\`` (#85) -- so an operator who never set either variable
// ran real commands against a real machine, with a real key path, both sitting in public git history the
// whole time.
//
// THIS CORRECTS #83'S OWN COMMENT, WHICH CLAIMED THE OPPOSITE OF #85'S FINDING. It said "`A11Y_PVE_KEY`
// already had no such fallback -- only the host address did" -- checked again while building #85, and that
// is false: `CONTROL_KEY` had the identical shape, missed because #83's own investigation stopped at the
// address. The record now says what is actually true, rather than repeating the first pass's blind spot.
//
// REFUSED, NEVER GUESSED, matching this repo's own convention elsewhere (`hostPagesBase`, the inventory
// lookups in `fleet-env.mjs`): a required value with no honest default fails loudly naming the fix, rather
// than silently doing something that happens to work on one machine and nowhere else.
//
// Called from inside `main()`, never at module load: `onTheControlPlane()` takes the host as an explicit
// parameter in its own tests, and `fleet-playbook.mjs`'s CLI-flag validation already runs at import time --
// stacking a second, unconditional throw there would make importing this module for its pure helpers (as
// the tests do) depend on an environment variable those tests have no reason to set.
//
// ## The third state between "committed to git" and "typed into every shell" -- #285
//
// `requireControlPlaneHost` now checks a second source before refusing: `A11Y_CONTROL_HOST_FILE`
// (default `/etc/a11ign/control-host`), installed by `npm run fleet:control-host-install` the same way
// `fleet:inventory-install` already installs `inventory.yml` there. **This is not the guess #83 removed.**
// A guessed default is a value NOBODY chose, baked into source, applied on every machine including ones
// it was never meant for -- which is exactly how a real LAN address ended up in public git history. A
// file at this path is a value a HUMAN supplied deliberately, written on the machine it describes, and it
// never enters git (`/etc/a11ign` is outside every checkout). Reading it is reading a decision someone
// already made about THIS machine, not inventing one. Precedence is env var, then file, then refuse: the
// env var lets an operator override on the spot, and the refusal still fires when neither exists, which
// is the property #83 bought and this does not weaken.
//
// ## Why `A11Y_SSH_KEY` (the WORKER fleet's key, `doctor.mjs`, `group_vars/a11y_workers.yml`) is NOT here
//
// It is a genuinely different case, checked rather than assumed while scoping #85: `README.md`'s "does not
// belong in git" policy names only `A11Y_CONTROL_HOST` and `A11Y_PVE_KEY` -- the CONTROL PLANE's own
// credentials. `A11Y_SSH_KEY` / `a11ign_ed25519` is the fleet's own key-naming CONVENTION, which this
// project treats as public by design: `serve-bootstrap.sh` and `ssh-key.yml` exist specifically to
// ESTABLISH that convention on a new box, and `doctor.mjs`'s use of the same path is a diagnostic SCAN for
// whether the convention was followed, not an operation that depends on the value being correct. Forcing
// either to refuse without an env var would break `npm run doctor` running unconfigured, which is its whole
// point. Filed as the open half of #85 rather than guessed at here.

const CONTROL_HOST_FILE_ENV = "A11Y_CONTROL_HOST_FILE";
const DEFAULT_CONTROL_HOST_FILE = "/etc/a11ign/control-host";

/**
 * The durable, operator-installed copy of the control plane's address, or `null` -- never a raw ENOENT
 * or an empty string standing in for "not there". Absent on a machine that has never run
 * `fleet:control-host-install`, which is a normal, common state, not a fault.
 *
 * @param {string} [path]
 * @returns {string | null}
 */
export function readControlHostFile(path = process.env[CONTROL_HOST_FILE_ENV] || DEFAULT_CONTROL_HOST_FILE) {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * The control plane's address, or a loud refusal naming the fix. Checks `A11Y_CONTROL_HOST` first, then
 * the file `readControlHostFile` reads -- see this file's header, "The third state", for why that second
 * source is not the guess #83 removed.
 *
 * @returns {string}
 */
export function requireControlPlaneHost() {
  const host = process.env.A11Y_CONTROL_HOST || readControlHostFile();
  if (!host) {
    throw new Error("A11Y_CONTROL_HOST is required and has no default -- see packages/control/README.md's "
      + "\"Reaching the control plane itself\". Set it to your control plane's address, or install it once "
      + "with `npm run fleet:control-host-install` (writes /etc/a11ign/control-host on the control plane); "
      + "neither is committed to this repository, the same as A11Y_PVE_KEY.");
  }
  return host;
}

/**
 * The SSH private key that reaches the control plane itself (`A11Y_PVE_KEY`), or a loud refusal naming
 * the fix. NOT the fleet's own key (`A11Y_SSH_KEY`) -- see this file's header for why that one is a
 * different, deliberately-public convention rather than a secret.
 *
 * @returns {string}
 */
export function requireControlPlaneKey() {
  const key = process.env.A11Y_PVE_KEY;
  if (!key) {
    throw new Error("A11Y_PVE_KEY is required and has no default -- see packages/control/README.md's "
      + "\"Reaching the control plane itself\". Set it to the path of the key that reaches your control "
      + "plane; it is deliberately not committed to this repository, the same as A11Y_CONTROL_HOST.");
  }
  return key;
}
