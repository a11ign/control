/**
 * Do the lab's jobs run pnpm? (#2893, row 6 of 10 of #57)
 *
 * The lab's catalogue ran its package scripts as `["/usr/bin/npm", "run", ...]`. The repo installs with pnpm
 * (`corepack pnpm install --frozen-lockfile`, the lab's own install step included), so a job that still ran
 * npm ran it against a tree pnpm made -- a different resolver reading `node_modules` it did not build.
 *
 * The runner is `/usr/bin/corepack pnpm`, not a `/usr/bin/pnpm` shim: the lab has no such file (read from the
 * host, 2026-10-01), and corepack is the file the install step already names, so the argv cannot name a file
 * that nothing creates -- the job that fails at 3 a.m. The dispatch asks `corepack pnpm --version` first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

type Job = { argv: string[] | string };
type Table = Record<string, Job>;

const ANSIBLE = (name: string) => readFileSync(fileURLToPath(new URL(`../ansible/${name}`, import.meta.url)), "utf8");
const RUNNER = ["/usr/bin/corepack", "pnpm", "run"];
const NPM = "/usr/bin/npm";
/** The real catalogue never has fewer than this many jobs running a package script; an emptied table is not a pass. */
const MINIMUM_PACKAGE_SCRIPT_JOBS = 25;

const realTable = (): Table =>
  (parseYaml(ANSIBLE("lab-job.yml")) as Array<{ vars?: { lab_jobs?: Table } }>)
    .map((play) => play.vars?.lab_jobs).find(Boolean) ?? {};

/** A templated argv (`explain-case`) is a Jinja string; its text still names the runner it starts with. */
const spelling = (job: Job): string => (Array.isArray(job.argv) ? JSON.stringify(job.argv) : job.argv);

const startsWithRunner = (job: Job): boolean => {
  const quoted = RUNNER.map((word) => `["']${word.replace(/\//g, "\\/")}["']`).join("\\s*,\\s*");
  return new RegExp(`^(\\{\\{\\s*)?\\[\\s*${quoted}`).test(spelling(job));
};

/** The names of the jobs whose argv still spells npm: each is a refusal, and each names its job. */
const refusedForNpm = (table: Table): string[] =>
  Object.entries(table).filter(([, job]) => spelling(job).includes(NPM)).map(([name]) => name);

const packageScriptJobs = (table: Table): string[] =>
  Object.entries(table).filter(([, job]) => startsWithRunner(job)).map(([name]) => name);

test("a fixture table with /usr/bin/npm is REFUSED, naming the job; the pnpm spelling passes", () => {
  const fixture: Table = {
    "old-job": { argv: [NPM, "run", "--silent", "scorer:explain"] },
    "templated-old": { argv: "{{ ['/usr/bin/npm', 'run', 'x'] }}" },
    "new-job": { argv: [...RUNNER, "--silent", "corpus:snapshot"] },
  };
  assert.deepEqual(refusedForNpm(fixture), ["old-job", "templated-old"]);
  assert.deepEqual(refusedForNpm({ "new-job": fixture["new-job"] }), []);
  assert.deepEqual(packageScriptJobs({ "new-job": fixture["new-job"] }), ["new-job"]);
  assert.deepEqual(packageScriptJobs({ "old-job": fixture["old-job"] }), [],
    "the runner check accepts an argv that still starts with npm");
});

test("the real catalogue: no job spells /usr/bin/npm, and at least 25 run a package script through pnpm", () => {
  const table = realTable();
  assert.deepEqual(refusedForNpm(table), [],
    "these lab jobs still run `/usr/bin/npm`; the lab installs with pnpm, so they run a tree npm did not build");
  const runners = packageScriptJobs(table);
  assert.ok(runners.length >= MINIMUM_PACKAGE_SCRIPT_JOBS,
    `only ${runners.length} jobs run a package script through ${RUNNER.join(" ")}: an emptied or mis-parsed table`);
});

test("corpus-snapshot and corpus-backup are among them, and their runner is the one the install step uses", () => {
  const table = realTable();
  for (const name of ["corpus-snapshot", "corpus-backup", "corpus-backup-verify"].filter((n) => n in table)) {
    assert.ok(startsWithRunner(table[name]), `${name} does not start with ${RUNNER.join(" ")}`);
  }
  assert.ok("corpus-snapshot" in table && "corpus-backup" in table, "a silent-for-a-day job left the catalogue");
  assert.match(ANSIBLE("tasks/run-job.yml"), /argv: \[\/usr\/bin\/corepack, pnpm, install, --frozen-lockfile\]/,
    "the install step stopped using the corepack path these jobs now name");
});

test("the scheduled snapshot unit and the build step run pnpm too, and no Region file spells /usr/bin/npm", () => {
  const unit = ANSIBLE("files/a11y-corpus-snapshot.service");
  assert.match(unit, /-- \/usr\/bin\/corepack pnpm run corpus:snapshot$/m);
  assert.match(ANSIBLE("tasks/run-job.yml"), /argv: \[\/usr\/bin\/corepack, pnpm, run, build\]/);
  for (const file of ["lab-job.yml", "tasks/run-job.yml", "files/a11y-corpus-snapshot.service"]) {
    assert.ok(!ANSIBLE(file).includes(NPM), `${file} still spells ${NPM}`);
  }
});

test("a dispatch asks the runner for its version BEFORE it starts a unit, so a lab without corepack fails by name", () => {
  const runJob = ANSIBLE("tasks/run-job.yml");
  const preflight = runJob.indexOf('argv: ["{{ lab_corepack }}", pnpm, --version]');
  const start = runJob.indexOf('- name: "Start it: {{ job_name }}"');
  assert.ok(preflight > 0, "run-job.yml no longer asks `corepack pnpm --version` before dispatch");
  assert.ok(start > preflight, "the version question comes AFTER the unit starts, which is too late to refuse it");
  assert.match(ANSIBLE("group_vars/a11y_lab.yml"), /^lab_corepack: \/usr\/bin\/corepack$/m,
    "the preflight's runner defaults to the file the job argvs name");
  assert.match(runJob, /"--setenv=COREPACK_ENABLE_DOWNLOAD_PROMPT=0"/,
    "the unit has no terminal to answer corepack's download prompt");
});
