/**
 * A pipeline is an ORDER over jobs that live somewhere else, so the two can drift — and this repo's record
 * on a fact stated twice is unambiguous: five instances in one day, every one silent.
 *
 * The drift here has a specific cost that makes it worth pinning rather than trusting. A pipeline naming a
 * job that no longer exists fails at that STAGE, which for `corpus` is after a multi-hour capture; and a
 * pipeline that captures without `fleet: true` runs against whatever the boxes happen to be serving, which
 * is the exact fault `worker-code-check.mjs` was written for one layer down.
 *
 * The catalogue is YAML and the pipelines are JS, so a copy cannot be deleted here. That leaves the third
 * option — pin them equal with a test — which is what `name-normalisation.test.ts` does for the same
 * reason, and which failed twice on its first run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { PIPELINES, jobNames, validRef } from "./lab-pipeline.mjs";

type Job = { argv?: unknown; setenv?: string[]; timeout?: number };

/** The job catalogue, read from the playbook that owns it. */
function catalogue(): Record<string, Job> {
  const text = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");
  const doc = parseYaml(text) as Array<{ vars?: { lab_jobs?: Record<string, Job> } }>;
  const jobs = doc.flatMap((play) => (play?.vars?.lab_jobs ? [play.vars.lab_jobs] : []))[0];
  // A guard that parses the wrong shape passes while examining nothing — the signal-type scrape that
  // matched an empty set and the `sweepLog` test that read a field which does not exist.
  if (!jobs) throw new Error("lab_jobs not found in lab-job.yml — this guard is parsing the wrong shape");
  return jobs;
}

const JOBS = catalogue();

/** A job that reads a worker address needs the fleet deployed before it runs. */
const usesWorkers = (job: Job) =>
  (job?.setenv ?? []).some((entry) => /^A11Y_WORKERS?=/.test(String(entry)));

test("the catalogue parsed, and parsed enough of it to be worth asserting on", () => {
  assert.ok(Object.keys(JOBS).length > 10,
    `only ${Object.keys(JOBS).length} jobs parsed out of the catalogue; the shape changed and this is blind`);
  assert.ok(Object.values(JOBS).some(usesWorkers),
    "no job in the catalogue reads A11Y_WORKER(S) — the fleet check below would then be vacuous");
});

test("every job a pipeline names exists in the catalogue", () => {
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    for (const job of jobNames(pipeline)) {
      assert.ok(Object.hasOwn(JOBS, job),
        `pipeline '${name}' names job '${job}', which lab-job.yml does not have. It would be refused at `
        + `that stage — for 'corpus' that is after a multi-hour capture has already run.`);
    }
  }
});

test("a pipeline that captures deploys the fleet first", () => {
  // Otherwise it captures with whatever the workers happen to be serving, and the evidence is stamped with
  // a commit that did not produce it. `assertFleetRunsThisCheckout` would now REFUSE such a run at the
  // worker level, which is the belt; this is the braces, and it fails at dispatch rather than an hour in.
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const needs = jobNames(pipeline).filter((job) => usesWorkers(JOBS[job]));
    if (!needs.length) continue;
    assert.equal(pipeline.fleet, true,
      `pipeline '${name}' runs ${needs.join(", ")}, which read A11Y_WORKER(S), but does not deploy the `
      + "fleet first. Set fleet: true, or the run captures with whatever the boxes are running.");
  }
});

test("a pipeline that needs no worker does NOT wake the fleet", () => {
  // The other direction, and it matters as much: deploying restarts every guest, so a gates-only pipeline
  // that declared `fleet: true` would take the fleet offline to run something that reads from disk.
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    if (jobNames(pipeline).some((job) => usesWorkers(JOBS[job]))) continue;
    assert.equal(pipeline.fleet, false,
      `pipeline '${name}' needs no worker, so deploying would restart the fleet for nothing.`);
  }
});

test("at least one pipeline of each kind exists, so neither branch is untested by construction", () => {
  const values = Object.values(PIPELINES);
  assert.ok(values.some((p) => p.fleet), "no pipeline deploys the fleet; the check above is vacuous");
  assert.ok(values.some((p) => !p.fleet), "no pipeline skips the fleet; the check above is vacuous");
});

