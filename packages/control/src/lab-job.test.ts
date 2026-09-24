/**
 * Does `lab:job` refuse a CAPTURE-BEARING job before dispatching to the lab at all?
 *
 * The fault being closed: `npm run lab:job -- -e job=capture-acceptance` used to be a bare
 * `ansible-playbook` call. It dispatches over the lab's own SSH key, the lab starts the job, and the
 * job's own script runs `assertFleetRunsThisCheckout` — THIRTY SECONDS LATER, telling you to run
 * `fleet:deploy`. Correct and one round trip too late.
 *
 * These tests deliberately never call `run()` in a way that reaches a real fleet, a real
 * `ansible-playbook`, or a real `process.exit` — the same discipline `worker-code-check.test.ts` states
 * for the identical reason: a function built to be asserted on cannot let the test runner die with it.
 * `checkFleet` and `dispatch` are swapped for fakes throughout.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { ansiblePlaybookArgs, captureBearingJobs, extraVars, run, poolFor } from "./lab-job.mjs";

const CATALOGUE = readFileSync(fileURLToPath(new URL("../ansible/lab-job.yml", import.meta.url)), "utf8");

test("-e job=<name> is read regardless of what else is on the line", () => {
  assert.deepEqual(extraVars(["-e", "job=train"]), { job: "train" });
  assert.deepEqual(extraVars(["-e", "job=capture-only", "-e", "only=route-title-stale+"]),
    { job: "capture-only", only: "route-title-stale+" });
  assert.deepEqual(extraVars(["--extra-vars", "job=stability", "-e", "worker=a11y-worker-2"]),
    { job: "stability", worker: "a11y-worker-2" });
});

test("no -e job= at all reads as no job — the same malformed invocation lab-job.yml already refuses", () => {
  assert.deepEqual(extraVars([]), {});
  assert.deepEqual(extraVars(["-e"]), {});
  assert.deepEqual(extraVars(["--allow-stale-workers"]), {});
});

test("the capture-bearing jobs are exactly these, against the real catalogue", () => {
  // Pinned by MEMBERSHIP, not just count — the same reasoning `asserting-subtypes.test.ts` gives: two
  // numbers can stay right while the wrong job moves into or out of the set, and this is the strongest
  // claim this file makes (which job gets a fleet check before it can waste a lab dispatch).
  assert.deepEqual([...captureBearingJobs(CATALOGUE)].sort(), [
    "capture", "capture-acceptance", "capture-acceptance-2", "capture-only", "capture-real-pages",
    "everything", "retrain",
  ].sort(),
  "the set of jobs that dispatch real captures across the fleet changed. Each one runs "
    + "capture-real-pages.mjs or capture-screenreader-dataset.mjs, directly or through its own chain "
    + "(retrain -> training:capture, everything -> retrain) -- update this list with the reason, not just "
    + "the membership.");
});

test("stability, gate-stability and evidence-check are NOT capture-bearing — they are diagnostics", () => {
  // The asymmetry `worker-code-check.test.ts` already states: "a diagnostic must NEVER be the thing that
  // takes the pool offline." A stale worker under one of these costs a wrong verdict on one invocation; a
  // stale worker under a corpus writer costs 2,122 captures indistinguishable from current ones for ever.
  // Refusing these too would make every developer typing `-e job=stability` need a healthy ten-box fleet
  // for a gate that only ever touches ONE named worker -- exactly the over-broad guard that gets routed
  // around until the override is the habit.
  const jobs = captureBearingJobs(CATALOGUE);
  for (const name of ["stability", "gate-stability", "evidence-check", "gate-probe-order"]) {
    assert.ok(!jobs.includes(name), `${name} must not be classified as capture-bearing`);
  }
});

test("an ordinary job the fleet never touches is unaffected", () => {
  const jobs = captureBearingJobs(CATALOGUE);
  for (const name of ["train", "sweep", "rules-gate", "rules-coverage", "promote", "check-signals"]) {
    assert.ok(!jobs.includes(name), `${name} does not touch a worker and must not be gated`);
  }
});

test("the discovery is real, so this cannot pass having examined nothing", () => {
  assert.ok(captureBearingJobs(CATALOGUE).length >= 5,
    "found too few capture-bearing jobs; the indentation scan is broken, not the catalogue empty");
});

test("a renamed setenv key or a re-indented catalogue is refused, not silently read as empty", () => {
  // MUTATION CHECK on the ARTEFACT this derivation depends on, not the doc: rename the fact it looks for,
  // and confirm the scan notices rather than quietly returning zero.
  // RENAME THE FACT, not one spelling of it. This replaced the verbatim `A11Y_WORKERS={{ lab_fleet_workers
  // }}` only, so a job computing its pool FROM the fleet -- `capture-only` slicing it for a `workers` cap --
  // survived the rename and the mutation reported the derivation broken when it was the mutation that was
  // narrow. The derivation keys on the fact appearing inside an `A11Y_WORKERS=` template; so must this.
  const renamed = CATALOGUE.replace(/lab_(fleet|selected)_workers/g, "pool");
  assert.deepEqual(captureBearingJobs(renamed), [],
    "renaming the fact every entry keys on must drop every job, or this scan is reading something else");

  const reindented = CATALOGUE.replace(/\n {6}capture:\n/, "\n        capture:\n");
  assert.ok(!captureBearingJobs(reindented).includes("capture"),
    "re-indenting one job's header must drop it from the set rather than silently keep matching");
});

test("the catalogue boundary markers are load-bearing, and their absence is refused loudly", () => {
  assert.throws(() => captureBearingJobs("no catalogue markers here at all"),
    /could not find lab_jobs/, "an unrecognisable file must throw, not return an empty or partial list");
});

test("a capture-bearing job checks the fleet BEFORE dispatching, with the pool it will actually use", () => {
  const seen: { checked?: unknown[]; dispatched?: unknown[] } = {};
  const order: string[] = [];
  return run(["-e", "job=capture-only", "-e", "only=route-title-stale+"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765", "http://203.0.113.59:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async (expected, workers, options) => {
      order.push("checked");
      seen.checked = [expected, workers, options];
    },
    dispatch: (forwarded) => {
      order.push("dispatched");
      seen.dispatched = forwarded;
    },
  }).then(() => {
    assert.deepEqual(order, ["checked", "dispatched"], "the fleet must be checked before anything dispatches");
    assert.equal(seen.checked?.[0], "deadbeefdeadbeef");
    assert.deepEqual(seen.checked?.[1], ["http://203.0.113.107:8765", "http://203.0.113.59:8765"]);
    assert.equal((seen.checked?.[2] as { when?: string })?.when, "before dispatching to the lab");
    assert.deepEqual(seen.dispatched, ["-e", "job=capture-only", "-e", "only=route-title-stale+"]);
  });
});

test("#1356: with no `workers` given, poolFor resolves the pool from the CONTROL PLANE's own inventory, "
  + "never a checkout's inventory.yml", () => {
  const resolved = poolFor("capture-only", {
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" }] }),
  });
  assert.deepEqual(resolved, { pool: ["http://192.0.2.2:8765"], refusal: null });
});

test("#1356: an explicit `workers` list wins, and the control plane is never asked", () => {
  let called = false;
  const resolved = poolFor("capture-only", {
    workers: ["http://203.0.113.107:8765"],
    readFleet: () => { called = true; return { refusal: null, workers: [] }; },
  });
  assert.deepEqual(resolved, { pool: ["http://203.0.113.107:8765"], refusal: null });
  assert.equal(called, false);
});

test("#1356: a control plane that could not be asked REFUSES in its own words, naming the job -- pure, "
  + "so `run` can exit on it without this test ever touching process.exit", () => {
  const resolved = poolFor("capture-only", {
    readFleet: () => ({ refusal: "no inventory exists at /etc/a11ign/inventory.yml on the control plane", workers: [] }),
  });
  assert.equal(resolved.pool, null);
  assert.match(String(resolved.refusal), /^REFUSING capture-only: could not learn which boxes it will dispatch to -- /);
  assert.match(String(resolved.refusal), /no inventory exists at \/etc\/a11ign\/inventory\.yml/);
});

test("#1356: with no `workers` given, a capture-bearing job's pool comes from the CONTROL PLANE's own "
  + "inventory, never a checkout's inventory.yml -- through run() itself", () => {
  const seen: { checked?: unknown[] } = {};
  return run(["-e", "job=capture-only", "-e", "only=route-title-stale+"], {
    catalogueText: CATALOGUE, expected: "deadbeefdeadbeef",
    readFleet: () => ({ refusal: null, workers: [{ name: "a11y-worker-2", url: "http://192.0.2.2:8765" }] }),
    checkFleet: async (expected, workers, options) => { seen.checked = [expected, workers, options]; },
    dispatch: () => {},
  }).then(() => {
    assert.deepEqual(seen.checked?.[1], ["http://192.0.2.2:8765"]);
    assert.deepEqual((seen.checked?.[2] as { bareMetalUrls?: unknown })?.bareMetalUrls, ["http://192.0.2.2:8765"]);
  });
});

test("a refusing check stops the job from ever reaching dispatch", () => {
  // Simulates what `assertWorkersServe` does for real: it exits the process on refusal, which never
  // returns. A fake that THROWS is the safe proxy for "does not return normally" — real `process.exit`
  // cannot be exercised here without risking the test runner, the same reason worker-code-check.test.ts
  // never calls the exiting function directly.
  let dispatched = false;
  return run(["-e", "job=capture"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async () => { throw new Error("FLEET IS NOT RUNNING THIS CHECKOUT"); },
    dispatch: () => { dispatched = true; },
  }).then(
    () => assert.fail("run() must propagate a refusing check rather than continuing to dispatch"),
    (error: Error) => {
      assert.match(error.message, /FLEET IS NOT RUNNING THIS CHECKOUT/);
      assert.equal(dispatched, false, "dispatch must never run after the check refuses");
    },
  );
});

test("a non-capture-bearing job never checks the fleet at all, and dispatches unaffected", () => {
  let checked = false;
  let dispatched: string[] | undefined;
  return run(["-e", "job=train", "-e", "out=varied"], {
    catalogueText: CATALOGUE,
    workers: [],
    expected: "irrelevant",
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false, "train touches no worker and must never trigger a fleet check");
    assert.deepEqual(dispatched, ["-e", "job=train", "-e", "out=varied"]);
  });
});

test("-e describe=1 skips the fleet check too — nothing is about to run", () => {
  let checked = false;
  return run(["-e", "job=capture", "-e", "describe=1"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async () => { checked = true; },
    dispatch: () => {},
  }).then(() => {
    assert.equal(checked, false,
      "-e describe=1 ends the play before anything runs, so checking ten boxes over HTTP first answers "
      + "nothing the operator asked for");
  });
});

test("--allow-stale-workers reaches the check as `allow: true` and is stripped before dispatch", () => {
  let allow: unknown;
  let dispatched: string[] | undefined;
  return run(["-e", "job=capture", "--allow-stale-workers"], {
    catalogueText: CATALOGUE,
    workers: ["http://203.0.113.107:8765"],
    expected: "deadbeefdeadbeef",
    checkFleet: async (_expected, _workers, options: { allow?: boolean }) => { allow = options.allow; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(allow, true);
    // `ansible-playbook` does not recognise this flag and would refuse the whole command line with it
    // still attached, so it must never reach the forwarded argv.
    assert.deepEqual(dispatched, ["-e", "job=capture"]);
  });
});

test("a non-capture job never reads the real inventory or hashes the worker source", () => {
  // `workers`/`expected` are left undefined in `run`'s defaults deliberately -- resolving either costs a
  // real `inventory.yml` read or a real directory hash, and `train` should not pay for either. Calling
  // this with NEITHER `workers` NOR `expected` supplied proves it: if `run` fell back to computing them
  // eagerly, this would hit the real filesystem/hash unconditionally rather than skip it.
  let checked = false;
  let dispatched: string[] | undefined;
  return run(["-e", "job=train", "-e", "out=varied"], {
    catalogueText: CATALOGUE,
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false);
    assert.deepEqual(dispatched, ["-e", "job=train", "-e", "out=varied"]);
  });
});

test("no -e job= at all runs straight to dispatch — the same as no job was ever passed", () => {
  let checked = false;
  let dispatched: string[] | undefined;
  return run([], {
    catalogueText: CATALOGUE,
    workers: [],
    expected: "irrelevant",
    checkFleet: async () => { checked = true; },
    dispatch: (forwarded) => { dispatched = forwarded; },
  }).then(() => {
    assert.equal(checked, false);
    assert.deepEqual(dispatched, []);
  });
});

test("#1670: the ansible-playbook argv never hardcodes -i, so ansible.cfg's own inventory fallback "
  + "(/etc/a11ign/inventory.yml,inventory.yml) applies", () => {
  // MEASURED 2026-09-17 on the control plane's own persistent checkout: no in-tree
  // packages/control/ansible/inventory.yml (a plain `git pull` deletes it, gitignored) and
  // /etc/a11ign/inventory.yml present and correct. An explicit -i on the command line REPLACES
  // ansible.cfg's `inventory =` setting rather than falling back to it (Ansible's own documented CLI
  // precedence), so a hardcoded `-i packages/control/ansible/inventory.yml` asked for the one copy that
  // checkout did not have and refused "no host matched" even though the durable copy was right there.
  const args = ansiblePlaybookArgs(["-e", "job=train"]);
  assert.ok(!args.includes("-i"),
    "an explicit -i replaces ansible.cfg's inventory fallback list rather than falling back to it -- "
    + "this argv must never carry one");
  assert.deepEqual(args, ["packages/control/ansible/lab-job.yml", "-e", "job=train"],
    "the playbook path and every forwarded arg must still reach ansible-playbook, in order");
});

// ---------------------------------------------------------------------------------------------------------
// #2304: `-e exclude=` leaves a NAMED GROUP of heads out of a train, and is the ONLY way to.
//
// The lever exists so #2258's isolating retrain can be dispatched without editing `rule-ownership.json`
// (who decides a subtype, for every run) or running the trainer over ssh by hand (the hole ADR 0013 closed).
// What these pin is what makes it SAFE to have: a fixed list, no expressible subtype or path, no landing
// in the candidate directory, and a train that names no `exclude` running exactly the argv it always did.
// Text pins run everywhere; the RENDERED ones need ansible-core and skip honestly without it.
// ---------------------------------------------------------------------------------------------------------

/** The text between two anchors of the catalogue, the anchors excluded. Throws rather than return "". */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `could not slice lab-job.yml between ${JSON.stringify(from)} and `
    + `${JSON.stringify(to)}; the catalogue was reshaped and this reads nothing`);
  return text.slice(start + from.length, end);
}

