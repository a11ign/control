// @ts-check
/**
 * `fleet:patch` -- THE DELIBERATE FLEET UPGRADE, AS ONE COMMAND (A11-205, docs/adr/0001).
 *
 * Nothing on a box upgrades by itself. A person edits `deploy-pins.json` in a pull request, merges it, and runs
 *
 *     pnpm run fleet:patch                # the plan: what the run would do to each box, and nothing changed
 *     pnpm run fleet:patch -- --apply     # the upgrade
 *
 * `--apply` runs three things in order and stops at the first that fails, naming the box:
 *
 *   1. `deploy.yml`   the worker code the manifest pins, onto every box, with its own read-back (including the `a11ysrv` registration).
 *   2. `patch.yml`    one box at a time: lift the Windows freeze, bring Windows to the manifest's build and update, restart, install the manifest's Node, NVDA and
 *                     Edge, freeze again in an `always:`, read the box back. A box that cannot be upgraded stops the run.
 *   3. the closing read of EVERY box against the whole manifest (`fleet:drift`'s reading), which fails the run on any difference or any box that does not answer:
 *                     the upgrade is not done until the fleet is SHOWN to be on the manifest.
 *
 * Each play is `fleet-playbook.ts`'s, so each keeps the gates it has (the link gate, the fleet-hold refusal, the busy refusal, the fleet lock, the control-plane
 * move and its read-back). This file only orders them. Every argument is passed to both plays except `--apply`, which `deploy.yml` refuses (nothing it changes is
 * held back behind it). Without `--apply` only `patch.yml` runs, and it prints its plan and stops.
 */
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { driftExitCode, driftLines, driftRecordOf, readFleetDrift } from "./fleet-drift.ts";
import type { DriftRecord } from "./fleet-drift.ts";

const FLEET_PLAYBOOK = fileURLToPath(new URL("./fleet-playbook.ts", import.meta.url));

/** One play of the upgrade, as the arguments `fleet-playbook.ts` takes. */
export type UpgradeStep = { playbook: string; args: string[]; };

/** What a play said and how it ended. `output` is its stdout, in which Ansible's PLAY RECAP names the box that failed. */
export type StepResult = { status: number; output: string; };

/** The plays the arguments ask for: the plan only (`patch.yml`), or, with `--apply`, the code delivery first and then the upgrade. */
export function upgradeStepsOf(args: string[]): UpgradeStep[] {
  if (!args.includes("--apply")) return [{ playbook: "patch.yml", args }];
  return [{ playbook: "deploy.yml", args: args.filter((arg) => arg !== "--apply") }, { playbook: "patch.yml", args }];
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
  return `fleet:patch STOPPED at ${step.playbook} (exit ${result.status}): ${named}. Nothing was rolled back and nothing after this step ran; `
    + `${boxes.length > 0 ? "fix the box" : "fix what the output above says"} and run \`fleet:patch -- --apply\` again (a box already on the manifest is checked and left as it is).`;
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

export type UpgradeDeps = {
  run: (step: UpgradeStep) => Promise<StepResult>;
  /** Every box, read against the manifest now. */
  read: () => Promise<DriftRecord>;
  say: (line: string) => void;
};

/** The whole command, with the plays and the read injected. Returns the exit code: 0 done, the failed play's own code, or 3 for a fleet not on the manifest. */
export async function runUpgrade(args: string[], { run, read, say }: UpgradeDeps): Promise<number> {
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
  say("\n=== fleet:patch: reading every box against deploy-pins.json ===\n");
  const record = await read();
  const refusal = closingRefusal(record);
  if (refusal !== null) {
    for (const line of refusal) say(`${line}\n`);
    say("\nfleet:patch FAILED its closing read: the upgrade is not done until every box reads as the manifest.\n");
    return 3;
  }
  for (const line of driftLines(record)) say(`${line}\n`);
  say("\nfleet:patch completed: every box was read back and is on the manifest.\n");
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
  const readEveryBox = async () => driftRecordOf({ ...await readFleetDrift(), previous: null, freeze: null, now: new Date() });
  // Under pnpm 10 `pnpm run fleet:patch -- --apply` keeps the `--` (see `lab-job.ts`); neither play wants it.
  const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  process.exitCode = await runUpgrade(args, { run: runThroughWrapper, read: readEveryBox, say: (line) => process.stdout.write(line) });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
