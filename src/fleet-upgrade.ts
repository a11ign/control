// @ts-check
/**
 * `fleet:patch` -- THE DELIBERATE FLEET UPGRADE, AS ONE COMMAND (A11-205, docs/adr/0001).
 *
 * Nothing on a box upgrades by itself. A person edits `deploy-pins.json` in a pull request, merges it, and runs
 *
 *     pnpm run fleet:patch                # the plan: what the run would do to each box, and nothing changed
 *     pnpm run fleet:patch -- --apply     # the upgrade
 *
 * `--apply` runs four things in order and stops at the first that fails, naming the box:
 *
 *   0. `patch.yml --preflight`  the upgrade's own gates (a box that is busy, did not answer, or is above the manifest; a manifest that cannot be read) asked BEFORE any
 *                     code is delivered, so a refusal leaves every box exactly as it was.
 *   1. `deploy.yml`   the worker code the manifest pins, onto every box, with its own read-back (including the `a11ysrv` registration).
 *   2. `patch.yml`    one box at a time: lift the Windows freeze, bring Windows to the manifest's build and update, restart, install the manifest's Node, NVDA and
 *                     Edge, freeze again in an `always:`, read the box back. A box that cannot be upgraded stops the run.
 *   3. the closing read of every box against the whole manifest (`fleet:drift`'s reading), which fails the run on any difference or any box that does not answer:
 *                     the upgrade is not done until the fleet is SHOWN to be on the manifest. Under `--limit` it reads the boxes the run touched, and says so; the
 *                     fleet-wide read is `fleet:drift`.
 *
 * Each play is `fleet-playbook.ts`'s, so each keeps the gates it has (the link gate, the fleet-hold refusal, the busy refusal, the fleet lock, the control-plane
 * move and its read-back). This file only orders them. Every argument is passed to the plays except `--apply`, which `deploy.yml` refuses (nothing it changes is
 * held back behind it). Without `--apply` only `patch.yml` runs, and it prints its plan and stops.
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { driftExitCode, driftLines, driftRecordOf, readFleetDrift, workersToRead } from "./fleet-drift.ts";
import type { DriftRecord } from "./fleet-drift.ts";
import { inventoryName } from "./fleet-status.ts";

const FLEET_PLAYBOOK = fileURLToPath(new URL("./fleet-playbook.ts", import.meta.url));

/** One play of the upgrade, as the arguments `fleet-playbook.ts` takes. */
export type UpgradeStep = { playbook: string; args: string[]; };

/** What a play said and how it ended. `output` is its stdout, in which Ansible's PLAY RECAP names the box that failed. */
export type StepResult = { status: number; output: string; };

/** The plays the arguments ask for: the plan only (`patch.yml`), or, with `--apply`, the gates, the code delivery and then the upgrade. */
export function upgradeStepsOf(args: string[]): UpgradeStep[] {
  if (!args.includes("--apply")) return [{ playbook: "patch.yml", args }];
  return [{ playbook: "patch.yml", args: [...args, "--preflight"] },
    { playbook: "deploy.yml", args: args.filter((arg) => arg !== "--apply") }, { playbook: "patch.yml", args }];
}

/** The boxes `--limit` names, or `null` for the whole fleet (no `--limit`, or the group itself). */
export function limitedBoxesOf(args: string[]): string[] | null {
  const limit = args.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length);
  return limit === undefined || limit === "a11y_workers" ? null : limit.split(",").filter(Boolean);
}

/**
 * The boxes Ansible says failed or could not be reached, out of a run's output: the PLAY RECAP lines with a `failed=` or `unreachable=` above zero, and any
 * `fatal: [box]` line. Sorted, once each. An empty answer means the output named no box (a refusal before the play started, for one).
 */