const TRAIN_ENTRY = between(CATALOGUE, "\n      train:\n", "\n      build-realism:\n");
const TRAIN_ARGV = between(TRAIN_ENTRY, "        argv: ", "        timeout:");
const TRAIN_APPEND = TRAIN_ENTRY.match(/argvAppend: "\{\{[\s\S]*?\}\}"/)?.[0] ?? "";
const EXCLUSIONS_BLOCK = "    lab_exclude_flag:" + between(CATALOGUE, "\n    lab_exclude_flag:",
  "\n    # THE SHAPE OF AN `-e only=` VALUE");
const EXCLUDE_ASSERTS = "    - name: A train that leaves a head out names the group" + between(CATALOGUE,
  "\n    - name: A train that leaves a head out names the group",
  "\n    # Same containment, same reason: a NAME from a fixed list, never a path. This one becomes an env var");
const JOB_ARGV_LINE = CATALOGUE.match(/^ {8}job_argv: (".*")$/m)?.[1] ?? "";

/** `name: ['a', 'b']` lines of the exclusion map, as `{ name: [a, b] }`. */
function exclusionGroups(): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const [, name, list] of EXCLUSIONS_BLOCK.matchAll(/^ {6}([a-z][a-z0-9-]*): \[(.*)\]\s*$/gm)) {
    groups[name] = [...list.matchAll(/'([^']+)'/g)].map(([, subtype]) => subtype);
  }
  return groups;
}

