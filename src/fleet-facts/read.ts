import { execFile } from "node:child_process";
import { join } from "node:path";
import { readControlPlaneFleet } from "../control-plane-fleet.ts";
import { wakeFailed, wakeFleet, wakeReportLine } from "../fleet-wake.ts";
import type { WakeResult, WakeTarget } from "../fleet-wake.ts";
import { SERVICE_CHECKOUT } from "../fleet-jobs/paths.ts";
import type { Box } from "../fleet-jobs/types.ts";
import { playOutcome } from "./play-result.ts";
import type { PlayRead } from "./play-result.ts";

export const FACTS_PLAYBOOK = "ansible/facts.yml";
/** Plays running at once. The runner reads every idle box together, and each play is an `ansible-playbook` process of its own on the control plane. */
export const MAX_PLAYS = 4;
/** One box's play: a Windows box that has just woken answers ssh in a minute or two, and its CIM reads take seconds. */
export const PLAY_TIMEOUT_MS = 600_000;

type Inventory = () => { name: string; url: string; mac?: string }[];
export type PlayRun = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number };
export type PlayRunner = (run: PlayRun) => Promise<{ stdout: string; stderr?: string }>;

/** What the service's environment must say for `ansible-playbook` to run and to print one JSON document (ADR 0005). */
export function playEnv(checkout: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    ANSIBLE_CONFIG: join(checkout, "ansible/ansible.cfg"),
    ANSIBLE_STDOUT_CALLBACK: "json",
    // `ansible.cfg` enables `profile_tasks`, which prints its timings after the JSON document; `jsonOf` reads past them. An empty
    // ANSIBLE_CALLBACKS_ENABLED does not turn it off: it names a plugin "" and ansible-playbook dies with "A non-empty plugin name is required".
    ANSIBLE_NOCOLOR: "1",
    // The unit sets no `User=`, so systemd sets no HOME, and `~/.ansible/collections` has to resolve.
    HOME: env.HOME || "/root",
  };
}

/** The real runner: stdout whatever the exit code, since a play that failed or found a box unreachable still prints the document that says so. */
export const runPlay: PlayRunner = ({ file, args, cwd, env, timeoutMs }) => new Promise((resolve, reject) => {
  execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(`${file} was not found: the service's environment cannot run Ansible`));
    if (error && (error as { killed?: boolean }).killed) return reject(new Error(`the play took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`));
    resolve({ stdout, stderr });
  });
});

const targetOf = (box: { name: string; url: string; mac?: string }): WakeTarget =>
  ({ name: box.name, host: new URL(box.url).hostname, mac: box.mac ?? null });

function readInventory(): ReturnType<Inventory> {
  const { workers, refusal } = readControlPlaneFleet();
  if (refusal !== null) throw new Error(refusal);
  return workers;
}

/** A gate that lets `limit` calls through at once and holds the rest, in order, until one ends. */
function gate(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    if (running >= limit) await new Promise<void>((resume) => waiting.push(resume));
    running += 1;
    try { return await work(); } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/**
 * THE REAL `readFacts` (A11-283): wake the one box, run `ansible/facts.yml --limit <box>` from the service's own checkout, and return what the play said about
 * it. It rejects, naming the box, when the box does not come up, is unreachable or fails the play; it does not decide whether the play changed anything or
 * whether its output is whole, which are the runner's.
 */
export function factsReader({ checkout = SERVICE_CHECKOUT, inventory = readInventory, wake = wakeFleet, run = runPlay, log = () => {}, timeoutMs = PLAY_TIMEOUT_MS, maxPlays = MAX_PLAYS }: {
  checkout?: string; inventory?: Inventory; wake?: (targets: WakeTarget[], options: { log: (line: string) => void }) => Promise<WakeResult[]>;
  run?: PlayRunner; log?: (line: string) => void; timeoutMs?: number; maxPlays?: number;
} = {}): (box: Box) => Promise<PlayRead> {
  const oneAtATime = gate(maxPlays);
  return (box) => oneAtATime(async () => {
    const known = inventory().find((candidate) => candidate.name === box.name);
    if (!known) throw new Error(`${box.name} is not in the inventory`);
    const [woken] = await wake([targetOf(known)], { log });
    if (woken && wakeFailed(woken)) throw new Error(`${box.name} did not come up when woken: ${wakeReportLine(woken)}`);
    const { stdout, stderr } = await run({ file: "ansible-playbook", args: [FACTS_PLAYBOOK, "--limit", box.name], cwd: checkout, env: playEnv(checkout), timeoutMs });
    const outcome = playOutcome(stdout, box.name, stderr);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.read;
  });
}
