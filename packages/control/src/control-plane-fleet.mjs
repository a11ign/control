// @ts-check
// command: the ONE inventory -- the control plane's own, read over ssh, never a checkout's inventory.yml
//
// #1356: `guardProtocolChange` used to read THIS CHECKOUT's `packages/control/ansible/inventory.yml`
// through `inventoryWorkerUrls()` -- gitignored, and absent on the operator host that actually drives the
// fleet, so it silently asked zero workers and `protocolVerdict` refused with "no worker answered /health",
// a message that reads like the fleet went silent when the truth is this machine never had an address to
// try. #1343's `linkGateFor`/`gateFleet` already got this right for the layer-2 gate: the control plane's
// OWN inventory, read live over the same ssh every other command here uses, merged across every source
// `ansible.cfg` lists (the durable install first, the in-tree file as a migration fallback). This file
// pulls that shape out of `fleet-playbook.mjs` so every OTHER reader on the operator host -- `fleet:status`,
// `fleet:wake`, `fleet:discover`, `lab:job` -- can ask the same way instead of restating it, or reading a
// file that is not there.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { requireControlPlaneHost, requireControlPlaneKey } from "./control-plane-host.mjs";
import { CONTROL_PLANE_CHECKOUT_PATH } from "./control-plane-checkout.mjs";
import { WORKER_GROUP, workersFromInventory, workerNamesFromInventory, portFromGroupVars }
  from "../../worker-fleet/src/fleet-env.mjs";

const ANSIBLE_DIR = resolve(import.meta.dirname, "../ansible");
const DEFAULT_SSH_TIMEOUT_MS = 60_000;
const INVENTORY_HEADER = "==> ";
// Entries only, never `..` or an absolute escape -- `ansible.cfg`'s `inventory =` line is parsed here and
// then handed to a remote shell, so a malformed entry must be refused before it becomes a command.
const INVENTORY_PATH_SHAPE = /^[\w./-]+$/;

/**
 * Is THIS machine the control plane? ssh to yourself needs a key you should not have to install to talk
 * to your own filesystem, so `sshToControlPlane` shells out locally instead when this is true.
 *
 * @param {Record<string, {address?: string}[] | undefined>} [interfaces] injectable, so this is testable
 *        off the control plane — the alternative is a function whose only test is running it there
 * @param {string} [host]
 * @returns {boolean}
 */
export function onTheControlPlane(interfaces = networkInterfaces(), host = requireControlPlaneHost()) {
  return Object.values(interfaces).flat().some((iface) => iface?.address === host);
}

/**
 * One command on the control plane -- locally if this machine IS the control plane, over ssh otherwise.
 * Synchronous, matching every other read in this file: `readControlPlaneFleet` below is called from
 * ordinary top-level command flows that were never async, and a network round trip to a machine on the
 * same rack does not need to be.
 * @param {string} command
 * @param {{ capture?: boolean, timeoutMs?: number }} [options]
 * @returns {string}
 */
export function sshToControlPlane(command, { capture = false, timeoutMs = DEFAULT_SSH_TIMEOUT_MS } = {}) {
  if (onTheControlPlane()) {
    return execFileSync("sh", ["-c", `cd /root && ${command}`], {
      encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: timeoutMs,
    });
  }
  const args = ["-i", requireControlPlaneKey(), "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=20", `root@${requireControlPlaneHost()}`, command];
  return execFileSync("ssh", args, {
    encoding: "utf8", stdio: capture ? "pipe" : ["ignore", "inherit", "inherit"], timeout: timeoutMs,
  });
}

/**
 * #1343 REVIEW: WHERE THE PLAYBOOK'S INVENTORY LIVES, read from `ansible.cfg` rather than restated.
 *
 * The control plane runs with `ANSIBLE_CONFIG=ansible.cfg`, whose `inventory =` line lists the installed
 * file first and the in-tree file as the migration fallback, and Ansible MERGES every listed source that
 * exists. A relative entry is relative to `ansible.cfg`'s OWN directory on the control plane -- this
 * checkout's copy of the same file names the same directory, since both are the same tracked source.
 * @param {string} ansibleCfgText
 * @returns {string[]} paths on the control plane, in the config's order
 */
export function inventorySources(ansibleCfgText) {
  const listed = /^\s*inventory\s*=\s*(.+?)\s*$/m.exec(ansibleCfgText)?.[1];
  if (!listed) throw new Error("ansible.cfg declares no `inventory =` line, so there is no inventory to read");
  return listed.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (!INVENTORY_PATH_SHAPE.test(entry) || entry.split("/").includes("..")) {
      throw new Error(`ansible.cfg inventory entry is not a plain path: ${entry}`);
    }
    return entry.startsWith("/") ? entry : `${CONTROL_PLANE_CHECKOUT_PATH}/packages/control/ansible/${entry}`;
  });
}

/**
 * One remote read of every source that exists, each under its own header -- the paths have passed
 * `inventorySources`' shape check, because this string is parsed by a remote shell.
 * @param {string[]} paths
 * @returns {string}
 */
export function inventoryReadScript(paths) {
  return paths.map((path) => `if [ -f ${path} ]; then echo '${INVENTORY_HEADER}${path}'; cat ${path}; fi`).join("; ");
}

/**
 * @param {string} stdout what `inventoryReadScript` printed
 * @returns {{ path: string, text: string }[]} one entry per source that existed
 */