test("#2304: the exclusion groups are exactly these, and the flag is the trainer's own", () => {
  // MEMBERSHIP, not a count: two lists can stay the same length while the wrong head moves in.
  assert.deepEqual(exclusionGroups(), { "status-heads": ["4.1.3:status-progress", "4.1.3:status-waiting"] },
    "the groups `-e exclude=` may name changed. Add a group with the reason (which retrain needs it), and "
    + "update this list -- a group is a standing permission to train a model without a head.");
  assert.match(EXCLUSIONS_BLOCK, /^ {4}lab_exclude_flag: '--exclude-subtype='$/m,
    "the flag the job appends is not the one train-screenreader-model.py declares");
});

test("#2304: `exclude` reaches the command ONLY as a key into the fixed map — no subtype or path is expressible", () => {
  // Every read of `exclude` in the train entry, minus the two sanctioned spellings, must leave none. A
  // third spelling (`lab_exclude_flag ~ exclude`) would put the caller's string on the trainer's argv.
  assert.ok(TRAIN_APPEND.includes("lab_train_exclusions[exclude]"),
    "the train job no longer looks `exclude` up in the fixed map");
  const rest = TRAIN_APPEND.replace("lab_train_exclusions[exclude]", "").replace("exclude is defined", "");
  assert.ok(!/\bexclude\b/.test(rest),
    `\`exclude\` is read some other way than as a key of \`lab_train_exclusions\`, so a caller's own string `
    + `could reach the trainer: ${rest}`);
  assert.ok(!/\bexclude\b/.test(TRAIN_ARGV), "`argv` reads `exclude` directly; it may only reach `argvAppend`");
  assert.match(TRAIN_ENTRY, /params: \{out: optional, exclude: optional\}/);
});

