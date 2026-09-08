// @ts-check
/**
 * WHAT THE CONTROL PLANE'S CHECKOUT DIRECTORY IS CALLED. ONE FACT, ONE PLACE.
 *
 * It was two literals in two shapes, and a rename restored one of them.
 *
 *     packages/control/src/fleet-playbook.mjs:105   const CHECKOUT = "a11ign"
 *     packages/control/src/lab-pipeline.mjs:432     const CONTROL_CHECKOUT = "/root/a11y-witness"
 *
 * `e435ac17` (the product rename) moved both. #531 restored the second and missed the first, so on
 * 2026-09-08 **every fleet play was unreachable** — `deploy`, `provision`, `recover`, `wake`,
 * `inventory-install`, `control-host-install` all route through `fleet-playbook.mjs`, whose `cd
 * ${CHECKOUT}` was entering a directory that does not exist.
 *
 * ## Why FOUR sweeps by three sessions missed it
 *
 * Each sweep grepped for a VALUE. `dispatcher`'s was `/root/a11ign`; `ceo`'s was scoped to `packages/`;
 * mine was the SSH-key filename and then the absolute path. **A grep for a value cannot match the same
 * value in a different shape** — bare, absolute, or embedded in a `cd`. The outage was found by a play
 * failing, which is the most expensive way to find anything.
 *
 * So this module exists, and `control-plane-checkout-is-one-fact.test.ts` keys on the OPERATION rather
 * than the name: every `cd <x>` and `--working-directory=<x>` in tracked source is discovered and must
 * either interpolate one of these exports or be classified with a reason. The name can take any shape it
 * likes; entering the directory cannot.
 *
 * ## Two shapes, one fact, and which one is the fact
 *
 * **The DIRECTORY NAME is the fact; the absolute path is derived from it.** The two consumers genuinely
 * need different shapes and both are correct:
 *
 *   - `fleet-playbook.mjs` ssh's as root (`ssh()` builds `root@${CONTROL_PLANE}`) and its wrapper lands
 *     in `/root` before running anything, so a bare `cd a11y-witness` is right there.
 *   - `lab-pipeline.mjs` builds a `systemd-run --working-directory=`, which takes an absolute path.
 *
 * Keeping each consumer's existing shape is deliberate: making them agree by changing one of them would
 * be a behaviour change riding along with an outage fix, and this file's whole job is that the NAME
 * cannot drift, not that the two call sites look alike.
 *
 * ## What this is NOT
 *
 * Not the npm org (`scripts/npm-token-liveness.mjs`'s `ORG`), not the published package name
 * (`packages/cli/package.json`), not `/etc/a11ign/` — a config directory this repo CREATES and
 * deliberately names after the product — and not the WINDOWS worker checkout
 * (`C:\Users\witness\...`), which is a different machine's directory and is held on #526 until somebody
 * runs `win_stat` against it. Restoring a name on sight is the act #515 was filed against.
 */

/**
 * The directory the control plane's checkout lives in, under the ssh user's home (`/root`).
 *
 * THE VALUE IS A FACT ABOUT A MACHINE, not about this repository, so it does not follow a rename of the
 * product. Changing it here asserts that the directory on the control plane has actually been renamed —
 * which is a thing somebody does with `mv`, not with a sweep.
 */
export const CONTROL_PLANE_CHECKOUT = "a11y-witness";

/** The same fact as an absolute path, for a caller that cannot use a relative one. */
export const CONTROL_PLANE_CHECKOUT_PATH = `/root/${CONTROL_PLANE_CHECKOUT}`;