test("every pipeline names what it is for, and orders at least two stages", () => {
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    assert.ok((pipeline.what ?? "").length > 20, `pipeline '${name}' does not say what it is for`);
    assert.ok(jobNames(pipeline).length >= 2,
      `pipeline '${name}' has ${jobNames(pipeline).length} stage(s) — a pipeline of one is a job, so use lab:job`);
    assert.deepEqual([...new Set(pipeline.jobs)], pipeline.jobs,
      `pipeline '${name}' runs a job twice; each stage is idempotent, so that is almost certainly a slip`);
  }
});

test("a ref is contained by SHAPE, because it reaches a shell on the box holding the fleet key", () => {
  // Same rule as `isValidCaptureId` and `fleet-playbook.mjs`: inexpressible rather than rejected.
  assert.ok(validRef("main"));
  assert.ok(validRef("feature/np-calibration"));
  assert.ok(validRef("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"));
  for (const bad of ["a;rm -rf /", "$(whoami)", "a b", "../../etc", "a..b", "`id`", "", "x".repeat(65)]) {
    assert.equal(validRef(bad), false, `validRef must refuse ${JSON.stringify(bad)}`);
  }
});

test("a stage runs the npm script, never a second spelling of the ansible command", () => {
  // `lab:job` sets ANSIBLE_CONFIG; a hand-spelled `ansible-playbook` here would silently use different
  // collections and host-key settings. Asserted structurally because running a stage means running a job.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  const executable = source.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join("\n");
  assert.ok(!/ansible-playbook/.test(executable),
    "lab-pipeline.mjs spells out ansible-playbook again. Go through `npm run lab:job`, which owns the "
    + "invocation and its ANSIBLE_CONFIG.");
  assert.match(executable, /"run", "lab:job"/);
  assert.match(executable, /"run", "fleet:deploy"/);
});

test("stages are run with their status READ, never piped", () => {
  // Two real `ANSIBLE_EXIT=2` failures were masked by `| tail` in one day, because a pipeline's status is
  // the last command's. `stdio: "inherit"` is what makes the child's status the one that is read.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  assert.match(source, /stdio: "inherit"/);
  assert.ok(!/stdio: "pipe"/.test(source),
    "a piped stage hides the output the operator needs and invites reading the wrong status");
});