test("#2304: the include appends `argvAppend` and nothing else, so run-job.yml still takes one list", () => {
  assert.equal(JOB_ARGV_LINE, '"{{ lab_jobs[job].argv + (lab_jobs[job].argvAppend | default([])) }}"',
    "the include no longer builds job_argv as argv + an OPTIONAL argvAppend");
  assert.equal(CATALOGUE.match(/argvAppend:/g)?.length, 1, "only `train` may carry an argvAppend today");
});

test("#2304: the two refusals are guarded on train + exclude, and say what they check", () => {
  assert.equal(EXCLUDE_ASSERTS.match(/when: job == 'train' and exclude is defined/g)?.length, 2,
    "both refusals must fire for a train that names an exclude, and only for that");
  assert.match(EXCLUDE_ASSERTS, /that: exclude in lab_train_exclusions/, "an unlisted name must be refused");
  assert.match(EXCLUDE_ASSERTS, /- out is defined\s+- out != 'candidate'/,
    "an exclusion must name a scratch directory, and never the candidate's");
});

// ---- the same claims, RENDERED by ansible itself --------------------------------------------------------

const HAS_ANSIBLE = spawnSync("ansible-playbook", ["--version"]).status === 0;
const NO_ANSIBLE = "ansible-playbook is not on PATH -- an honest skip, not a pass. The text pins above still ran.";

