// @ts-check
/**
 * DOES THIS HOST HOLD THE LAB'S CODE? Asked before a lab job plays a lab script (#3833, follow-up of #3505).
 *
 * `packages/lab` is not tracked here and not cloned by a guest: `pnpm install`'s `prepare` runs `scripts/lay-layer.mjs lab`,
 * which lays `src/` and what `lays` names at the tag `layers.json`'s `pinned.lab` declares, plus `.layer-ref` and no `.git`.
 * **A host that PULLS and does not INSTALL holds no lab code**, and a job that names `packages/lab/scripts/...` then dies in the
 * unit with `Cannot find module`, after the dispatch, the wake and the lock. The install step in `tasks/run-job.yml` runs only
 * when its own pull changed the checkout, so a checkout pulled by hand (or by an earlier job that died before the install)
 * reaches the play with nothing laid, and nothing on the host said so.
 *
 * It runs ON THE LAB, from `tasks/run-job.yml`, and not in `lab-job.mjs`'s `run()`: `run()` executes on the control plane or a laptop,
 * and the control plane's checkout never installs (ADR 0012), so a check there would refuse every dispatch and say nothing about the host
 * that runs the job. One predicate, two readers: the play runs this file as a command (`node packages/control/src/lab-laid-copy.mjs`),
 * and the test imports `labLaidCopyRefusal`.
 *
 * Judged: the directory exists, is the LAID shape (`.layer-ref` beside `src/`, no `.git`: a clone holds the layer repository's own layout,
 * which nothing here imports), holds everything `lays` names, and was laid at the tag `pinned.lab` declares NOW (a pull that moved the
 * pin and no install behind it leaves the old tree, which runs and answers for the wrong code). Imports only `node:` modules
 * (`control-has-no-dependencies.test.ts`).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL("../layers.json", import.meta.url));
const LAYER = "lab";
const REF_FILE = ".layer-ref";
const REFUSED = 4;

/**
 * @param {{ manifest: { pinned?: Record<string, { path: string, tag?: string, lays?: string[] }> }, root: string }} from
 * @returns {string | null} what is wrong, in the words a person dispatching a job needs, or `null` when the lab's code is laid at its pin
 */
export function labLaidCopyRefusal({ manifest, root }) {
  const declared = manifest.pinned?.[LAYER];
  if (declared?.tag === undefined) return `layers.json declares no \`pinned.${LAYER}\` with a tag: there is no lab code to look for`;
  const { path, tag, lays = ["src"] } = declared;
  const dir = join(root, path);
  const install = `run \`corepack pnpm install --frozen-lockfile\` (its \`prepare\` lays it) or \`node scripts/lay-layer.mjs ${LAYER}\` in ${root}`;
  if (!existsSync(dir)) return `this host holds NO lab code: ${path} does not exist (pulled and not installed?): ${install}`;
  if (existsSync(join(dir, ".git"))) return `${path} is a clone, not the laid copy \`scripts/lay-layer.mjs\` leaves (no \`.git\`): ${install}`;
  const refFile = join(dir, REF_FILE);
  if (!existsSync(refFile)) return `${path} has no ${REF_FILE}, so it is not laid at any tag: ${install}`;
  const missing = lays.filter((name) => !existsSync(join(dir, name)));
  if (missing.length) return `${path} is laid but holds no ${missing.join(", ")}: ${install}`;
  const laid = readFileSync(refFile, "utf8").trim();
  if (laid !== tag) return `${path} is laid at ${laid}, and layers.json pins ${tag} (pulled and not installed since the pin moved): ${install}`;
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  const refusal = labLaidCopyRefusal({ manifest: JSON.parse(readFileSync(MANIFEST_PATH, "utf8")), root: REPO_ROOT });
  if (refusal === null) process.exit(0);
  process.stderr.write(`lab-laid-copy: REFUSING: ${refusal}\n`);
  process.exit(REFUSED);
}