test("the lab stages are pinned to a COMMIT, not to a branch that can move under them", () => {
  // A branch is a moving target and each stage resolves it independently, at the moment it runs. A push
  // landing mid-pipeline therefore puts later stages on different code from earlier ones — a `train`
  // fitted to a corpus that a `capture` at another commit produced, every stage reporting success.
  // Nothing downstream could say so: run-job.yml refuses a commit other than the one ASKED FOR, and each
  // stage would have asked for a different one and got it.
  //
  // Twice on 2026-08-25 a push had to be held by hand for exactly this — through provisioning, where each
  // box stamps the SHA it fast-forwarded to, and through this pipeline. "Do not push for six hours" is a
  // rule that depends on somebody remembering it, which is what this file exists to remove.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  const code = source.split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");

  // Matched loosely on the ARGUMENT, not the whole call: the first version asserted `labJob(job, pinned)`
  // literally and broke the moment a third parameter was added for `-e only=`. The property is "the
  // stage receives the pinned commit"; a pattern that also pins the arity is asserting something nobody
  // meant. It failed on a change that preserved exactly what it was written to protect.
  assert.match(code, /labJob\(job, pinned/,
    "lab stages must be given the resolved commit, never the branch name");
  assert.ok(!/labJob\(job, ref\)/.test(code), "a lab stage still takes the moving branch");
  // The fleet stage keeps the BRANCH, and that asymmetry is forced: deploy.yml fast-forwards each guest
  // with `git merge --ff-only origin/<ref>`, and `origin/<sha>` resolves to nothing — a mistake this repo
  // has already spent a run on.
  assert.match(code, /fleetDeploy\(ref\)/,
    "the fleet stage must keep the branch; origin/<sha> is not a thing git can merge");
});

test("the pin comes from ORIGIN, so it cannot be a stale local ref", () => {
  // `git ls-remote` asks the remote, so it needs no fetch and cannot answer with whatever this checkout
  // last happened to fetch. Resolving `origin/<branch>` locally would reintroduce exactly the staleness
  // the pin exists to remove.
  const source = readFileSync(fileURLToPath(new URL("./lab-pipeline.mjs", import.meta.url)), "utf8");
  assert.match(source, /ls-remote/, "the pin must ask origin directly");
  assert.match(source, /\^\[0-9a-f\]\{40\}\$|\[0-9a-f\]\{40\}/,
    "and must verify origin answered a commit rather than trusting the string");
});

/**
 * What each job PRODUCES, declared — because argv cannot be scraped for it.
 *
 * My first version of the ordering guard derived producers from `--out=` in each job's argv, and it did
 * not catch `train` moved ahead of `retrain`: `retrain` delegates to an npm script
 * (`["/usr/bin/npm","run","lab:retrain"]`), so the artifact it writes appears nowhere in its argv. A
 * guard that reads the command line can only see jobs that name a binary, which is a subset that happens
 * to exclude the composite jobs an ordering error is most likely to involve.
 *
 * So production is DECLARED and consumption is derived. That asymmetry is deliberate: consumption really
 * is visible in argv (`--data <path>`), and declaring both would be two lists to keep in step.
 * `producesSomething` below fails if a declared producer stops existing, so this cannot rot silently.
 */
const PRODUCES: Record<string, string> = {
  retrain: "runs/screenreader-dataset/with-realism.jsonl",
  "build-realism": "runs/screenreader-dataset/with-realism.jsonl",
  export: "runs/screenreader-dataset/screenreader-evidence.jsonl",
  "export-test": "runs/screenreader-dataset/screenreader-evidence.jsonl",
  "export-acceptance": "runs/screenreader-acceptance/repeat-1.jsonl",
};

test("every declared producer is a real job, so this list cannot rot", () => {
  for (const job of Object.keys(PRODUCES)) {
    assert.ok(Object.hasOwn(JOBS, job), `${job} is declared to produce an artifact and is not a job`);
  }
});

test("no stage consumes a dataset an EARLIER stage has not produced", () => {
  // A 13-stage pipeline that fails at stage 4 because its input does not exist has burned three stages —
  // and for `full` the first of those is a multi-hour capture. Ordering is the one property a long chain
  // has that a single job does not, and nothing asserted it.
  const consumers = new Map<string, string[]>();
  for (const [name, job] of Object.entries(JOBS)) {
    const argv = JSON.stringify(job.argv ?? "");
    for (const match of argv.matchAll(/runs\/[a-z0-9/-]+\.jsonl/g)) {
      const artifact = match[0];
      if (PRODUCES[name] === artifact) continue;   // its own output is not a dependency
      consumers.set(name, [...(consumers.get(name) ?? []), artifact]);
    }
  }
  assert.ok(consumers.size > 2, "no consumers found; the argv shape changed and this guard is blind");

  // Flattened into a helper rather than three nested loops: `max-depth` flagged it, and the gate was
  // right — the ordering question is about ONE pipeline, and saying so makes it readable.
  const outOfOrder = (pipelineName: string, jobs: string[]): string[] => {
    const produced = new Set<string>();
    const problems: string[] = [];
    for (const job of jobs) {
      // Only an artifact this pipeline produces ITSELF is ordered by it. One produced by an earlier run
      // is a precondition, not an ordering error — `gates` deliberately reads a corpus already on disk,
      // which is why it needs no fleet.
      const missing = (consumers.get(job) ?? [])
        .filter((artifact) => jobs.some((candidate) => PRODUCES[candidate] === artifact))
        .filter((artifact) => !produced.has(artifact));
      for (const artifact of missing) {
        const producer = jobs.find((candidate) => PRODUCES[candidate] === artifact);
        problems.push(`pipeline '${pipelineName}' runs '${job}', which reads ${artifact}, before `
          + `'${producer}' which writes it — it would fail there having paid for the stages before it.`);
      }
      if (PRODUCES[job]) produced.add(PRODUCES[job]);
    }
    return problems;
  };

  const problems = Object.entries(PIPELINES)
    .flatMap(([pipelineName, pipeline]) => outOfOrder(pipelineName, jobNames(pipeline)));
  assert.deepEqual(problems, []);
});

test("a chain that TRAINS must gate what it built, not what was already shipped", () => {
  // Caught by reading `lab:everything` before it ran, two hours into a capture it depends on.
  //
  // The chain was: retrain -> export-acceptance -> train -> grants-audit -> release:gate. That trains a
  // CANDIDATE and then runs `release:gate`, which scores the SHIPPED weights — so it would have graded
  // the old model against freshly exported acceptance data and reported on an artefact nobody had just
  // built. Every stage would have passed or failed for reasons unconnected to the retrain.
  //
  // This is the same defect CLAUDE.md records twice already: `npm run eval` resolved the shipped artefact
  // always, so a candidate's judge quality was unknowable until after promotion; and the abstention sweep
  // measured raw predictions instead of the product path. "A gate that does not exercise what ships is
  // not a gate" — and its mirror, a gate that examines what ships when a candidate is the question.
  const scripts = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
  ).scripts as Record<string, string>;

  for (const [name, command] of Object.entries(scripts)) {
    const trains = /\btraining:train\b|\blab:retrain\b/.test(command);
    const gatesRelease = /\brelease:gate\b/.test(command);
    if (!trains || !gatesRelease) continue;
    assert.match(command, /promote:gated|candidate:gate/,
      `'${name}' trains a candidate and then runs release:gate, which scores the SHIPPED weights. It must `
      + "gate the candidate (promote:gated / candidate:gate) first, or it reports on an artefact it did "
      + "not build.");
    // Ordering too: gating the candidate AFTER the release gate would satisfy the check above and still
    // grade the wrong thing.
    assert.ok(command.indexOf("promote:gated") < command.indexOf("release:gate"),
      `'${name}' runs release:gate before promoting the candidate, so the release gate still describes `
      + "the previous weights.");
  }
});