/** Dedent `block` by `by` spaces so it can be re-nested at another depth. */
const dedent = (block: string, by: number) => block.split("\n")
  .map((line) => line.startsWith(" ".repeat(by)) ? line.slice(by) : line).join("\n");

type TrainRun = { status: number | null; output: string; base: string[] | null; argv: string[] | null };

/**
 * Runs the REAL train entry, exclusion map, refusal tasks and `job_argv` expression -- all lifted from
 * lab-job.yml byte for byte, so nothing here re-implements them -- under ansible-playbook with `-e job=train`
 * and the given extras. `base` is `argv` alone; `argv` is what the include would hand to run-job.yml.
 */
function runTrain(extras: string[]): TrainRun {
  const dir = mkdtempSync(join(tmpdir(), "lab-train-exclude-"));
  try {
    const out = (name: string) => join(dir, `${name}.json`);
    writeFileSync(join(dir, "vars.yml"), [
      "lab_python: /opt/py",
      dedent(EXCLUSIONS_BLOCK, 4).trimEnd(),
      "lab_jobs:", "  train:", dedent(TRAIN_ENTRY, 4).trimEnd(), "",
    ].join("\n"));
    writeFileSync(join(dir, "play.yml"), [
      "- hosts: localhost", "  gather_facts: false", "  vars:", `    job_argv: ${JOB_ARGV_LINE}`, "  tasks:",
      EXCLUDE_ASSERTS.trimEnd(),
      ...["base", "argv"].flatMap((name) => [
        `    - name: Render ${name}`, "      ansible.builtin.copy:",
        `        content: "{{ ${name === "base" ? "lab_jobs[job].argv" : "job_argv"} | to_json }}"`,
        `        dest: ${out(name)}`]), "",
    ].join("\n"));
    const run = spawnSync("ansible-playbook", ["play.yml", "-e", "@vars.yml", "-e", "job=train", ...extras],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "False" } });
    const read = (name: string): string[] | null => {
      try { return JSON.parse(readFileSync(out(name), "utf8")); } catch { return null; }
    };
    return { status: run.status, output: `${run.stdout}${run.stderr}`, base: read("base"), argv: read("argv") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2304 (rendered): a train with no `exclude` hands run-job.yml exactly `argv`, unchanged",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    for (const extras of [[], ["-e", "out=varied"]]) {
      const run = runTrain(extras);
      assert.equal(run.status, 0, run.output);
      assert.ok(run.base && run.base.length >= 5, "the base argv did not render, so equality below is vacuous");
      assert.deepEqual(run.argv, run.base, `${extras.join(" ") || "no extras"}: argvAppend changed a train that named no exclude`);
      assert.ok(!run.argv?.some((arg) => arg.startsWith("--exclude")), "an exclusion flag appeared unasked");
    }
  });

