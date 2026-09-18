// @ts-check
/**
 * Run a lab job, after checking the fleet is running this checkout — for CAPTURE-BEARING jobs only.
 *
 * ## The round trip this closes
 *
 * `npm run lab:job -- -e job=capture-acceptance` used to be a bare `ansible-playbook` call. It dispatches
 * to the LAB over the `a11y-pve` key, the lab starts the job, the job's own script runs
 * `assertFleetRunsThisCheckout` — and THIRTY SECONDS LATER it dies with `10 stale worker(s)`, telling you
 * to run `fleet:deploy`. The check is correct and its message is good; it runs one round trip too late.
 * Twice in one day: worker files merged, a capture dispatched, a wait, a refusal.
 *
 * CLAUDE.md already names the asymmetry that causes it — `lab:pipeline` carries `fleet: true` and ships
 * the ref to the workers before dispatching, and `lab:job` structurally cannot, because only the control
 * plane holds both credentials (ADR 0012). So the job route depends on a human remembering a
 * prerequisite, which is this repo's own definition of a thing that does not happen.
 *
 * This asks the SAME question the late check asks, before dispatching anything: an HTTP request to every
 * worker's `/health`, reachable from wherever `lab:job` is run — no SSH, no control-plane key, so it works
 * on a laptop, which is where the mistake gets made.
 *
 * ## Which jobs, and why not all of them
 *
 * Refusing every job would make `rules-gate` or `train` — neither of which touches a worker — need a
 * healthy fleet they never use, and a check that fires where the risk is not gets routed around with the
 * override until the override is the habit. Refusing too narrowly means the forgotten job is the one that
 * slips through, so `captureBearingJobs` DERIVES the set from the catalogue rather than naming it: every
 * job whose `setenv` sets `A11Y_WORKERS` from `lab_fleet_workers` is one that dispatches real captures
 * across the whole fleet, and that is exactly the set `worker-code-check.test.ts` already protects one
 * layer down via `CORPUS_WRITERS` — `capture`, `capture-only`, `capture-real-pages`, `capture-acceptance`,
 * `capture-acceptance-2` run one of those scripts directly, and `retrain`/`everything` reach it through
 * their own step lists (`retrain-pipeline.mjs`'s `STEPS` names `training:capture` as its second stage).
 *
 * Deliberately EXCLUDED: `stability`/`gate-stability` (one named worker, a diagnostic gate, never a
 * permanent corpus write) and `evidence-check` (also a diagnostic — it drives real captures to compare
 * them, and never persists into the trained corpus). `worker-code-check.test.ts`'s own header states the
 * reason: "a diagnostic must NEVER be the thing that takes the pool offline". A stale worker there costs
 * one wrong verdict on one invocation; a stale worker on a corpus writer costs 2,122 captures that can
 * never be told apart from current ones afterward. The stakes are not the same and the guard should not
 * pretend they are.
 *
 * ## Why this cannot import `worker-code-check.mjs` directly
 *
 * That file's `expectedWorkerCode` reaches `codeVersion`/`workerSourceDir` through a SUBPATH export
 * (`@a11ign/nvda-worker/code-version`), which resolves through `node_modules` — and this package
 * runs from a raw git checkout with none (ADR 0012; `control-has-no-dependencies.test.ts` enforces it).
 * `code-drift.mjs` is the part of that file with no opinion about what "expected" means — pure comparison
 * and message-building, importing nothing but `node:child_process` — and this file computes `expected`
 * itself, the same way `fleet-playbook.mjs` already does, through the SAME relative path
 * `code-version.mjs` documents as safe: it imports nothing but node stdlib and `worker-files.mjs`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertWorkersServe } from "../../worker-fleet/src/code-drift.mjs";
import { codeVersion, workerSourceDir } from "../../nvda-worker/src/code-version.mjs";
// #1356: the CONTROL PLANE's own inventory, never a checkout's `inventory.yml` -- gitignored, and this
// job is dispatched FROM the control plane (it needs `A11Y_PVE_KEY` to reach the lab at all, the same
// credential this read needs), so asking it directly costs nothing this job was not already paying.
import { readControlPlaneFleet } from "./control-plane-fleet.mjs";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CATALOGUE = fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url));
const ANSIBLE_CONFIG = "packages/control/ansible/ansible.cfg";

/**
 * Every `-e key=value` extra var on the command line — the only form every example in this repo's docs
 * uses (`-e job=train`, two argv entries), and the only form `lab-job.yml`'s own header shows.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function extraVars(argv) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "-e" && argv[i] !== "--extra-vars") continue;
    const pair = argv[i + 1];
    const eq = pair?.indexOf("=") ?? -1;
    if (eq > 0) vars[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return vars;
}

/**
 * Every job name whose command reads `A11Y_WORKERS` from the whole fleet — DERIVED from the catalogue's
 * own text, never hand-written, for the reason `worker-files.mjs` and the signal-type scrape both taught
 * this repo: a hand-written list is a fact stated twice and this repo's record on those is that they drift.
 *
 * `lab-job.test.ts` parses this same file with a real YAML library, which `packages/control` may not
 * depend on (ADR 0012). So this slices the catalogue into per-job blocks by the indentation `lab-job.yml`
 * already commits to (job names at 6 spaces under `lab_jobs:`) rather than parsing YAML properly — a
 * narrower tool than a parser, and mutation-checked rather than trusted on the strength of reading it.
 *
 * @param {string} catalogueText the raw text of `lab-job.yml`
 * @returns {string[]}
 */