/**
 * THE REAL-PAGE PIPELINE MUST CAPTURE EVERY SCORED ROLE, and this is the test that says so.
 *
 * `capture-real-pages` defaults to `--role=training`, so a stage that names no role captures 39 of the 89
 * real pages — and `rules-real-pages` then scores, and `--update` rewrites the baseline against, whatever
 * happened to be on disk from some earlier run. Measured 2026-08-27: a calibration-only capture followed
 * by an update took the baseline from 85 pages to 81 and erased a known 2.4.3, silently.
 *
 * Derived from the corpus rather than hardcoded, so adding a role to `real-page-corpus.mjs` fails HERE
 * instead of quietly halving a run's coverage. `fixture` is excluded because those pages are not scored
 * as conformant real pages — the same list `pagesFor` serves.
 */
test("the real-pages pipeline captures every role the corpus scores", async () => {
  const { REAL_PAGES } = await import("../../lab/src/training/real-page-corpus.mjs");
  const scored = [...new Set(REAL_PAGES.map((page) => page.role))].filter((role) => role !== "fixture");
  const captured = (PIPELINES["real-pages"].jobs as Array<string | { job: string; vars?: Record<string, string> }>)
    .filter((entry): entry is { job: string; vars?: Record<string, string> } =>
      typeof entry !== "string" && entry.job === "capture-real-pages")
    .map((entry) => entry.vars?.role)
    .filter((role): role is string => typeof role === "string");
  for (const role of scored) {
    assert.ok(captured.includes(role),
      `pipeline 'real-pages' never captures role='${role}', so it would score and rewrite the baseline `
      + `against whatever stale captures that role has on disk. Captured: ${captured.join(", ") || "(none — "
      + "the stage names no role, so it takes capture-real-pages' default of training)"}`);
  }
});

/**
 * `capture-real-pages` must come BEFORE any stage that rebuilds the realism tier.
 *
 * `retrain` ends with `build-realism`, which assembles the real-page tier from the captures ON DISK. Run
 * the other way round, that tier is built from the PREVIOUS run's real captures — so a change to what a
 * real capture carries is absent from the very dataset the gates then score, and the run reports success
 * having answered about the wrong corpus.
 *
 * It is a live risk rather than a theoretical one: `4.1.3: 0 of 37` moves only when a configured
 * real-page capture reaches `postSubmitFields`, and `build-realism` masks 4.1.3 on exactly that field. A
 * pipeline that trained before capturing would report the mask still in place and look like a refutation.
 *
 * Pinned as a PROPERTY over every pipeline rather than as a fact about one, so a future chain that
 * combines these stages inherits the ordering instead of rediscovering it.
 */
test("no pipeline rebuilds the realism tier before capturing the real pages it reads", () => {
  /** Stages that run `build-realism` — from the job catalogue's chain, not from a guess. */
  const REBUILDS_REALISM = ["retrain", "full", "everything"];
  const nameOf = (entry: string | { job: string }) => (typeof entry === "string" ? entry : entry.job);

  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const jobs = (pipeline.jobs as Array<string | { job: string }>).map(nameOf);
    const firstCapture = jobs.indexOf("capture-real-pages");
    if (firstCapture === -1) continue;
    const rebuild = jobs.findIndex((job) => REBUILDS_REALISM.includes(job));
    if (rebuild === -1) continue;
    assert.ok(firstCapture < rebuild,
      `pipeline '${name}' runs '${jobs[rebuild]}' at position ${rebuild} and captures the real pages at `
      + `${firstCapture}. \`build-realism\` reads the captures on disk, so the realism tier would be built `
      + "from the PREVIOUS run's — the gates then score a dataset that does not contain the change being "
      + "tested, and report success about the wrong corpus.");
  }
});