test("#2304 (rendered): `exclude=status-heads` appends one flag per subtype after argv, and nothing else",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    const run = runTrain(["-e", "exclude=status-heads", "-e", "out=scratch"]);
    assert.equal(run.status, 0, run.output);
    assert.ok(run.base && run.argv);
    assert.deepEqual(run.argv, [...run.base,
      "--exclude-subtype=4.1.3:status-progress", "--exclude-subtype=4.1.3:status-waiting"]);
    assert.match(run.base[run.base.indexOf("--output") + 1], /model-scratch$/, "`out` no longer names the directory");
  });

test("#2304 (rendered): an unlisted name, a subtype, a path, no `out`, and `out=candidate` are each REFUSED",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    const refused: Array<[string[], RegExp]> = [
      [["-e", "exclude=nope", "-e", "out=scratch"], /must be one of: status-heads/],
      [["-e", "exclude=4.1.3:status-progress", "-e", "out=scratch"], /must be one of: status-heads/],
      [["-e", "exclude=../../etc", "-e", "out=scratch"], /must be one of: status-heads/],
      [["-e", "exclude=status-heads"], /needs an explicit -e out=/],
      [["-e", "exclude=status-heads", "-e", "out=candidate"], /needs an explicit -e out=/],
    ];
    for (const [extras, message] of refused) {
      const run = runTrain(extras);
      assert.notEqual(run.status, 0, `${extras.join(" ")} was accepted`);
      assert.match(run.output, message, `${extras.join(" ")} was refused for the wrong reason`);
      assert.equal(run.argv, null, `${extras.join(" ")} rendered an argv after being refused`);
    }
  });

// ---------------------------------------------------------------------------------------------------------
// #2334: `explain-case` -- what did the model see on ONE held-out acceptance case?
//
// It is read-only and takes two parameters from the wire, `case` and `out`, and the containment is the point:
// `case` reaches the command only as `--case=<value>` and only after `lab_case_id_shape` has matched it, and
// `out` is a NAME from the list `acceptance` already uses. So neither a path nor a flag is expressible.
// Text pins run everywhere; the RENDERED ones need ansible-core and skip honestly without it.
// ---------------------------------------------------------------------------------------------------------

const EXPLAIN_CASE_ENTRY = between(CATALOGUE, "\n      explain-case:\n", "\n      rules-coverage:\n");
const CASE_ASSERT = "    - name: An explain-case job names case ids and nothing else" + between(CATALOGUE,
  "\n    - name: An explain-case job names case ids and nothing else",
  "\n    - name: An explain-case criterion is a dotted WCAG number");
const CRITERION_ASSERT = "    - name: An explain-case criterion is a dotted WCAG number" + between(CATALOGUE,
  "\n    - name: An explain-case criterion is a dotted WCAG number",
  "\n    - name: A train job names its scratch output from a fixed list");
const OUT_ASSERT = "    - name: A train job names its scratch output from a fixed list" + between(CATALOGUE,
  "\n    - name: A train job names its scratch output from a fixed list",
  "\n    - name: A train that leaves a head out names the group from a fixed list");
const CASE_SHAPE_LINE = CATALOGUE.match(/^ {4}lab_case_id_shape: (.*)$/m)?.[1] ?? "";
const CRITERION_SHAPE_LINE = CATALOGUE.match(/^ {4}lab_criterion_shape: (.*)$/m)?.[1] ?? "";

const jobsOf = () => (parseYaml(CATALOGUE) as Array<{ vars?: { lab_jobs?: Record<string, { argv: string[]; params?: unknown }> } }>)
  .flatMap((play) => (play.vars?.lab_jobs ? [play.vars.lab_jobs] : []))[0];

test("#2334/#2386: `explain-case` takes `case` (required), `out` and `criterion` (optional), and runs `scorer:explain --case=`", () => {
  const job = jobsOf()["explain-case"];
  assert.ok(job, "the catalogue has no `explain-case` job, so #2258 cannot read a held-out case's features");
  assert.deepEqual(job.params, { case: "required", out: "optional", criterion: "optional" });
  // A templated LIST, because the flag is appended or absent (`prune-orphan-captures`' form); what it renders is
  // pinned below, against the list this entry was before `criterion` existed.
  assert.equal(typeof job.argv, "string");
  assert.match(job.argv as unknown as string, /\['\/usr\/bin\/npm', 'run', '--silent', 'scorer:explain', '--',\s+'--model=' ~ \(out \| default\('candidate'\)\), '--case=' ~ case\]/);
  assert.match(job.argv as unknown as string, /\+ \(\['--criterion=' ~ criterion\] if criterion is defined else \[\]\)/);
});

