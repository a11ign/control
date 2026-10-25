/**
 * THE `fleet` COMMAND WITH A LOCAL ROUTE, as a process a test can start, kill or let exit (A11-243). The real `cli.ts` `main`, `realDeps` and wait loop,
 * with the one thing that cannot run off the control plane swapped: the transport runs `remote.ts` on this machine, against the store in
 * `A11Y_FLEET_JOBS_DIR`, where the real one runs it on the control plane over ssh.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { main, realDeps } from "./cli.ts";
import type { Transport } from "./cli.ts";
import { storeDirFromEnv } from "./paths.ts";

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const REMOTE = new URL("./remote.ts", import.meta.url).pathname;

export const localTransport = (dir: string, tsx: string = TSX): Transport => (args) => ({
  file: "env", args: [`A11Y_FLEET_JOBS_DIR=${dir}`, process.execPath, "--import", tsx, REMOTE, ...args],
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2), { ...realDeps(), transport: localTransport(storeDirFromEnv()), pollMs: Number(process.env.FLEET_WAIT_POLL_MS ?? 500) }));
}