test("the migration-verdict pipeline does not promote", () => {
  // It ANSWERS a question; it does not act on the answer. A migration that fails its gates is REVERTED,
  // and a chain that promoted on the way past would make "the gates said no" and "the weights shipped"
  // reachable in a single dispatch. `candidate` is the pipeline that promotes, and choosing it is
  // choosing to.
  const jobs = (PIPELINES["migration-verdict"].jobs as Array<string | { job: string }>)
    .map((entry) => (typeof entry === "string" ? entry : entry.job));
  assert.ok(!jobs.includes("promote"),
    "migration-verdict promotes. The pipeline that decides whether a schema change is sound must not be "
    + "able to ship it in the same run — use `candidate` when promotion is the intent.");
});

/**
 * A pipeline that TRAINS and then gates on held-out acceptance must first REBUILD that held-out set.
 *
 * `export-acceptance` exports whatever acceptance captures are on disk. It cannot notice that the corpus
 * gained a subtype since they were taken — so a run that adds one trains a head the held-out set has no
 * examples of, and the `acceptance` gate refuses the model it cannot evaluate. Measured 2026-09-03:
 * `migration-verdict` died at stage 8 of 10 with *"3.1.2: fewer than 3 acceptance positives"*, after the
 * 29 language cases entered the corpus. Regenerating took the set from 42 pairs to 61.
 *
 * It was unfixable from inside the pipeline as it stood: NO chain ran `generate-acceptance` or
 * `capture-acceptance`, though both exist as jobs. Closing it meant an operator remembering two commands,
 * which is this repo's own definition of a step that does not happen.
 *
 * Both repeats are required, not one. They are what measure whether NVDA's output is still stable, and
 * the evaluator reads every repeat — capturing one while exporting both is how a held-out score comes to
 * be computed half on each, which `training:export-acceptance:all` exists to prevent.
 */
test("a pipeline that gates on acceptance rebuilds the held-out set first", () => {
  const nameOf = (entry: string | { job: string }) => (typeof entry === "string" ? entry : entry.job);

  /**
   * Pipelines that gate on acceptance WITHOUT rebuilding the set, each with the reason.
   *
   * Classified rather than exempted by pattern, because "this one need not" and "somebody forgot" must
   * stay different states. The cost is real on both sides: rebuilding is ~45 minutes of fleet time on
   * every run, and NOT rebuilding risks a run that dies at the acceptance gate. It dies LOUDLY — measured
   * — so the trade is a failed run against a slower one, never a bad model.
   */
  const REBUILDS_NOTHING: Readonly<Record<string, string>> = {
    recalibrate: "its entire contract is 're-derive and re-gate the model from the dataset already on "
      + "disk — no capture, no export'. Adding capture stages would make it need the fleet, which is the "
      + "one thing it exists not to need.",
    candidate: "the routine promote path, run when the corpus has NOT changed. When it has, the "
      + "acceptance gate refuses rather than passing on a stale set — verified 2026-09-03 — so the cost "
      + "of the omission is a failed dispatch, and `migration-verdict` is the chain to use instead.",
    full: "same trade as `candidate`, and it already carries thirteen stages. A corpus change goes "
      + "through `migration-verdict`, which rebuilds.",
  };

  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const jobs = (pipeline.jobs as Array<string | { job: string }>).map(nameOf);
    if (!jobs.includes("acceptance") || !jobs.includes("train")) continue;
    if (name in REBUILDS_NOTHING) continue;

    for (const required of ["generate-acceptance", "capture-acceptance", "capture-acceptance-2"]) {
      assert.ok(jobs.includes(required),
        `pipeline '${name}' trains and then gates on 'acceptance', but never runs '${required}'. The `
        + "held-out set would be whatever is on disk — and if the corpus gained a subtype since, the gate "
        + "refuses a model it cannot evaluate, with no stage in this chain able to fix it.");
    }
    const rebuilt = Math.max(...["generate-acceptance", "capture-acceptance", "capture-acceptance-2",
      "export-acceptance"].map((job) => jobs.indexOf(job)));
    assert.ok(rebuilt < jobs.indexOf("train"),
      `pipeline '${name}' rebuilds the held-out set AFTER training, so the model is gated against a set `
      + "it was not evaluated on. The rebuild must finish before `train`.");
  }
});