test("#2334: `case` reaches the argv ONLY as the value of `--case=`, and is asserted against the shared shape", () => {
  // A second spelling of `case` on the argv (`{{ case }}` bare, or joined into a path) would put the caller's
  // string somewhere the shape was not written to contain.
  const argvTemplate = EXPLAIN_CASE_ENTRY.slice(EXPLAIN_CASE_ENTRY.indexOf("argv:"));
  assert.equal(argvTemplate.match(/~ case\b/g)?.length, 1, "`case` is interpolated more than once");
  assert.match(argvTemplate, /'--case=' ~ case\]/);
  assert.match(CASE_ASSERT, /when: job == 'explain-case'/);
  assert.match(CASE_ASSERT, /case is match\(lab_case_id_shape\)/,
    "`case` is not contained by the shape `capture-only` uses");
  assert.match(OUT_ASSERT, /job in \[[^\]]*'explain-case'[^\]]*\]/, "`out` for explain-case is not from the fixed list");
});

test("#2334: no existing job's argv changed -- the neighbours that share its asserts render what they always did", () => {
  const jobs = jobsOf();
  assert.deepEqual(jobs["explain-feature"].argv, ["/usr/bin/npm", "run", "--silent", "scorer:explain-feature", "--",
    "--subtype", "{{ subtype }}", "--feature", "{{ feature }}"]);
  // The three that read `out` beside it, through the assert whose `when` list gained a member.
  assert.ok(jobs.acceptance.argv.at(-1)?.endsWith("model-{{ out | default('candidate') }}/acceptance-report.json"));
  assert.equal(jobs.acceptance.argv[0], "{{ lab_python }}");
  assert.deepEqual(jobs["capture-only"].params, { only: "required", workers: "optional", capture_root: "optional" });
  // The one the row added is the only one that reaches the case reader; nothing else grew a `--case=`.
  const withCase = Object.entries(jobs).filter(([, job]) => JSON.stringify(job.argv).includes("--case="));
  assert.deepEqual(withCase.map(([name]) => name), ["explain-case"]);
  // #2386: likewise the only job that reaches `--criterion=`, and only through the shape-asserted parameter.
  const withCriterion = Object.entries(jobs).filter(([, job]) => JSON.stringify(job.argv).includes("--criterion="));
  assert.deepEqual(withCriterion.map(([name]) => name), ["explain-case"]);
});

test("#2386: `criterion` is asserted against the dotted-WCAG shape, and only when it was supplied", () => {
  assert.equal(CRITERION_SHAPE_LINE, "'^[1-4][.][0-9]{1,2}[.][0-9]{1,2}$'");
  assert.match(CRITERION_ASSERT, /when: job == 'explain-case' and criterion is defined/);
  assert.match(CRITERION_ASSERT, /criterion is match\(lab_criterion_shape\)/);
  assert.match(CRITERION_ASSERT, /lab_criterion_shape/, "the refusal does not name the shape");
});

