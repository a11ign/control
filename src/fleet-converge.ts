// @ts-check
/**
 * One scripted run that wakes the fleet, deploys and provisions it, and reports ONE result (a11ign#5023, #4405 item 5).
 *
 *     node packages/control/src/fleet-converge.ts [--apply] [--row=<n>]
 *
 * WHY IT EXISTS. Eight hand-run provision attempts in a standing seat (a11ign#4948) lost boxes to auto-off between
 * attempts and to a re-enabled Edge updater. Neither cause needs a model, so a model must not be what retries them:
 * the run retries the two KNOWN causes, a bounded number of times, and wakes the orchestrator for anything else.
 *
 * ```
 * layer refs -> lock (operation `wake`) -> wake -> deploy.yml -> provision-role.yml -> fleet:status -> end lock
 * ```
 *
 * THE LOCK IS TAKEN AS `wake`, AND ONLY `wake` WORKS (a11ign#5030). `fleet-lock.ts` refuses a fresh, unended lock of a
 * DIFFERENT operation, so a lock under this run's own name would refuse the run's own `deploy` step. `lockTakeStep`
 * takes a `wake` lock OVER; any other name is refused, and `fleet-converge.test.ts` holds both readings.
 *
 * KNOWN CAUSES ARE NAMED PATTERNS, AND ANYTHING ELSE IS `unknown`. Each is a regexp over the play's own output with the
 * real line it matches beside it (a11ign#4948), never a guess, and each has a cap of `ATTEMPTS_PER_BOX` attempts. A
 * cause is retried only when EVERY failing box of that attempt has a known cause: one unknown box stops the run,
 * because retrying the others would bury it.
 *
 * THE PLAYS ARE SUBPROCESSES. `fleet-playbook.ts` can be imported (its `main` is guarded), but `main` reads
 * `process.argv` and ends in `process.exit`, so there is no function to call: the run starts it as `deploy:` and
 * `provision:` do and reads the recap from its output. The runner is injected, so a test supplies the plays.
 *
 * NO LIVE RUN IS THIS FILE'S: the VERIFY row runs it. Without `--apply` it only reads (the layer refs and the
 * inventory) and prints the plan, taking no lock and sending no packet.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { refuseUnknownFlags } from "../../worker-fleet/src/cli-flags.ts";
import { sandboxGitEnv } from "../../worker-fleet/src/git-safe-env.ts";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.ts";
import { inventoryPathFor, sshToControlPlane } from "./control-plane-fleet.ts";
import { inventoryHosts } from "./fleet-discover.ts";
import { expireFleetLock, LOCK_GRACE_MS, takeFleetLock } from "./fleet-lock.ts";
import {
  HEALTH_TIMEOUT_MS, WAKE_DEADLINE_MS, WAKE_LOCK_OPERATION, wakeFailed, wakeFleet, wakeReportLine,
  type WakeResult, type WakeTarget,
} from "./fleet-wake.ts";
import { layerDeclaration, separateLayers } from "./layer-checkouts.ts";

refuseUnknownFlags(["--apply", "--row="], { entry: import.meta.url, command: "node packages/control/src/fleet-converge.ts" });

/** The cap per box, per step (the row's number). Three is one try and two retries: a cause that survives two retries is not transient. */
export const ATTEMPTS_PER_BOX = 3;

/** Where the one result is written, relative to the working directory, as `runs/fleet-wake-proof.json` is. */
export const RESULT_PATH = "runs/fleet-converge-last-run.json";

/**
 * HOW LONG THE `wake` LOCK STANDS BEFORE A PLAY TAKES IT OVER: the wake step's own worst case (a bounded wait and one
 * probe, `ATTEMPTS_PER_BOX` times) plus the grace an ended lock gives. A JUDGMENT, not a measurement. It is short on
 * purpose: each play re-takes the lock for ITS OWN longest run (`PLAYBOOK_TIMEOUT_MS`), so a crashed run cannot keep
 * fifteen boxes powered for the sum of every attempt.
 */
export const WAKE_LOCK_RUN_MS = ATTEMPTS_PER_BOX * (WAKE_DEADLINE_MS + HEALTH_TIMEOUT_MS) + LOCK_GRACE_MS;

export const KNOWN_CAUSES = ["unreachable", "edge-updater-ready"] as const;
export type Cause = (typeof KNOWN_CAUSES)[number] | "unknown";
export type BoxFailure = { box: string; cause: Cause; evidence: string };