export function captureBearingJobs(catalogueText) {
  const from = catalogueText.indexOf("\n    lab_jobs:");
  const to = catalogueText.indexOf("\n  tasks:", from);
  if (from < 0 || to < 0) {
    throw new Error("could not find lab_jobs: ... tasks: in lab-job.yml — this file's shape changed, and "
      + "this derivation is blind rather than the catalogue being clean");
  }
  const catalogue = catalogueText.slice(from, to);
  const headers = [...catalogue.matchAll(/\n {6}([a-z][a-z0-9-]*):\n/g)];
  const jobs = headers.map((match, index) => {
    const start = match.index + 1;
    const end = index + 1 < headers.length ? headers[index + 1].index + 1 : catalogue.length;
    return { name: match[1], block: catalogue.slice(start, end) };
  });
  if (jobs.length < 15) {
    throw new Error(`only found ${jobs.length} job(s) in lab-job.yml's catalogue; the indentation this scan `
      + "depends on changed, and this derivation is blind rather than the catalogue being small");
  }
  return jobs
    // DERIVES ITS POOL FROM THE FLEET is the property; a VERBATIM passthrough was the string. This used to
    // require `A11Y_WORKERS={{ lab_fleet_workers }}` exactly, so the moment a job computed its pool from
    // the fleet -- `capture-only` gained a `workers` cap, sliced off the same list -- it silently dropped
    // out of the capture-bearing set and lost its fleet-staleness pre-check. Nothing would have said so:
    // the job still dispatches real captures across real boxes, and the guard that refuses a stale fleet
    // simply stops running for it.
    //
    // Widening is safe in the direction that matters: it can only ADD jobs to the protected set. A job
    // that mentions `lab_fleet_workers` in its `A11Y_WORKERS` at all is dispatching across the fleet by
    // construction, whatever it does to the list first.
    //
    // `\b` is DEFENSIVE, not load-bearing, and saying which is the point. Without it the pattern matches a
    // PREFIX, so a rename to `lab_fleet_workers_SOMETHING` would still match. The rename mutation was
    // widened at the same time to replace the fact everywhere rather than one spelling of it, and that
    // alone closes the case -- so removing `\b` now fails no test. Kept because a prefix match is wrong
    // whether or not a test happens to reach it, and recorded as unproven rather than left to read as
    // proven.
    .filter(({ block }) =>
      /setenv:\s*\[[^\]]*A11Y_WORKERS=\{\{[^}]*lab_(fleet|selected)_workers\b/.test(block))
    .map(({ name }) => name);
}

/**
 * The job named on this command line, or `undefined` if none was (a malformed invocation `lab-job.yml`'s
 * own refusal already handles, unchanged by anything here).
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
const jobNamed = (argv) => extraVars(argv).job;

/**
 * `-e describe=1` ends the play before anything runs — `lab-job.yml`'s own comment calls it "describing is
 * not running". Checking the fleet first would ask ten boxes over HTTP to answer a question that dispatches
 * nothing, which is not wrong, only pointless.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
const isDescribeOnly = (argv) => extraVars(argv).describe !== undefined;

/**
 * The `ansible-playbook` argv `dispatchToAnsible` runs, pulled out so a test can read it without spawning
 * anything real.
 *
 * #1670: NO `-i` HERE, DELIBERATELY. An explicit `-i` on the command line REPLACES `ansible.cfg`'s own
 * `inventory =` setting rather than falling back to it (Ansible's documented CLI precedence), and that
 * setting is `/etc/a11ign/inventory.yml,inventory.yml` precisely so a checkout with no in-tree
 * `inventory.yml` (gitignored; a plain `git pull` deletes it, per `ansible.cfg`'s own header) still
 * resolves the fleet from the durable, installed copy. A hardcoded `-i` pointed at the in-tree path alone
 * asked for the one copy every fresh checkout and worktree does not have, and refused with "no host
 * matched" on the control plane's own persistent checkout even though `/etc/a11ign/inventory.yml` was
 * present and correct. `ANSIBLE_CONFIG` (read where this is spawned) is what makes that fallback list
 * apply at all.
 * @param {string[]} forwarded
 * @returns {string[]}
 */
export function ansiblePlaybookArgs(forwarded) {
  return ["packages/control/ansible/lab-job.yml", ...forwarded];
}

/**
 * The SAME command a human would type — `ANSIBLE_CONFIG` matters, exactly as `lab-pipeline.mjs` states.
 * @param {string[]} forwarded
 */
function dispatchToAnsible(forwarded) {
  const result = spawnSync("ansible-playbook", ansiblePlaybookArgs(forwarded),
    { cwd: REPO, stdio: "inherit", env: { ...process.env, ANSIBLE_CONFIG } });
  process.exit(result.status ?? 1);
}

/**
 * #1356: THE POOL a capture-bearing job checks against, pure -- given an explicit `workers` list or the
 * control plane's own resolved fleet. `run` below is this plus the real exit.
 * @param {string} job
 * @param {{ workers?: string[], readFleet: () => { workers: { name: string, url: string }[], refusal: string | null } }} input
 * @returns {{ pool: string[], refusal: null } | { pool: null, refusal: string }}
 */
export function poolFor(job, { workers, readFleet }) {
  if (workers) return { pool: workers, refusal: null };
  const fleet = readFleet();
  if (fleet.refusal) {
    return { pool: null, refusal: `REFUSING ${job}: could not learn which boxes it will dispatch to -- `
      + `${fleet.refusal}. Could not ask is not may proceed.` };
  }
  return { pool: fleet.workers.map((w) => w.url), refusal: null };
}

/**
 * Check the fleet, then dispatch — every dependency injectable, so a test can drive the DECISION without
 * a real fleet, a real ansible-playbook, or a real `process.exit`.
 *
 * `worker-code-check.test.ts` set the precedent for why: `assertWorkersServe` exits the process on
 * refusal, and a function built to be asserted on cannot let the test runner die with it. So `checkFleet`
 * is swapped for a fake in tests — one that returns normally to simulate a clean fleet, or throws to
 * simulate what an exit would have done — and `dispatch` is swapped for one that only records the call.
 *
 * `catalogueText`/`workers`/`expected` are left UNDEFINED by default rather than defaulted to a real read,
 * a real inventory and a real hash — those three cost a file read, a fleet-wide DNS-free lookup and a
 * directory hash respectively, and a job like `train` or `rules-gate` that will never reach `checkFleet`
 * should not pay any of them. Resolved lazily, inside the branch that actually needs them.
 *
 * @param {string[]} argv
 * @param {{ catalogueText?: string, workers?: string[], expected?: string,
 *           checkFleet?: (expected: string, workers: string[], options: object) => Promise<void>,
 *           dispatch?: (forwarded: string[]) => void,
 *           readFleet?: () => { workers: { name: string, url: string }[], refusal: string | null } }} [deps]
 */
export async function run(argv, {
  catalogueText, workers, expected,
  checkFleet = assertWorkersServe,
  dispatch = dispatchToAnsible,
  readFleet = readControlPlaneFleet,
} = {}) {
  // Stripped before forwarding: `ansible-playbook` does not recognise this flag and would refuse the
  // whole command line with it still attached, and it is this file's own concern, not the playbook's.
  const allowStale = argv.includes("--allow-stale-workers");
  const forwarded = argv.filter((a) => a !== "--allow-stale-workers");

  const job = jobNamed(argv);
  if (job && !isDescribeOnly(argv)) {
    const catalogue = catalogueText ?? readFileSync(CATALOGUE, "utf8");
    if (captureBearingJobs(catalogue).includes(job)) {
      // #1356: the CONTROL PLANE's own inventory when `workers` was not given directly -- never a
      // checkout's `inventory.yml`, gitignored and absent here just as it was on the control plane's own
      // persistent checkout (#1670). `poolFor` refuses in ITS OWN words before `checkFleet` ever runs,
      // rather than handing it an empty pool that reads as "no workers were given" -- a real but less
      // specific claim.
      const resolved = poolFor(job, { workers, readFleet });
      if (resolved.pool === null) {
        process.stderr.write(`${resolved.refusal}\n`);
        return process.exit(3);
      }
      const pool = resolved.pool;
      const hash = expected ?? codeVersion(workerSourceDir());
      await checkFleet(hash, pool, { when: "before dispatching to the lab", allow: allowStale,
        bareMetalUrls: pool });
      // A real checkFleet exits the process on refusal; reaching here means it passed (or --allow-stale-workers).
    }
  }

  dispatch(forwarded);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await run(process.argv.slice(2));