/** Renders the REAL entry and the REAL two asserts under ansible-playbook, the shape `runTrain` uses. */
function runExplainCase(extras: string[]): { status: number | null; output: string; argv: string[] | null } {
  const dir = mkdtempSync(join(tmpdir(), "lab-explain-case-"));
  try {
    const dest = join(dir, "argv.json");
    writeFileSync(join(dir, "vars.yml"), [
      `lab_case_id_shape: ${CASE_SHAPE_LINE}`, `lab_criterion_shape: ${CRITERION_SHAPE_LINE}`,
      "lab_jobs:", "  explain-case:", dedent(EXPLAIN_CASE_ENTRY, 4).trimEnd(), "",
    ].join("\n"));
    writeFileSync(join(dir, "play.yml"), [
      "- hosts: localhost", "  gather_facts: false", "  tasks:", CASE_ASSERT.trimEnd(), CRITERION_ASSERT.trimEnd(), OUT_ASSERT.trimEnd(),
      "    - name: Render argv", "      ansible.builtin.copy:",
      "        content: \"{{ lab_jobs[job].argv | to_json }}\"", `        dest: ${dest}`, "",
    ].join("\n"));
    const run = spawnSync("ansible-playbook", ["play.yml", "-e", "@vars.yml", "-e", "job=explain-case", ...extras],
      { cwd: dir, encoding: "utf8", env: { ...process.env, ANSIBLE_LOCALHOST_WARNING: "False" } });
    let argv: string[] | null = null;
    try { argv = JSON.parse(readFileSync(dest, "utf8")); } catch { argv = null; }
    return { status: run.status, output: `${run.stdout}${run.stderr}`, argv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("#2334 (rendered): a well-formed case id, or a comma-separated list, renders `--model=` and `--case=` and nothing else",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    const one = runExplainCase(["-e", "case=acceptance-b3-status-taxi"]);
    assert.equal(one.status, 0, one.output);
    assert.deepEqual(one.argv?.slice(-2), ["--model=candidate", "--case=acceptance-b3-status-taxi"]);
    const many = runExplainCase(["-e", "case=a-one,b.two,c+", "-e", "out=scratch"]);
    assert.equal(many.status, 0, many.output);
    assert.deepEqual(many.argv?.slice(-2), ["--model=scratch", "--case=a-one,b.two,c+"]);
  });

test("#2386 (rendered): with `criterion` unset the argv is byte-identical to what it was before the parameter existed",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    const before = ["/usr/bin/npm", "run", "--silent", "scorer:explain", "--", "--model=candidate",
      "--case=acceptance-b3-sections-tree"];
    const run = runExplainCase(["-e", "case=acceptance-b3-sections-tree"]);
    assert.equal(run.status, 0, run.output);
    assert.equal(JSON.stringify(run.argv), JSON.stringify(before));
    const named = runExplainCase(["-e", "case=acceptance-b3-sections-tree", "-e", "out=scratch"]);
    assert.equal(JSON.stringify(named.argv), JSON.stringify([...before.slice(0, 5), "--model=scratch", before[6]]));
  });

test("#2386 (rendered): `criterion` set appends `--criterion=<X>` after `--case=`, and nothing else moves",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    const run = runExplainCase(["-e", "case=acceptance-b3-sections-tree", "-e", "criterion=4.1.3"]);
    assert.equal(run.status, 0, run.output);
    assert.deepEqual(run.argv, ["/usr/bin/npm", "run", "--silent", "scorer:explain", "--", "--model=candidate",
      "--case=acceptance-b3-sections-tree", "--criterion=4.1.3"]);
  });

test("#2386 (rendered): a `criterion` that is not a dotted WCAG number is REFUSED, naming the shape",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    // JSON extra vars for the same reason as the case refusals: `criterion=a b` would be split on the space.
    const refused = ["../../etc", "--model=x", "4.1", "4.1.3.1", "5.1.1", "0.1.1", "4.1.a", "4.1.3 ", " 4.1.3",
      "4.1.3\n--x", "", "4.100.3", "$(id)", "4.1.3;id"];
    for (const value of refused) {
      const run = runExplainCase(["-e", "case=ok-case", "-e", JSON.stringify({ criterion: value })]);
      assert.notEqual(run.status, 0, `criterion ${JSON.stringify(value)} was accepted`);
      assert.match(run.output, /must be a dotted WCAG number/, `${JSON.stringify(value)} was refused for the wrong reason`);
      assert.equal(run.argv, null, `${JSON.stringify(value)} rendered an argv after being refused`);
    }
  });

test("#2334 (rendered): a malformed case, a path, a flag, no case, and an unlisted `out` are each REFUSED",
  { skip: HAS_ANSIBLE ? undefined : NO_ANSIBLE }, () => {
    // JSON extra vars, not `case=<value>`: ansible splits a key=value string on whitespace, so `case=a b` would
    // reach the shape as `a` with a stray word beside it and the space would never be tested at all.
    const withCase = (value: string) => ["-e", JSON.stringify({ case: value })];
    const shape = /explain-case needs -e case=/;
    const refused: Array<[string[], RegExp]> = [
      ...["../../etc/passwd", "/runs/model-candidate", "--model=x", "a b", "a;rm -rf /", "Upper", "a,,b",
        "acceptance-b3-status-taxi/bad", "", "$(id)"].map((value): [string[], RegExp] => [withCase(value), shape]),
      [[], shape],
      [[...withCase("ok-case"), "-e", "out=../../etc"], /must be one of: candidate, multidefect, varied, scratch/],
    ];
    for (const [extras, message] of refused) {
      const run = runExplainCase(extras);
      assert.notEqual(run.status, 0, `${extras.join(" ") || "(no case)"} was accepted`);
      assert.match(run.output, message, `${extras.join(" ")} was refused for the wrong reason`);
      assert.equal(run.argv, null, `${extras.join(" ")} rendered an argv after being refused`);
    }
  });
