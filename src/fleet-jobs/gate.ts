/**
 * THE FORCED COMMAND FOR THE LAB'S KEY (A11-263, ADR `0004-the-lab-submits-fleet-jobs-through-a-forced-command-key`).
 *
 *     restrict,command="/usr/bin/node --import <loader> /root/fleet-jobs/src/fleet-jobs/gate.ts" ssh-ed25519 AAAA… a11y-lab-fleet-jobs
 *
 * `sshd` runs this instead of whatever the lab's key asked for and leaves the request in `SSH_ORIGINAL_COMMAND`. The only request accepted is the
 * one `controlPlaneTransport` (`cli.ts`) sends: `cd <SERVICE_CHECKOUT> && /usr/bin/node --import <loader> src/fleet-jobs/remote.ts` followed by
 * single-quoted arguments. They are unquoted here and handed to `remote.ts` as an argument list, with no shell, so nothing in them can be read as
 * a command. Everything else is refused on stderr with exit 2, naming what it was given.
 *
 * That is the whole reach of the lab's key: submit, re-capture, follow, cancel, list and fetch capture jobs. It provisions, deploys, sleeps and
 * reconfigures nothing, which is what ADR 0012 keeps off the lab.
 *
 * Imports `node:` modules and `paths.ts` only: it runs on the plane beside the fleet key (`fleet-jobs-unit.test.ts` holds that for the service).
 */
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CONTROL_TSX_LOADER, SERVICE_CHECKOUT } from "./paths.ts";

/** The refusal's exit code: `remote.ts` uses 2 for a refusal too, and ssh passes it through. */
export const GATE_REFUSED = 2;

export type GateWhere = { checkout: string; loader: string };
export type Gated = { file: string; args: string[]; cwd: string } | { refusal: string };

/** One single-quoted argument as `cli.ts`'s `shellQuote` writes it: a quote inside is `'\''`. */
const QUOTED_ARGUMENT = /^ '((?:[^']|'\\'')*)'/;

/** The arguments of a request tail, unquoted, or null when anything but single-quoted arguments is there. */
function unquote(tail: string): string[] | null {
  const args: string[] = [];
  for (let rest = tail; rest.length;) {
    const match = QUOTED_ARGUMENT.exec(rest);
    if (!match) return null;
    args.push(match[1]!.replaceAll("'\\''", "'"));
    rest = rest.slice(match[0].length);
  }
  return args;
}

const refused = (original: string | undefined): Gated => ({
  refusal: `refused: this key runs only the fleet job service's remote half (src/fleet-jobs/remote.ts), in the form the fleet command sends. It was given ${JSON.stringify(original ?? "")}`,
});

/** What to run for one `SSH_ORIGINAL_COMMAND`, or why not. PURE: the checkout and loader are handed in, and default to the plane's own. */
export function gateCommand(original: string | undefined, { checkout, loader }: GateWhere = { checkout: SERVICE_CHECKOUT, loader: CONTROL_TSX_LOADER }): Gated {
  const prefix = `cd ${checkout} && /usr/bin/node --import ${loader} src/fleet-jobs/remote.ts`;
  if (typeof original !== "string" || !original.startsWith(prefix)) return refused(original);
  const args = unquote(original.slice(prefix.length));
  if (!args) return refused(original);
  return { file: "/usr/bin/node", args: ["--import", loader, "src/fleet-jobs/remote.ts", ...args], cwd: checkout };
}

export type GateDeps = {
  where?: GateWhere;
  /** Runs the program with this process's stdin and stdout (the `submit` request in, the `tar` stream out), and answers its exit code. */
  run?: (file: string, args: string[], cwd: string) => number;
  err?: (text: string) => void;
};

const runInherited = (file: string, args: string[], cwd: string): number =>
  spawnSync(file, args, { cwd, stdio: "inherit" }).status ?? 1;

/** One gated request. Answers the exit code to end with. */
export function gate(original: string | undefined, { where, run = runInherited, err = (text) => { process.stderr.write(text); } }: GateDeps = {}): number {
  const gated = gateCommand(original, where);
  if ("refusal" in gated) {
    err(`${gated.refusal}\n`);
    return GATE_REFUSED;
  }
  return run(gated.file, gated.args, gated.cwd);
}

if (import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href) {
  process.exit(gate(process.env.SSH_ORIGINAL_COMMAND));
}
