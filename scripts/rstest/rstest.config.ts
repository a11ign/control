// @ts-check

/**
 * control's own test config: a THIN CALL into `@a11ign/toolchain` (ADR 0043, Decision 3), the one rstest config every a11ign repository shares. It carries the
 * `node:test` resolve hook and shim, `forks` isolated, the worker cap locally, the run record and the verdict line; what is control's is only where the repository is
 * and which files are tests.
 *
 * `include` IS THIS REPOSITORY'S OWN TESTS ONLY: the four files in `scripts/` that pin its workflows. `packages/control`'s tests run in `ci.yml` from the core's own
 * config over a checkout of a11ign/a11ign (the package reaches siblings that are not in this repository), and moving them is not this file's business.
 * `root` is this file's repository root, not the working directory, so the run is the same from any directory.
 */
import { fileURLToPath } from "node:url";
import { defineToolchainConfig } from "@a11ign/toolchain/rstest-config";

export default defineToolchainConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  include: ["scripts/**/*.test.ts"],
});