export function parseInventoryReads(stdout) {
  /** @type {{ path: string, text: string }[]} */
  const reads = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(INVENTORY_HEADER)) reads.push({ path: line.slice(INVENTORY_HEADER.length), text: "" });
    else if (reads.length) reads[reads.length - 1].text += `${line}\n`;
  }
  return reads;
}

/**
 * THE FLEET THE CONTROL PLANE'S OWN INVENTORY DECLARES, pure given the reads -- THREE CAUSES, THREE
 * WORDINGS, all a refusal: no source existed, a source did not parse, or the parsed source names no
 * worker. None of the three may read as "the fleet is empty", which is why this never returns `{workers:
 * [], refusal: null}` for any of them -- could not ask is not may proceed.
 *
 * `gateFleet` (`fleet-playbook.mjs`) wraps this with the layer-2 gate's own wording; every other reader
 * on the operator host wraps it with its own, per #1356's done-when 2 ("each in its own words").
 *
 * @param {{ reads: { path: string, text: string }[], sources: string[], groupVarsText: string }} input
 * @returns {{ workers: { name: string, url: string }[], refusal: string | null }}
 */
export function controlPlaneFleet({ reads, sources, groupVarsText }) {
  const refuse = (/** @type {string} */ why) => ({ workers: [], refusal: why });
  if (!reads.length) return refuse(`no inventory exists at ${sources.join(" or ")} on the control plane`);
  const port = portFromGroupVars(groupVarsText);
  /** @type {Map<string, string>} */
  const byUrl = new Map();
  for (const { path, text } of reads) {
    try {
      const urls = workersFromInventory(text, { port });
      const names = workerNamesFromInventory(text, { port });
      for (const url of urls) byUrl.set(url, names[url] ?? url.replace(/^https?:\/\//, ""));
    } catch (error) {
      // THE PARSER'S OWN WORDS, never a label of mine: it throws for a malformed host line AND for an
      // empty worker group, and calling both "does not parse" was the wrong errand for the second.
      return refuse(`${path} was refused by the inventory parser: ${String(/** @type {Error} */ (error).message).split("\n")[0]}`);
    }
  }
  if (!byUrl.size) {
    return refuse(`${reads.map(({ path }) => path).join(" and ")} ${reads.length === 1 ? "lists" : "list"} no ${WORKER_GROUP} hosts`);
  }
  return { workers: [...byUrl].map(([url, name]) => ({ name, url })), refusal: null };
}

/**
 * THE REAL, END-TO-END READ -- the one function #1356 asks every operator-host reader to call INSTEAD of
 * a checkout's own `inventory.yml`. Reads `ansible.cfg` and `group_vars/a11y_workers.yml` from THIS
 * checkout (tracked, not gitignored -- only the inventory data itself is), asks the control plane over
 * ssh for every source `ansible.cfg` names, and resolves them exactly as `gateFleet` already does.
 *
 * Every dependency is injectable so a test can drive this without a real control plane; the defaults are
 * the real reads, which is what every actual caller gets.
 *
 * @param {{ ansibleCfgText?: string, groupVarsText?: string,
 *           readInventories?: (sources: string[]) => { path: string, text: string }[] }} [deps]
 * @returns {{ workers: { name: string, url: string }[], refusal: string | null }}
 */
export function readControlPlaneFleet({
  ansibleCfgText = readFileSync(resolve(ANSIBLE_DIR, "ansible.cfg"), "utf8"),
  groupVarsText = readFileSync(resolve(ANSIBLE_DIR, "group_vars/a11y_workers.yml"), "utf8"),
  readInventories = (sources) => parseInventoryReads(sshToControlPlane(inventoryReadScript(sources), { capture: true })),
} = {}) {
  let sources;
  try {
    sources = inventorySources(ansibleCfgText);
  } catch (error) {
    return { workers: [], refusal: `the control plane's inventory could not be read (${/** @type {Error} */ (error).message})` };
  }
  let reads;
  try {
    reads = readInventories(sources);
  } catch (error) {
    const stderr = String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? "").trim().split("\n").pop();
    return { workers: [], refusal: `the control plane could not be reached (${stderr || /** @type {Error} */ (error).message})` };
  }
  return controlPlaneFleet({ reads, sources, groupVarsText });
}

/**
 * #1683/#1684: THE DURABLE COPY FIRST, exactly the precedence `ansible.cfg`'s own `inventory =` line
 * states (`/etc/a11ign/inventory.yml,inventory.yml`) -- a plain LOCAL file read either way, never ssh,
 * never a credential. This is what lets a zero-credential reader (`fleet-wake.mjs`) or one with no
 * stated credential restriction of its own (`fleet-discover.mjs`) find a fleet on a machine, like the
 * lab, that carries no in-tree checkout copy -- without either file gaining ssh/control-plane knowledge
 * the way `readControlPlaneFleet` above needs. Falls back to the in-tree checkout path unchanged, so a
 * laptop checkout with nothing installed at `/etc/a11ign` behaves exactly as it always has.
 * @param {{ installed?: string, inTree?: string, exists?: (p: string) => boolean }} [paths]
 * @returns {string}
 */
export function inventoryPathFor({
  installed = "/etc/a11ign/inventory.yml",
  inTree = fileURLToPath(new URL("../ansible/inventory.yml", import.meta.url)),
  exists = existsSync,
} = {}) {
  return exists(installed) ? installed : inTree;
}
