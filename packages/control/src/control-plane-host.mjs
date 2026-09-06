// THE CONTROL PLANE'S ADDRESS HAS NO DEFAULT, DELIBERATELY -- and it used to, which is #83.
//
// `packages/control/README.md`'s "Reaching the control plane itself" section is explicit: `A11Y_CONTROL_HOST`
// and `A11Y_PVE_KEY` are "deliberately undocumented as specific values anywhere public ... and they do not
// belong in git." `fleet-playbook.mjs` and `lab-pipeline.mjs` both violated that, one file away from where
// it is written down: each hardcoded a real, specific LAN address as `process.env.A11Y_CONTROL_HOST || "..."`,
// so an operator who never set the variable ran real commands against a real machine whose address was
// sitting in a public git history the whole time. `A11Y_PVE_KEY` already had no such fallback -- only the
// host address did, which is the asymmetry #83 was filed against.
//
// REFUSED, NEVER GUESSED, matching this repo's own convention elsewhere (`hostPagesBase`, the inventory
// lookups in `fleet-env.mjs`): a required value with no honest default fails loudly naming the fix, rather
// than silently doing something that happens to work on one machine and nowhere else.
//
// Called from inside `main()`, never at module load: `onTheControlPlane()` takes the host as an explicit
// parameter in its own tests, and `fleet-playbook.mjs`'s CLI-flag validation already runs at import time --
// stacking a second, unconditional throw there would make importing this module for its pure helpers (as
// the tests do) depend on an environment variable those tests have no reason to set.

/**
 * The control plane's address, or a loud refusal naming the fix.
 *
 * @returns {string}
 */
export function requireControlPlaneHost() {
  const host = process.env.A11Y_CONTROL_HOST;
  if (!host) {
    throw new Error("A11Y_CONTROL_HOST is required and has no default -- see packages/control/README.md's "
      + "\"Reaching the control plane itself\". Set it to your control plane's address; it is deliberately "
      + "not committed to this repository, the same as A11Y_PVE_KEY.");
  }
  return host;
}