export function failedBoxesOf(output: string): string[] {
  const recap = output.split(/^PLAY RECAP\b.*$/m).slice(1).join("\n");
  const fromRecap = [...recap.matchAll(/^(\S+)\s*:\s*ok=\d+\s.*?\bunreachable=(\d+)\s+failed=(\d+)/gm)]
    .filter(([, , unreachable, failed]) => Number(unreachable) > 0 || Number(failed) > 0).map(([, box]) => box);
  const fromFatal = [...output.matchAll(/^fatal: \[([^\]]+)\]/gm)].map(([, box]) => box);
  return [...new Set([...fromRecap, ...fromFatal])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** The line a stopped run ends with: which play, which box, and what to do. Nothing is rolled back. */
export function stoppedLine(step: UpgradeStep, result: StepResult): string {
  const boxes = failedBoxesOf(result.output);
  const named = boxes.length > 0 ? `${boxes.join(", ")} ${boxes.length === 1 ? "is" : "are"} the box${boxes.length === 1 ? "" : "es"} it stopped on` : "the output above names no box";
  const changedNothing = step.args.includes("--preflight") || !step.args.includes("--apply") && step.playbook === "patch.yml";
  return `fleet:patch STOPPED at ${step.playbook}${step.args.includes("--preflight") ? " (preflight)" : ""} (exit ${result.status}): ${named}. `
    + `${changedNothing ? "Nothing was changed" : "Nothing was rolled back"} and nothing after this step ran; `
    + `${boxes.length > 0 ? "fix the box" : "fix what the output above says"} and run \`fleet:patch${step.args.includes("--apply") || step.args.includes("--preflight") ? " -- --apply" : ""}\` again `
    + "(a box already on the manifest is checked and left as it is).";
}

/**
 * The closing read as a verdict: `null` when every box answered and every one reads as the manifest, otherwise the lines that say which did not.
 * An unreachable box FAILS here although the hourly check only names it: the hourly check is a watch, and this is the end of a run that promised to show the fleet
 * on the manifest, which a box nobody could read has not been shown to be.
 */
export function closingRefusal(record: DriftRecord): string[] | null {
  if (driftExitCode(record) === 0 && record.unreachable.length === 0) return null;
  const lines = driftLines(record).filter((line) => line.startsWith("fleet OFF THE MANIFEST") || line.startsWith("no box answered"));
  if (record.unreachable.length > 0) lines.push(`not read at the end of the upgrade (so not shown to be on the manifest): ${record.unreachable.join(", ")}`);
  return lines;
}

/** A box that was restarted by the last play can be briefly unreachable when it ends: the closing read asks the ones that did not answer again, this often and this far apart. */
export const CLOSING_READ_RETRIES = 5;
export const CLOSING_READ_PAUSE_MS = 60_000;

export type UpgradeDeps = {
  run: (step: UpgradeStep) => Promise<StepResult>;
  /** The boxes named (`null`: every box), read against the manifest now. */
  read: (boxes: string[] | null) => Promise<DriftRecord>;
  say: (line: string) => void;
  /** Absent: no waiting between reads, which is what a test wants. */
  sleep?: (ms: number) => Promise<void>;
};

/** The closing read, asked again while a box does not answer. A DIFFERENCE is final: only silence is waited out. */
async function readUntilAnswered(boxes: string[] | null, { read, say, sleep }: Pick<UpgradeDeps, "read" | "say" | "sleep">): Promise<DriftRecord> {
  let record = await read(boxes);
  for (let attempt = 1; attempt <= CLOSING_READ_RETRIES && record.unreachable.length > 0; attempt += 1) {
    say(`${record.unreachable.join(", ")} did not answer; asking again (${attempt} of ${CLOSING_READ_RETRIES})\n`);
    await sleep?.(CLOSING_READ_PAUSE_MS);
    record = await read(boxes);
  }
  return record;
}

/** The whole command, with the plays and the read injected. Returns the exit code: 0 done, the failed play's own code, or 3 for a fleet not on the manifest. */
export async function runUpgrade(args: string[], deps: UpgradeDeps): Promise<number> {
  const { run, say } = deps;
  const steps = upgradeStepsOf(args);
  for (const step of steps) {
    say(`\n=== fleet:patch: ${step.playbook} ===\n`);
    const result = await run(step);
    if (result.status !== 0) {
      say(`\n${stoppedLine(step, result)}\n`);
      return result.status;
    }
  }
  if (!args.includes("--apply")) {
    say("\nThis was the plan. `fleet:patch -- --apply` runs deploy.yml, then patch.yml one box at a time, then reads every box against deploy-pins.json.\n");
    return 0;
  }
  const boxes = limitedBoxesOf(args);
  say(`\n=== fleet:patch: reading ${boxes === null ? "every box" : `${boxes.join(", ")} (--limit; \`fleet:drift\` reads the whole fleet)`} against deploy-pins.json ===\n`);
  let record: DriftRecord;
  try {
    record = await readUntilAnswered(boxes, deps);
  } catch (cause) {
    say(`The closing read could not be made (${cause instanceof Error ? cause.message : String(cause)}): the upgrade is not shown to have reached the manifest. \`pnpm run fleet:drift\` reads it again.\n`);
    return 3;
  }
  const refusal = closingRefusal(record);
  if (refusal !== null) {
    for (const line of refusal) say(`${line}\n`);
    say("\nfleet:patch FAILED its closing read: the upgrade is not done until every box reads as the manifest.\n");
    return 3;
  }
  for (const line of driftLines(record)) say(`${line}\n`);
  say(`\nfleet:patch completed: ${boxes === null ? "every box was read back and is on the manifest" : `${boxes.join(", ")} ${boxes.length === 1 ? "was" : "were"} read back and ${boxes.length === 1 ? "is" : "are"} on the manifest`}.\n`);
  return 0;
}

/** One play through `fleet-playbook.ts`, its stdout shown as it arrives and kept for the recap. */
function runThroughWrapper({ playbook, args }: UpgradeStep): Promise<StepResult> {
  return new Promise((resolveStep) => {
    const child = spawn(process.execPath, [FLEET_PLAYBOOK, `--playbook=${playbook}`, ...args], { stdio: ["inherit", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString("utf8");
    });
    child.on("error", (cause) => resolveStep({ status: 1, output: `${output}\n${String(cause)}` }));
    child.on("close", (status) => resolveStep({ status: status ?? 1, output }));
  });
}

async function main() {
  const readBoxes = async (boxes: string[] | null) => driftRecordOf({ previous: null, freeze: null, now: new Date(),
    ...await readFleetDrift(boxes === null ? {} : { workers: () => workersToRead().filter((worker) => boxes.includes(inventoryName(worker.name))) }) });
  // Under pnpm 10 `pnpm run fleet:patch -- --apply` keeps the `--` (see `lab-job.ts`); neither play wants it.
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  process.exitCode = await runUpgrade(args, { run: runThroughWrapper, read: readBoxes, say: (line) => process.stdout.write(line),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