/** A box no line of the output names: the failure is the PLAY's (a refusal, a nonzero exit with no recap). */
export const WHOLE_FLEET = "*";

// ---------------------------------------------------------------------------------------------------------------------
// The cause patterns. Each real line is from a11ign#4948's comments, `orchestrator`, 2026-10-11T11:34Z, or ansible's own
// grammar for the first.
// ---------------------------------------------------------------------------------------------------------------------

const TASK_LINE = /^TASK \[(.*?)\] \*+\s*$/;
/** `fatal: [a11y-worker-3]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: ...", "unreachable": true}` */
const FATAL_LINE = /^fatal: \[([^\]]+)\]: (UNREACHABLE|FAILED)!/;
/** `a11y-worker-3              : ok=87   changed=3    unreachable=1    failed=0    skipped=2    rescued=0    ignored=0` */
const RECAP_LINE = /^(\S+)\s*:\s+ok=\d+\s+changed=\d+\s+unreachable=(\d+)\s+failed=(\d+)/;
/** The task: `worker : Refuse to call this provisioned unless Edge is the pinned build and the updater is off` */
const UPDATER_GUARD_TASK = /unless Edge is the pinned build and the updater is off/;
/** Its message on worker-3: `scheduled task MicrosoftEdgeUpdateTaskMachineCore is Ready, expected Disabled`. */
const UPDATER_READY = /scheduled task MicrosoftEdgeUpdate\w* is Ready, expected Disabled/;
/** The guard's OTHER finding, `Edge is 152.0.4191.66, expected 155.0.4283.45`: a wrong build is not the updater, and a retry would not move it. */
const EDGE_NOT_PINNED = /\bEdge is \S+, expected\b/;
const BLOCK_END = /^(TASK \[|PLAY \[|PLAY RECAP|NO MORE HOSTS|fatal: \[)/;

type Fatal = { box: string; kind: string; task: string; text: string; ignored: boolean };

/** Every `fatal:` with the task it was under and the lines that belong to it, up to the next task, play or fatal. */
function fatalBlocks(lines: string[]): Fatal[] {
  const found: Fatal[] = [];
  let task = "";
  lines.forEach((line, index) => {
    const taskMatch = TASK_LINE.exec(line);
    if (taskMatch) task = taskMatch[1];
    const fatal = FATAL_LINE.exec(line);
    if (!fatal) return;
    let end = index + 1;
    while (end < lines.length && !BLOCK_END.test(lines[end])) end += 1;
    const block = lines.slice(index, end);
    // `...ignoring` is ansible's word for a failure the play itself carried on past (`ignore_errors`).
    found.push({ box: fatal[1], kind: fatal[2], task, text: block.join("\n"), ignored: block.some((l) => l.trim() === "...ignoring") });
  });
  return found;
}

function causeOf(fatal: Fatal): Cause {
  if (fatal.kind === "UNREACHABLE") return "unreachable";
  const updater = UPDATER_GUARD_TASK.test(fatal.task) && UPDATER_READY.test(fatal.text) && !EDGE_NOT_PINNED.test(fatal.text);
  return updater ? "edge-updater-ready" : "unknown";
}

const firstLine = (text: string) => text.split("\n")[0].slice(0, 240);

/**
 * What failed in a play's output, per box. The `fatal:` lines carry the cause; a recap line with a failure count and no
 * `fatal:` (output that was cut, a `-v` form this does not read) falls back to what its counts say: `unreachable` is
 * the cause that count names, and a bare `failed` count is `unknown`, never a guess at WHY.
 */
export function failuresIn(output: string): BoxFailure[] {
  const lines = output.split(/\r?\n/);
  const failures: BoxFailure[] = fatalBlocks(lines).filter((f) => !f.ignored)
    .map((f) => ({ box: f.box, cause: causeOf(f), evidence: firstLine(f.text) }));
  const named = new Set(failures.map((f) => f.box));
  for (const line of lines) {
    const recap = RECAP_LINE.exec(line);
    if (!recap || named.has(recap[1])) continue;
    if (Number(recap[2]) > 0) failures.push({ box: recap[1], cause: "unreachable", evidence: line.trim() });
    else if (Number(recap[3]) > 0) failures.push({ box: recap[1], cause: "unknown", evidence: line.trim() });
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// The layer refs.
// ---------------------------------------------------------------------------------------------------------------------

/** A tag as `lab-layer-checkouts.yml` and `laidJudgement` hold a `.layer-ref` to it: a plain name, no glob, no `..`, no leading dash. */
const LAID_TAG = /^[A-Za-z0-9@][A-Za-z0-9._/@+-]{0,99}$/;

export type LayerToPin = { name: string; remote: string; laidAt: string };
export type TagCommit = string | undefined | { failed: string };

/**
 * The `--layer-ref=<layer>=<sha>` pair `fleet:deploy` and `fleet:provision` refuse without, from the tag each layer is
 * LAID at on the control plane (its `.layer-ref`), resolved to the commit that tag names on the layer's remote. Those are
 * the commits the control plane's own move check accepts for a laid layer (`laidJudgement`), which is why they are read
 * there and not guessed from a branch head: the orchestrator's run on a11ign#4948 passed tag commits that were on no head.
 * Every layer that cannot be pinned is named in ONE refusal, with its tag and its remote.
 */
export function resolveLayerRefs({ layers, readLaidTag, commitOfTag }: {
  layers: LayerToPin[];
  readLaidTag: (layer: LayerToPin) => string;
  commitOfTag: (call: { remote: string; tag: string }) => TagCommit;
}): { refs: Record<string, string> } | { refusal: string } {
  const refs: Record<string, string> = {};
  const problems: string[] = [];
  for (const layer of layers) {
    const problem = pinOne({ layer, readLaidTag, commitOfTag, refs });
    if (problem) problems.push(problem);
  }
  if (layers.length === 0) problems.push("layers.json declares no layer with a repository of its own, so there is nothing to pin: refusing rather than passing an empty pair");
  return problems.length ? { refusal: `${problems.join("; ")}. Nothing was woken, deployed or provisioned: a layer ref is never guessed.` } : { refs };
}

function pinOne({ layer, readLaidTag, commitOfTag, refs }: {
  layer: LayerToPin; readLaidTag: (layer: LayerToPin) => string;
  commitOfTag: (call: { remote: string; tag: string }) => TagCommit; refs: Record<string, string>;
}): string | null {
  let tag: string;
  try {
    tag = readLaidTag(layer).trim();
  } catch (cause) {
    return `layer ${layer.name}: its laid tag could not be read at ${layer.laidAt} (${cause instanceof Error ? cause.message : String(cause)})`;
  }
  if (!LAID_TAG.test(tag) || tag.includes("..")) return `layer ${layer.name}: ${layer.laidAt} holds ${JSON.stringify(tag.slice(0, 60))}, which is not a tag`;
  const commit = commitOfTag({ remote: layer.remote, tag });
  if (typeof commit === "string") {
    refs[layer.name] = commit;
    return null;
  }
  if (commit === undefined) return `layer ${layer.name} is laid at ${tag}, and ${layer.remote} holds no such tag`;
  return `layer ${layer.name}: ${layer.remote} could not be asked for ${tag} (${commit.failed})`;
}

/** The commit a tag names on `remote`: the peeled one for an annotated tag, else the tag's own; `undefined` is "no such tag", `{ failed }` is git not answering. */
export function gitCommitOfTag({ remote, tag }: { remote: string; tag: string }): TagCommit {
  const answer = spawnSync("git", ["ls-remote", "--tags", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: "utf8", env: sandboxGitEnv() });
  if (answer.status !== 0) return { failed: String(answer.stderr).trim() || `git ls-remote exited ${answer.status}` };
  const refs = new Map(String(answer.stdout).split("\n").filter(Boolean).map((line) => line.split("\t").reverse() as [string, string]));
  const commit = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  return commit !== undefined && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

/** The layers a guest holds as a second checkout, each with where the control plane has it laid. */
export function layersToPin(): LayerToPin[] {
  return separateLayers().map((name) => {
    const declared = layerDeclaration(name);
    return { name, remote: declared.remote ?? "", laidAt: `${CONTROL_PLANE_CHECKOUT_PATH}/${declared.path}/.layer-ref` };
  });
}

/** The tag text at `layer.laidAt` on the control plane (locally when this IS the control plane). The path is held to a plain absolute one first: it reaches a remote shell. */
export function readLaidTagOnControlPlane(layer: LayerToPin): string {
  if (!/^\/[\w./-]+$/.test(layer.laidAt)) throw new Error(`not a plain absolute path: ${layer.laidAt}`);
  return sshToControlPlane(`cat '${layer.laidAt}'`, { capture: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------------------------------------------------

export type PlayRun = { status: number; output: string };
export type PlayRequest = { script: "fleet-playbook.ts" | "fleet-status.ts"; args: string[] };
export type RunStatus = "ok" | "failed" | "unknown";
export type BoxRecord = { causes: Cause[]; attempts: number };
export type StepRecord = { step: string; outcome: "ok" | RunStatus; attempts: number; note?: string };
export type ConvergeResult = {
  status: RunStatus; reason?: string; perBox: Record<string, BoxRecord>; steps: StepRecord[];
  layerRefs: Record<string, string>; startedAt: string; finishedAt: string; fleetStatus?: string; warnings: string[];
};

export type Effects = {
  now: () => number;
  take: typeof takeFleetLock;
  end: typeof expireFleetLock;
  wake: (targets: WakeTarget[]) => Promise<WakeResult[]>;
  runPlay: (request: PlayRequest) => Promise<PlayRun>;
  log: (line: string) => void;
  /** The ONE call that wakes the orchestrator; returns what went wrong, or null. Never retried. */
  notify: (message: string) => string | null;
  /** Post the result once on a row; returns what went wrong, or null. */
  post: (row: number, body: string) => string | null;
  /** Write the one result file; throws on failure. */
  save: (result: ConvergeResult) => void;
};

type StepOutcome = { ok: true; note?: string } | { ok: false; status: "failed" | "unknown"; reason: string };
type Run = {
  workers: WakeTarget[]; layerRefs: Record<string, string>; effects: Effects;
  perBox: Map<string, BoxRecord>; attempts: Map<string, number>; steps: StepRecord[]; fleetStatus?: string;
};

/** One failure of `box` at `step`: the cause is kept on the box, and the attempt counted against the cap for THAT step. */
function recordFailure({ run, step, box, cause }: { run: Run; step: string; box: string; cause: Cause }): number {
  const record = run.perBox.get(box) ?? { causes: [], attempts: 1 };
  if (!record.causes.includes(cause)) record.causes.push(cause);
  const key = `${step}|${box}`;
  const count = (run.attempts.get(key) ?? 0) + 1;
  run.attempts.set(key, count);
  // Attempts made: the failures so far, plus the one that is coming, so a box that failed once and then passed reads 2.
  record.attempts = Math.max(record.attempts, count + 1);
  run.perBox.set(box, record);
  return count;
}

/** Wake `targets`, and any that did not come up again, up to the cap: a `wakeFleet` result that is not ready is the `unreachable` cause. */
async function wakeUntilUp({ run, step, targets }: { run: Run; step: string; targets: WakeTarget[] }): Promise<{ stillDown: string[] }> {
  let pending = targets;
  for (let attempt = 1; attempt <= ATTEMPTS_PER_BOX && pending.length > 0; attempt += 1) {
    const results = await run.effects.wake(pending);
    for (const result of results) run.effects.log(wakeReportLine(result));
    const down = new Set(results.filter(wakeFailed).map((r) => r.name));
    for (const name of down) recordFailure({ run, step, box: name, cause: "unreachable" });
    pending = pending.filter((w) => down.has(w.name));
  }
  return { stillDown: pending.map((w) => w.name) };
}

async function wakeStep(run: Run): Promise<StepOutcome> {
  const { stillDown } = await wakeUntilUp({ run, step: "wake", targets: run.workers });
  if (stillDown.length === 0) return { ok: true };
  return { ok: false, status: "failed", reason: `${stillDown.join(", ")} did not come up in ${ATTEMPTS_PER_BOX} wakes (unreachable)` };
}

const layerRefArgs = (refs: Record<string, string>) => Object.entries(refs).map(([name, sha]) => `--layer-ref=${name}=${sha}`);

/**
 * What to do with a play's failures. Unknown stops the run; a known cause that reached its cap ends it `failed`; an
 * `unreachable` box is woken again first, and one that will not wake ends it `failed` without spending the retries.
 */
async function recover({ run, step, failures }: { run: Run; step: string; failures: BoxFailure[] }): Promise<StepOutcome | null> {
  const unknown = failures.filter((f) => f.cause === "unknown");
  for (const f of failures) recordFailure({ run, step, box: f.box, cause: f.cause });
  if (unknown.length > 0) {
    return { ok: false, status: "unknown", reason: `${step} failed on ${unknown.map((f) => f.box).join(", ")} with no known cause: ${unknown[0].evidence}` };
  }
  const exhausted = failures.filter((f) => (run.attempts.get(`${step}|${f.box}`) ?? 0) >= ATTEMPTS_PER_BOX);
  if (exhausted.length > 0) {
    return { ok: false, status: "failed", reason: `${step}: ${exhausted.map((f) => `${f.box} (${f.cause})`).join(", ")} still failing after ${ATTEMPTS_PER_BOX} attempts` };
  }
  const unreachable = failures.filter((f) => f.cause === "unreachable").map((f) => f.box);
  const targets = run.workers.filter((w) => unreachable.includes(w.name));
  if (targets.length === 0) return null;
  // `recoverStep` is not the play's step, so the wake's failures do not spend the play's cap a second time.
  const { stillDown } = await wakeUntilUp({ run, step: `${step}:rewake`, targets });
  return stillDown.length === 0 ? null
    : { ok: false, status: "failed", reason: `${step}: ${stillDown.join(", ")} unreachable and would not wake again` };
}

async function playStep({ run, step, playbook, extra = [] }: { run: Run; step: string; playbook: string; extra?: string[] }): Promise<StepOutcome> {
  const args = [`--playbook=${playbook}`, ...extra, ...layerRefArgs(run.layerRefs)];
  for (;;) {
    const played = await run.effects.runPlay({ script: "fleet-playbook.ts", args });
    if (played.status === 0) return { ok: true };
    const found = failuresIn(played.output);
    const failures = found.length > 0 ? found : [{ box: WHOLE_FLEET, cause: "unknown" as Cause,
      evidence: `${step} exited ${played.status} and its output names no failed box: ${lastLine(played.output)}` }];
    const stop = await recover({ run, step, failures });
    if (stop) return stop;
    run.effects.log(`  ${step}: ${failures.map((f) => `${f.box} ${f.cause}`).join(", ")} -- retrying (attempt cap ${ATTEMPTS_PER_BOX} per box)`);
  }
}

/** The line that says why a play stopped: its own `REFUSING` line when it has one (it is not the last), else the last line it printed. */
const lastLine = (text: string) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /^(REFUSING|refusing)/.test(l)) ?? lines.at(-1) ?? "(no output)").slice(0, 240);
};

/** `fleet:status`, read once at the end: it is the run's reading, not a gate, and exits non-zero only when no box answers. */
async function statusStep(run: Run): Promise<StepOutcome> {
  const read = await run.effects.runPlay({ script: "fleet-status.ts", args: [] });
  run.fleetStatus = read.output.split("\n").slice(-30).join("\n");
  if (read.status === 0) return { ok: true };
  return { ok: false, status: "unknown", reason: `fleet:status exited ${read.status}: ${lastLine(read.output)}` };
}

async function sequence(run: Run): Promise<StepOutcome> {
  const steps: Array<[string, () => Promise<StepOutcome>]> = [
    ["wake", () => wakeStep(run)],
    ["deploy", () => playStep({ run, step: "deploy", playbook: "deploy.yml" })],
    // `--serial=0`: `provisionRevision` is a MUST_MATCH cache key, so all at once is right here (control CLAUDE.md).
    ["provision", () => playStep({ run, step: "provision", playbook: "provision-role.yml", extra: ["--serial=0"] })],
    ["status", () => statusStep(run)],
  ];
  for (const [name, go] of steps) {
    const outcome = await go();
    run.steps.push({ step: name, outcome: outcome.ok ? "ok" : outcome.status, attempts: 1, ...(outcome.ok ? {} : { note: outcome.reason }) });
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

function resultOf({ run, outcome, startedAt, warnings }: { run: Run; outcome: StepOutcome; startedAt: number; warnings: string[] }): ConvergeResult {
  return {
    status: outcome.ok ? "ok" : outcome.status, ...(outcome.ok ? {} : { reason: outcome.reason }),
    perBox: Object.fromEntries(run.perBox), steps: run.steps, layerRefs: run.layerRefs,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(run.effects.now()).toISOString(),
    ...(run.fleetStatus === undefined ? {} : { fleetStatus: run.fleetStatus }), warnings,
  };
}

/**
 * The run. THE LOCK IS TAKEN BEFORE THE FIRST STEP AND ENDED ON EVERY EXIT, a thrown error included, as operation `wake`
 * (see the header). A lock another operation holds, or a control plane that cannot be asked, is `unknown` and wakes
 * nobody's boxes: a run auto-off may power the boxes out from under is not started.
 */
export async function converge({ workers, layerRefs, effects }: { workers: WakeTarget[]; layerRefs: Record<string, string>; effects: Effects }): Promise<ConvergeResult> {
  const startedAt = effects.now();
  const run: Run = { workers, layerRefs, effects, perBox: new Map(workers.map((w) => [w.name, { causes: [], attempts: 1 }])), attempts: new Map(), steps: [] };
  const warnings: string[] = [];
  let taken = false;
  let outcome: StepOutcome;
  try {
    const lock = effects.take({ operation: WAKE_LOCK_OPERATION, longestRunMs: WAKE_LOCK_RUN_MS, now: startedAt });
    if (lock.taken) {
      taken = true;
      outcome = await sequence(run);
    } else {
      outcome = { ok: false, status: "unknown", reason: `the fleet lock is held by ${lock.held.operation} (${lock.held.holder}) and that operation has not ended: this run did not start` };
    }
  } catch (cause) {
    outcome = { ok: false, status: "unknown", reason: `the run threw: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (taken) warnings.push(...endLock(effects));
  return resultOf({ run, outcome, startedAt, warnings });
}

/** Shorten the lock if it is still ours. A play that took it over ended it under ITS name, so `ended: false` is right and nothing is shortened. */
function endLock(effects: Effects): string[] {
  try {
    const ended = effects.end({ operation: WAKE_LOCK_OPERATION, now: effects.now() });
    effects.log(ended.ended ? "  fleet lock (wake) shortened" : "  fleet lock: a play took it over, and its own end stands");
    return [];
  } catch (cause) {
    return [`the fleet lock was not shortened (${cause instanceof Error ? cause.message : String(cause)}): it expires on its own`];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The report, the waking, the row.
// ---------------------------------------------------------------------------------------------------------------------

/** One printed recap: the status, why, and a line per box that was not clean on the first try. */
export function recapOf(result: ConvergeResult): string {
  const boxes = Object.entries(result.perBox);
  const lines = [`fleet-converge: ${result.status.toUpperCase()}${result.reason ? ` -- ${result.reason}` : ""}`];
  for (const step of result.steps) lines.push(`  ${step.step.padEnd(10)} ${step.outcome}${step.note ? ` (${step.note})` : ""}`);
  const touched = boxes.filter(([, record]) => record.causes.length > 0);
  for (const [name, record] of touched) lines.push(`  ${name}: ${record.causes.join(", ")} (${record.attempts} attempts)`);
  lines.push(`  ${boxes.length - touched.length} of ${boxes.length} boxes clean on the first attempt`);
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

/** The ONE call that wakes the orchestrator, and only for a result that needs a decision. Never retried: exit 2 is QUEUED, not a failure. */
export function wakeMessage(result: ConvergeResult, row?: number): string | null {
  if (result.status === "ok") return null;
  const why = result.status === "unknown" ? "an UNKNOWN failure" : "a known cause that exhausted its attempts";
  const where = row === undefined ? "" : ` (row #${row})`;
  return `fleet-converge${where} ended ${result.status.toUpperCase()}: ${why}. ${result.reason ?? ""} The result is in ${RESULT_PATH}.`;
}

export function rowComment(result: ConvergeResult): string {
  return ["**fleet-converge**", "", "```", recapOf(result), "```", "", `layer refs: ${JSON.stringify(result.layerRefs)}`,
    `started ${result.startedAt}, finished ${result.finishedAt}`].join("\n");
}

function writeResult(path: string, result: ConvergeResult) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * The run and its ONE report: the result file, one row comment when `row` is given, and one call to the orchestrator
 * only for a result that needs a decision (`unknown`, or a known cause that exhausted its cap). A success wakes nobody:
 * the row comment is the completion. Each of the three is bookkeeping and never turns a result into another one, so a
 * failure of one is a warning on the result.
 */
export async function runConverge({ workers, layerRefs, row, effects }: {
  workers: WakeTarget[]; layerRefs: Record<string, string>; row?: number; effects: Effects;
}): Promise<ConvergeResult> {
  const result = await converge({ workers, layerRefs, effects });
  try {
    effects.save(result);
  } catch (cause) {
    result.warnings.push(`the result was not written: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const problems = [
    row === undefined ? null : effects.post(row, rowComment(result)),
    (() => { const message = wakeMessage(result, row); return message === null ? null : effects.notify(message); })(),
  ];
  result.warnings.push(...problems.filter((p): p is string => p !== null));
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line.
// ---------------------------------------------------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

/** A play as a subprocess of this process's node, its output both shown live and kept for the recap. */
function runPlayProcess(request: PlayRequest): Promise<PlayRun> {
  return new Promise((resolvePlay, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, resolve(HERE, request.script), ...request.args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    const keep = (stream: NodeJS.WriteStream) => (data: Buffer) => { chunks.push(String(data)); stream.write(data); };
    child.stdout.on("data", keep(process.stdout));
    child.stderr.on("data", keep(process.stderr));
    child.once("error", reject);
    child.once("close", (code) => resolvePlay({ status: code ?? 1, output: chunks.join("") }));
  });
}

function notifyOrchestrator(message: string): string | null {
  const sent = spawnSync("agent-org", ["prompt:session", "--needs-decision", "orchestrator", message], { encoding: "utf8" });
  // Exit 2 is QUEUED (`prompt:session`'s own word), delivered by the next `work:tick`; a retry would be a second copy.
  if (sent.error) return `the orchestrator was not woken: ${sent.error.message}`;
  return sent.status === 0 || sent.status === 2 ? null : `the orchestrator was not woken: agent-org exited ${sent.status}: ${String(sent.stderr).trim().slice(0, 200)}`;
}

function postOnRow(row: number, body: string): string | null {
  const posted = spawnSync("gh", ["issue", "comment", String(row), "-R", "a11ign/a11ign", "--body", body], { encoding: "utf8" });
  return posted.status === 0 ? null : `the row comment was not posted: ${String(posted.stderr || posted.error).trim().slice(0, 200)}`;
}

function planOf({ workers, refs }: { workers: WakeTarget[]; refs: Record<string, string> }): string {
  return [`fleet-converge PLAN (no --apply: nothing was woken, locked, deployed or provisioned)`,
    `  boxes: ${workers.map((w) => w.name).join(", ")}`,
    `  steps: take lock (operation ${WAKE_LOCK_OPERATION}) -> wake -> deploy.yml -> provision-role.yml --serial=0 -> fleet:status -> end lock`,
    `  layer refs: ${layerRefArgs(refs).join(" ")}`,
    `  known causes, ${ATTEMPTS_PER_BOX} attempts per box: ${KNOWN_CAUSES.join(", ")}; anything else is unknown and wakes the orchestrator once`].join("\n");
}

function parseCommandLine(argv: string[]): { apply: boolean; row?: number; refusal?: string } {
  const rowFlag = argv.find((a) => a.startsWith("--row="));
  const row = rowFlag === undefined ? undefined : Number(rowFlag.slice("--row=".length));
  if (row !== undefined && !(Number.isInteger(row) && row > 0)) return { apply: false, refusal: `${rowFlag}: a row number, a positive integer` };
  return { apply: argv.includes("--apply"), row };
}

async function main() {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const command = parseCommandLine(process.argv.slice(2));
  if (command.refusal) { process.stderr.write(`REFUSING: ${command.refusal}\n`); process.exit(2); }
  const workers = inventoryHosts(readFileSync(inventoryPathFor(), "utf8")).map(({ name, host, mac }) => ({ name, host, mac }));
  if (workers.length === 0) { process.stderr.write("REFUSING: no workers in inventory.yml\n"); process.exit(2); }
  const pinned = resolveLayerRefs({ layers: layersToPin(), readLaidTag: readLaidTagOnControlPlane, commitOfTag: gitCommitOfTag });
  if ("refusal" in pinned) { process.stderr.write(`REFUSING: ${pinned.refusal}\n`); process.exit(2); }
  if (!command.apply) { out(planOf({ workers, refs: pinned.refs })); return; }

  const effects: Effects = {
    now: Date.now, take: takeFleetLock, end: expireFleetLock, log: out,
    wake: (targets) => wakeFleet(targets, { log: out }), runPlay: runPlayProcess,
    notify: notifyOrchestrator, post: postOnRow, save: (result) => writeResult(resolve(RESULT_PATH), result),
  };
  const result = await runConverge({ workers, layerRefs: pinned.refs, row: command.row, effects });
  out(recapOf(result));
  process.exit(result.status === "ok" ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) await main();
