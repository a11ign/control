/**
 * What `fleet-wake`'s load closure needs from `worker-fleet`, carried HERE so it loads outside a core checkout (a11ign#5184, epic #4425
 * done-when 3). The lab's consumers import `@a11ign/control/fleet-wake` from the lab's OWN checkout, where `../../worker-fleet/src/` does not
 * exist, and the package name is refused by `control-has-no-dependencies.test.ts` (ADR 0012: the control plane runs from a raw checkout with
 * no `node_modules`). So `fleet-discover.ts`, `fleet-status.ts`, `with-control-plane-fleet.ts`, `control-plane-fleet.ts` and `fleet-switch.ts`
 * import from here instead of reaching up.
 *
 * EVERY DECLARATION BELOW IS A COPY, taken verbatim from the file named above it. This module owns none of them and adds none: a behaviour
 * change goes to `worker-fleet` first and arrives here by copy, and `worker-fleet-carried.test.ts` compares each copy with the original on
 * the same inputs wherever the original is laid, so the two cannot drift unseen. (`cli-flags.ts` and `worker-health.ts` and
 * `fleet-consistency.ts` are carried whole; `worker-http.ts` and `fleet-env.ts` are carried by declaration, because the rest of
 * `fleet-env.ts` reads an inventory path that means nothing here. The inventory reader `control-plane-fleet.ts` and `fleet-switch.ts`
 * need is carried by declaration too, from `fleet-env.ts`'s own group reader.)
 *
 * Imports `node:` built-ins only. Keep it that way: the control plane has no `node_modules`.
 */
import { realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// ======================================================================================================================
// worker-http
// carried from packages/worker-fleet/src/worker-http.ts
// ======================================================================================================================

/**
 * How long a capture's silent connection may idle before the OS proves it is still there.
 *
 * 15 s, and RAISING IT TO 60 s WAS TRIED AND REVERTED — by this file's own test, which refuses a delay
 * above ~30 s because common NAT idle timeouts start there.
 *
 * The reasoning for raising it was that the async path removed the long-lived connection, so nothing needs
 * an aggressive value. That is true of the async path and FALSE of the `A11Y_SYNC_CAPTURE` escape hatch,
 * which still holds one socket silent for a whole capture. At 60 s the first probe would fire after the
 * reap, so the hatch would be unprotected while the constant looked deliberate — a guard weakened for a
 * reason that did not cover the case it exists for.
 *
 * It stays aggressive until item D explains why THIS path reaps in seconds when the literature says
 * minutes. An unexplained number is not a solved problem.
 *
 * EXPORTED so its test can key on the exact value. Node's own HTTP SERVER calls `setKeepAlive(true, 5000)`
 * on every socket it accepts, so a test that merely looked for "keepalive with a plausible delay" matched
 * the server's call and passed with this hook DELETED — found by mutation, not by reading.
 */
export const KEEPALIVE_DELAY_MS = 15_000;

/**
 * A worker address, validated at the BOUNDARY where it enters the program.
 *
 * `requestJson` already calls `new URL(url)`, which throws `ERR_INVALID_URL` on a malformed address — so an
 * empty host dies in under a second, in principle. In practice it did not, and the way it did not is the
 * reason this function exists.
 *
 * `--worker=http://:8765` reached `capture-real-pages.mjs` because nothing there did more than check the
 * value was truthy, and `http://:8765` is truthy. The readiness loop then caught the resulting
 * `ERR_INVALID_URL` in a bare `catch` whose only content was the comment "mid-boot or mid-restart; keep
 * waiting", and so classified a permanent
 * programmer error as a transient network condition: 60 attempts, 5 s apart, per page — then recorded
 * "worker never became ready" as a failure of the PAGE. Four shards spent 29 minutes that way while every
 * worker sat idle, and the run blamed the corpus.
 *
 * So the fix is two-part and both halves are needed: refuse the value here, and stop the readiness loop
 * swallowing what it cannot recover from. Validating without fixing the catch leaves the next unrecoverable
 * error to be absorbed the same way.
 *
 * Node's URL parser does the work. There is no regex here on purpose — a hand-rolled one would accept
 * `http://:8765` again, since the only thing wrong with it is an empty host. Note `http:/x` and
 * `http:///path` DO parse, to host `x` and host `path`; that is the parser's business and not something to
 * second-guess here.
 *
 * @param {string | null | undefined} value the raw `--worker=` or `A11Y_WORKER` value
 * @param {{ source?: string }} [options] what to name in the error, e.g. "--worker"
 * @returns {string} the address, trailing slash removed
 */
export function assertWorkerUrl(value: string | null | undefined, { source = "--worker" }: { source?: string; } = {}): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${source} is required and was empty. Give a worker address, e.g. ${source}=http://192.0.2.10:8765`);
  }
  const raw = value.trim().replace(/\/$/, "");
  let target;
  try {
    target = new URL(raw);
  } catch (cause) {
    // A missing HOST lands here rather than in a hostname check below, and there is no such check on
    // purpose: verified against Node's parser, no `http:`/`https:` URL can parse with an empty hostname —
    // `http://`, `http://:8765` and `http://:/x` all throw. A `!target.hostname` branch would therefore be
    // unreachable, which is this repo's own most-repeated defect, so the message that belongs to that case
    // is folded in here where it can actually be read.
    throw new Error(
      `${source}=${raw} is not a URL. Expected something like http://192.0.2.10:8765\n`
      + "If the host is missing, that is what a shell variable expanding to nothing looks like: a bash "
      + "array does not survive `nohup bash -c`, and zsh does not word-split a scalar. Both produce "
      + "exactly this.", { cause });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`${source}=${raw} must be http: or https:, not ${target.protocol}`);
  }
  return raw;
}

/**
 * One request, with a single deadline covering connect, headers and body.
 *
 * @param {string} url
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, ok: boolean, text: string, json: any }>}
 *   `json: any`, not `unknown`. This is a JSON body off the wire, and every caller reads named fields
 *   from it -- `body.error`, `body.fault`, `health.busy`, `body.transcript`. `unknown` makes each of
 *   those a cast, and a cast written to satisfy a checker asserts a shape nobody verified, which is
 *   strictly worse than saying the value is untyped. The SHAPE that matters is checked where it is
 *   defined: `capture-core`'s `Capture` typedef, and the worker's own `/health` contract.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON read by field path, as in the original
export function requestJson(url: string, { method = "GET", body, timeoutMs = 30_000 }: { method?: string; body?: unknown; timeoutMs?: number; } = {}): Promise<{ status: number; ok: boolean; text: string; json: any; }> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = send(target, { method, headers: requestHeaders(payload) }, (res) => {
      collect(res).then((text) => {
        clearTimeout(deadline);
        // `?? 0` because node types `statusCode` optional -- it is set on every client response, and a 0
        // would fall out of the 2xx range exactly as an absent one should, so the fallback cannot change
        // an answer. Named once rather than read three times.
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text, json: parse(text) });
      }, failWith);
    });

    // Our own deadline, because node:http has no equivalent of a total-request timeout: its `timeout`
    // option measures socket INACTIVITY, which a worker holding a connection open while NVDA reads a page
    // never trips. The message says "timed out" so the prose fallback in isTransient still classifies it,
    // and the code says so too for anything that prefers codes.
    const deadline = setTimeout(() => {
      // Typed as an ErrnoException so the `code` this deliberately attaches is describable. Recovery in
      // this repo is keyed on CODES and never on message text (`capture-faults.mjs`), so the field is
      // load-bearing rather than decorative.
      const error = (
        new Error(`Request to ${url} timed out after ${timeoutMs} ms`) as NodeJS.ErrnoException);
      error.code = "ETIMEDOUT";
      req.destroy(error);
    }, timeoutMs);

    /** @param {unknown} error */
    function failWith(error: unknown) {
      clearTimeout(deadline);
      reject(error);
    }

    // KEEPALIVE, KEPT ON PRECAUTIONARY GROUNDS ONLY. ITS DIAGNOSIS WAS WRONG, AND THE REASON IS TOPOLOGY.
    //
    // The story attached to this was: a capture holds a connection SILENT for minutes, so NAT and Wi-Fi
    // power-save reap it as idle. It was argued from *High Performance Browser Networking* -- "Most mobile
    // carriers set a 5-30 minute NAT connection timeout" -- and that passage is about MOBILE CARRIERS AND
    // THE PUBLIC INTERNET.
    //
    // THIS IS A LAN. The control plane and every worker sit on the same /24; the route between them is
    // `link#14`, direct on the link layer with no gateway hop. NAT happens at the router on the
    // way OUT. There is no translation table between these hosts, so there is nothing here that a NAT
    // timeout could expire. The theory was inapplicable from the first line, and the mismatch went
    // unnoticed because the quotation fitted the SYMPTOM.
    //
    // The measurements agree, which is how it was caught rather than believed. Keepalive explicitly OFF,
    // ~26 s silent captures:
    //
    //     8 sequential on one box        0 lost
    //     15 across five boxes at once   0 lost    <- the exact condition the 9/40 was measured under
    //
    // 0 of 23. At the old 22% rate P(0 in 23) = 0.78^23 = 0.4%, so the rate really did change -- and these
    // trials ran WITHOUT the keepalive, so it is not shown to be why. Losses went 9/40 -> 0 when it landed
    // and nobody tested removing it: "a green result vouches for the mechanism", committed inside the work
    // that kept finding that trap elsewhere.
    //
    // So: the losses were REAL and their cause is UNKNOWN. NAT is excluded by topology; the worker's own
    // `keepAliveTimeout` and `requestTimeout` were excluded by measurement; the boxes' NIC power settings
    // were already correct. What is left is the Wi-Fi association itself or something transient, and this
    // comment will not guess again.
    //
    // Item A is unaffected and that is the useful part: the async path holds no long connection at all, so
    // it is immune whatever the mechanism was. A STRUCTURAL FIX DOES NOT DEPEND ON THE DIAGNOSIS BEING
    // RIGHT, which is the strongest argument there is for preferring one.

    req.on("socket", (socket) => {
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      // Nagle would batch the request itself; a capture POST is one small write followed by a wait, so
      // there is nothing to batch and delaying it only adds latency to the request that starts the work.
      socket.setNoDelay(true);
    });

    req.on("error", failWith);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** @param {string | null} payload */
function requestHeaders(payload: string | null) {
  if (payload === null) return { accept: "application/json" };
  return {
    accept: "application/json",
    "content-type": "application/json",
    // Explicit, so the worker never has to read a chunked body. Byte length, not character count:
    // a non-ASCII task string would otherwise under-declare and the worker would wait for bytes
    // that never arrive.
    "content-length": Buffer.byteLength(payload),
  };
}

/**
 * @param {import("node:http").IncomingMessage} res
 * @returns {Promise<string>}
 */
function collect(res: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { text += chunk; });
    res.on("end", () => resolve(text));
    res.on("error", reject);
  });
}

/**
 * Parsed JSON, or undefined — a worker error page is not a parse failure worth throwing over.
 * @param {string} text
 */
function parse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ======================================================================================================================
// fleet-env
// carried from packages/worker-fleet/src/fleet-env.ts
// ======================================================================================================================

/**
 * The fleet named by the environment — ONE parser, because there were three that did not agree.
 *
 * `doctor.mjs` preferred `A11Y_WORKERS`, `check-worker-code.mjs` preferred `A11Y_WORKER`, and the
 * dataset runner read only `A11Y_WORKERS`. With both variables set, `doctor` and `worker:code` reported
 * on **different machines** — so "doctor says the fleet is fine" and "worker:code says a worker is
 * stale" could be statements about two disjoint sets, with nothing to say so.
 *
 * `A11Y_WORKERS` wins, matching the dataset runner: the plural names the pool a run dispatches across,
 * and a diagnostic that describes a different set from the one that will do the work is worse than no
 * diagnostic. Each entry is trimmed and de-slashed, because `A11Y_WORKERS=a, b` otherwise yields a URL
 * with a leading space — a configuration typo wearing a dead-machine costume.
 *
 * Returns `[]` rather than null when neither is set: "no worker was named" is a normal state that means
 * "find the local VMs", and every caller already branches on emptiness.
 *
 * @returns {Array<{ name: string, url: string }>}
 */
export function configuredWorkers(): Array<{ name: string; url: string; }> {
  const raw = process.env.A11Y_WORKERS ?? process.env.A11Y_WORKER ?? "";
  const named = process.env.A11Y_WORKERS !== undefined ? "A11Y_WORKERS" : "A11Y_WORKER";
  return raw.split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    // Validated, because this is the ENV route into the same defect the `--worker=` clients now refuse.
    // `A11Y_WORKERS=http://:8765` used to pass straight through to every consumer of this function --
    // `doctor`, `worker:code`, `fleet:status`, the dataset runner -- each of which would then report a
    // machine that cannot be addressed as one that is not answering. Note the empty case is untouched:
    // "no worker was named" is a normal state meaning "find the local VMs", and every caller branches on it.
    .map((url) => assertWorkerUrl(url, { source: named }))
    .map((url) => ({ name: url.replace(/^https?:\/\//, ""), url }));
}

/** A line that declares a host address, ignoring anything commented out. */
const HOST_LINE = /^\s*ansible_host\s*:\s*(\S+)\s*$/;

/** A mapping key, with or without an inline value. Indentation is the only thing that says where it sits. */
const KEY_LINE = /^(\s*)([A-Za-z_][\w.-]*)\s*:/;

/**
 * The inventory group whose hosts are capture workers.
 *
 * This reader was GROUPLESS until 2026-08-21, and that was a live hazard rather than an untidiness: every
 * `ansible_host:` in the file became `http://<addr>:8765`, so adding any non-worker host to `inventory.yml`
 * -- the lab container, the control container, a switch -- would have silently added a phantom worker to
 * `A11Y_WORKERS`, and a run would have dispatched capture cases to it. That is the exact failure this
 * module's own header says it exists to prevent ("dispatched to but never updated", "both of those are
 * silent"), arriving through the door nobody had shut.
 */
export const WORKER_GROUP = "a11y_workers";

/**
 * One frame of the indentation stack: a key and the column it started at.
 */
export type Frame = {indent: number, key: string};

/**
 * The group a host sits in: the key directly beneath `children`.
 *
 * Ansible nests as `all.children.<group>.hosts.<name>`, so the group is positional rather than something
 * to pattern-match on a name. Reading it from the path means a group added later needs no change here.
 */
/** @param {Array<string|undefined>} path @returns {string|undefined} */
function groupOf(path: Array<string | undefined>): string | undefined {
  const children = path.indexOf("children");
  return children === -1 ? undefined : path[children + 1];
}

/**
 * Track the YAML path by indentation — a stack, not a parser.
 *
 * Deliberately not a YAML library, for the reason the header gives about `ansible-inventory`: the control
 * plane must be able to read the fleet without installing anything. Indentation is sufficient because the
 * only question asked of the path is which group a host is in.
 */
/** @param {Frame[]} stack @param {string} line */
function descend(stack: Frame[], line: string) {
  const match = line.match(KEY_LINE);
  if (!match) return;
  const indent = match[1].length;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  stack.push({ indent, key: match[2] });
}

/**
 * Which group each line of the inventory sits in, index-aligned with `text.split(/\r?\n/)`.
 *
 * Exported so there is ONE group implementation. `fleet-discover.mjs` has its own host reader with its own
 * regexes -- two readers of one file, which this repo's notes call its most expensive recurring shape -- and
 * when this module became group-aware that one did not, so `fleet:discover` probed the lab container on
 * :8765 and reported it "ASLEEP?". A phantom worker in the diagnostic instead of in the dispatch list is
 * still a phantom worker. Rather than teach a second parser about groups, both now ask this.
 *
 * @param {string} text
 * @returns {Array<string | undefined>}
 */
export function groupPerLine(text: string): Array<string | undefined> {
  /** @type {Frame[]} */
  const stack: Frame[] = [];
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return groupOf(stack.map((f) => f.key));
    if (!HOST_LINE.test(line)) descend(stack, line);
    return groupOf(stack.map((f) => f.key));
  });
}

export const DEFAULT_WORKER_PORT = 8765;

/** Anything that mentions the key but does not parse — a reformat, a quoted value, a list. */
const SUSPECT = /ansible_host\s*:/;

/**
 * A host var declaring whether the host is in the CAPTURE SET. Absent means in: the default is unchanged, so
 * a host that says nothing needs no inventory edit.
 */
const CAPTURE_KEY = "a11y_capture";

const CAPTURE_LINE = new RegExp(`^(\\s*)${CAPTURE_KEY}\\s*:\\s*(\\S+)\\s*$`);

const CAPTURE_SUSPECT = new RegExp(`${CAPTURE_KEY}\\s*:`);

/**
 * A host as the inventory declares it — the ADDRESS and the NAME together.
 *
 * They travel as one value because separating them is what sent `fleet:sleep` at the wrong machine: every
 * tool that ACTS on a worker takes the name, every tool that REPORTS on one printed the address, and
 * nothing mapped between them. `collectHost` explains the incident.
 *
 * `capture` is false for a host that declares `a11y_capture: false`: enrolled, served, deployed to, and not
 * handed corpus cases.
 */
export type Host = {name: string|undefined, host: string, capture: boolean};

/**
 * The hosts of one inventory group, each with whether it is in the capture set.
 *
 * ONE reader for both questions ("the whole fleet" and "the capture set"), because a second pass over the
 * file is a second parser, and this repo has paid for that shape already (`fleet-discover.mjs`).
 *
 * @param {string} text
 * @param {string} group
 * @returns {Host[]}
 */
function hostsInGroup(text: string, group: string): Host[] {
  /** @type {Host[]} */
  const hosts: Host[] = [];
  /** @type {Frame[]} */
  const stack: Frame[] = [];
  /** @type {Map<string, {capture: boolean, line: number}>} */
  const declared: Map<string, { capture: boolean; line: number; }> = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) {
      collectHost(hosts, { match, index, stack, group });
      return;
    }
    if (CAPTURE_SUSPECT.test(line)) {
      readCaptureDeclaration(declared, { line, index, stack });
      return;
    }
    if (SUSPECT.test(line)) {
      throw new Error(
        `inventory.yml:${index + 1} looks like a host entry but does not parse: ${line.trim()}\n`
        + "This reader understands `ansible_host: <address>` and nothing else, deliberately — a fleet list "
        + "that silently comes up short is invisible, because a run with fewer workers looks normal.");
    }
    descend(stack, line);
  });
  if (!hosts.length) {
    throw new Error(`no hosts found under ${group}.hosts in inventory.yml. Add one before running.`);
  }
  return applyCaptureDeclarations(hosts, declared, group);
}

/**
 * Record `a11y_capture: true|false` against the host whose var it is — the nearest enclosing key.
 *
 * Strict for the reason the header gives: `a11y_capture: no` or `"false"` that this reader took for "not
 * declared" would leave a cold host in the capture set, and a capture guard would then refuse the run
 * naming the wrong cause. Only the two literals are read; anything else names its line.
 *
 * @param {Map<string, {capture: boolean, line: number}>} declared
 * @param {{line: string, index: number, stack: Frame[]}} at
 */
function readCaptureDeclaration(declared: Map<string, { capture: boolean; line: number; }>, { line, index, stack }: { line: string; index: number; stack: Frame[]; }) {
  const match = line.match(CAPTURE_LINE);
  const value = match?.[2];
  if (value !== "true" && value !== "false") {
    throw new Error(
      `inventory.yml:${index + 1} declares ${CAPTURE_KEY} but not as \`true\` or \`false\`: ${line.trim()}\n`
      + "This reader takes those two literals and nothing else, so a host is never left in or out of the "
      + "capture set by a spelling it did not understand.");
  }
  const indent = (match as RegExpMatchArray)[1].length;
  const owner = [...stack].reverse().find((frame) => frame.indent < indent)?.key;
  declared.set(owner ?? "", { capture: value === "true", line: index + 1 });
}

/**
 * Attach each declaration to its host, and refuse one that belongs to no host of the group.
 *
 * A declaration on a group or on a host in another group would otherwise be read and dropped, which is the
 * silent shape this module exists to refuse: somebody believes a machine is out of the capture set and it is
 * not.
 *
 * @param {Host[]} hosts
 * @param {Map<string, {capture: boolean, line: number}>} declared
 * @param {string} group
 * @returns {Host[]}
 */
function applyCaptureDeclarations(hosts: Host[], declared: Map<string, { capture: boolean; line: number; }>, group: string): Host[] {
  const names = new Set(hosts.map((host) => host.name));
  for (const [owner, { line }] of declared) {
    if (!names.has(owner)) {
      throw new Error(
        `inventory.yml:${line} declares ${CAPTURE_KEY} on \`${owner}\`, which is not a host in ${group}.\n`
        + `Declare it directly under the host (\`${group}.hosts.<name>.${CAPTURE_KEY}\`); it is not read anywhere else.`);
    }
  }
  return hosts.map((host) => ({ ...host, capture: declared.get(host.name ?? "")?.capture ?? true }));
}

/**
 * Worker URLs from the text of an inventory file.
 *
 * `scope` says which question is asked. `"fleet"` (the default) is every enrolled worker -- what `doctor`,
 * `worker:code`, `fleet:status` and the deploy tooling mean, and they must keep seeing a worker that is
 * serving but not capturing. `"capture"` is the fleet minus every host that declares `a11y_capture: false`
 * -- what `A11Y_WORKERS` means. It is a string and not a flag because a boolean argument does not say
 * which of the two you got.
 *
 * Exported and pure so the strictness above is testable: a reader that has never been shown to reject
 * anything is a reader nobody knows the limits of.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string, scope?: "fleet" | "capture" }} [options]
 * @returns {string[]}
 */
export function workersFromInventory(text: string, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP, scope = "fleet" }: { port?: number; group?: string; scope?: "fleet" | "capture"; } = {}): string[] {
  const hosts = hostsInGroup(text, group);
  const chosen = scope === "capture" ? hosts.filter((host) => host.capture) : hosts;
  if (!chosen.length) {
    // An empty A11Y_WORKERS means "find the local VMs", which do not exist on the control plane -- so an
    // inventory with every host excluded must fail HERE, naming the cause, not as something unrelated.
    throw new Error(`every host under ${group}.hosts declares ${CAPTURE_KEY}: false, so the capture set is empty.`);
  }
  return chosen.map(({ host }) => `http://${host}:${port}`);
}

/**
 * The inventory as `{ url -> name }`, so a report can say which machine a command would act on.
 *
 * Same parser, same group rules — deliberately not a second reader of the same file, which this repo
 * calls its most expensive recurring shape and has already paid for once in `fleet-discover.mjs`.
 *
 * @param {string} text
 * @param {{ port?: number, group?: string }} [options]
 * @returns {Record<string, string>}
 */
export function workerNamesFromInventory(text: string, { port = DEFAULT_WORKER_PORT, group = WORKER_GROUP }: { port?: number; group?: string; } = {}): Record<string, string> {
  /** @type {Host[]} */
  const hosts: Host[] = [];
  /** @type {Frame[]} */
  const stack: Frame[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(HOST_LINE);
    if (match) return collectHost(hosts, { match, index, stack, group });
    descend(stack, line);
  });
  // Falls back to the ADDRESS when the inventory nests a host without a name. That cannot happen in a
  // well-formed inventory — Ansible keys hosts by name — but `undefined` reaching a report would print as
  // the string "undefined", which is this repo's worst failure shape: a value that looks like an answer.
  // An address is a worse label than a name and still identifies the machine, which is what this map is for.
  return Object.fromEntries(hosts.map(({ name, host }) => [`http://${host}:${port}`, name ?? host]));
}

/**
 * Keep this host if it is in the worker group; refuse it if it is in no group at all.
 *
 * A host outside every group is the ambiguous case, and it gets an error rather than a default. Including
 * it recreates the phantom-worker bug; dropping it silently is how a fleet list comes up short — and this
 * module exists because both of those are invisible. So it says which line, and which group it expected.
 *
 * @param {Host[]} hosts
 * @param {{match: RegExpMatchArray, index: number, stack: Frame[], group: string}} found
 */
function collectHost(hosts: Host[], { match, index, stack, group }: { match: RegExpMatchArray; index: number; stack: Frame[]; group: string; }) {
  const found = groupOf(stack.map((frame) => frame.key));
  if (found === group) {
    // The inventory NAME comes along with the address. Ansible nests the host as
    // `...hosts.<name>.ansible_host`, so the name is the innermost frame the stack is still holding.
    //
    // Carried because every tool that ACTS on a worker takes the name (`-l a11y-worker-4`) while every
    // tool that REPORTS on one printed only the address — and nothing mapped them. On 2026-08-24 that
    // sent `fleet:sleep` at the wrong machine: `fleet:status` named .224 as the Edge-drifted box, and
    // .224 is a11y-worker-FIVE. Two commands, one fleet, no shared vocabulary.
    hosts.push({ name: stack[stack.length - 1]?.key, host: match[1].replace(/^["']|["']$/g, ""), capture: true });
    return;
  }
  if (found === undefined) {
    throw new Error(
      `inventory.yml:${index + 1} declares a host outside any group: ${match[0].trim()}\n`
      + `This reader takes workers from \`${group}\` only, so it cannot tell whether an ungrouped host is a `
      + "capture worker or something else on the network. Nest it under `all.children.<group>.hosts`.");
  }
}

/** The port the group vars declare, so it is stated once and not guessed here. */
/** @param {string} text @returns {number} */
export function portFromGroupVars(text: string): number {
  const match = text.match(/^\s*a11y_port\s*:\s*(\d+)\s*$/m);
  return match ? Number(match[1]) : DEFAULT_WORKER_PORT;
}

// ======================================================================================================================
// cli-flags
// carried from packages/worker-fleet/src/cli-flags.ts
// ======================================================================================================================

/**
 * Refuse a flag this command does not read.
 *
 * Every CLI here parses argv the same way — `process.argv.find((a) => a.startsWith("--only="))` or
 * `process.argv.includes("--resume")` — and every one of them therefore IGNORES anything it does not
 * recognise. A mistyped, renamed or hallucinated flag runs the default and reports success, and the
 * operator believes their value was applied. That is the same defect as an Ansible extra var a job does
 * not read, one layer out, and this repo has paid for it twice:
 *
 *   - a blocker's own message told the reader to run `--write-baseline`; the flag is `--update-baseline`
 *   - `--only=route-title-stale` covered 1 of the 7 cases in that family, because the match was exact-id
 *
 * Neither produced an error. Both produced a plausible wrong answer, which this file's governing rule
 * says to replace with a refusal that names the cause.
 *
 * ## Why the known list is passed in rather than read from the caller's source
 *
 * Deriving it at runtime — reading the calling module and regexing out its `--flags` — needs no
 * maintenance, and is wrong for one reason that matters: a CLI whose flags are consumed by a HELPER in
 * another module would refuse them, so the guard would break exactly the commands with the most moving
 * parts. The list is explicit here and `cli-flags.test.ts` derives the same set from source and pins the
 * two equal, which is this repo's remedy when a duplication is forced.
 */

/** How far apart two flags may be and still be worth suggesting. One typo, or one word. */
const NEAR = 4;

/**
 * Levenshtein, small and iterative — the inputs are flag names, never long strings.
 * @param {string} a @param {string} b @returns {number}
 */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The flag name alone: `--shard=0/4` and `--shard` both name `--shard`.
 * @param {string} argument @returns {string}
 */
export function nameOf(argument: string): string {
  const equals = argument.indexOf("=");
  return equals === -1 ? argument : argument.slice(0, equals);
}

/**
 * `--name=value`'s value, or `undefined` if `--name=` was never passed. audit §9's "argv parsing" row:
 * VALIDATION is owned here (`refuseUnknownFlags`), but 15+ files each hand-rolled this exact three-line
 * idiom for EXTRACTION, and one of them had already drifted from the rest.
 *
 * MEASURED before writing this, across all fifteen, against five vectors (a normal value, a missing flag,
 * an empty value, a repeated flag, and a value containing its own `=`): fourteen agreed on all five —
 * `argv.find((a) => a.startsWith("--name=")).slice("--name=".length)`, verbatim or with `name` templated
 * in. `fleet-discover.mjs`'s `arg()` used `.split("=")[1]` instead, which is identical on four vectors and
 * silently WRONG on the fifth: `--url=http://host?a=b` came back as `"http://host?a"`, truncated at the
 * value's own `=`. Dormant today — that helper is only ever asked for `--cidr=` and `--port=`, neither of
 * which can contain one — but a live discrepancy the day it is asked for a URL or a `key=value` pair.
 *
 * Kept as `.slice`, matching the fourteen rather than the one, and `fleet-discover.mjs` converted to it.
 *
 * @param {readonly string[]} argv @param {string} name
 * @returns {string | undefined}
 */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/**
 * Which of `argv` are flags this command does not know. PURE, so it is testable without a process.
 *
 * A bare `--` is npm's separator and never a flag. Anything not starting with `-` is positional — a URL,
 * a worker address, a page path — and is not this guard's business.
 *
 * SINGLE-DASH FLAGS ARE INSPECTED TOO, AND THE OMISSION COST A 14-MINUTE FLEET OPERATION.
 *
 * This read `startsWith("--")`, on the reasoning that only long flags are ever this repo's own. But an
 * ANSIBLE-shaped argument is single-dash, and several of these commands wrap `ansible-playbook` — so
 * `npm run fleet:provision -- -e worker_edge_allow_downgrade=true` passed straight through the guard,
 * was never forwarded by the wrapper, and the whole fleet was provisioned WITHOUT the authorisation the
 * operator believed they had given. Measured 2026-09-05. The role then refused, correctly, with a message
 * telling the operator to pass the very flag they had just passed.
 *
 * That is precisely the defect this file exists to prevent — "an ignored flag runs the default and reports
 * success" — surviving inside its own remedy, because the remedy was written to match one flag SHAPE
 * rather than the idea of a flag. `-e` is not a URL and not a page path; nothing positional here begins
 * with a dash followed by a letter, which is what makes this safe to refuse rather than merely warn on.
 */
/**
 * @param {string[]} argv @param {string[]} known @returns {string[]}
 */
export function unknownFlags(argv: string[], known: string[]): string[] {
  const accepted = new Set(known.map(nameOf));
  return argv
    .filter((argument) => argument !== "--" && (argument.startsWith("--") || /^-[A-Za-z]/.test(argument)))
    .map(nameOf)
    .filter((flag) => !accepted.has(flag));
}

/**
 * The closest known flag, when there is one close enough to be a likely typo rather than a guess.
 * @param {string} flag @param {string[]} known @returns {string | undefined}
 */
export function didYouMean(flag: string, known: string[]): string | undefined {
  const ranked = known.map(nameOf)
    .map((candidate) => ({ candidate, gap: distance(flag, candidate) }))
    .sort((left, right) => left.gap - right.gap);
  return ranked[0] && ranked[0].gap <= NEAR ? ranked[0].candidate : undefined;
}

/**
 * Refuse, naming the flag and what this command does take. Exits 2; does not return on failure.
 *
 * `command` names the thing a human typed — the npm script, not the file — because that is what they will
 * retype. Defaults to the script's basename, which is right for the ones invoked directly.
 */
/**
 * @param {string[]} known  Every flag this command reads, `--name` or `--name=`.
 * @param {{entry: string, argv?: string[], command?: string}} options
 *   `entry` is the caller's `import.meta.url`, and it is REQUIRED. `command` names the thing a HUMAN
 *   typed — the npm script, not the file — because that is what they will retype.
 */
// NO `= {}` DEFAULT, because `entry` is required and the docstring above has always said so. A default
// that lets the whole options object be omitted contradicts that: it produces `entry === undefined`, and
// the guard below decides whether THIS module is the command by comparing `entry` against argv[1] -- so a
// caller who forgot it would get a guard that silently never fires. Types found the contradiction the
// moment this file entered the program. Every one of the 60 real call sites passes it.
export function refuseUnknownFlags(known: string[], { entry, argv = process.argv.slice(2), command }: { entry: string; argv?: string[]; command?: string; }) {
  // ONLY WHEN THIS MODULE IS THE COMMAND, never when it is imported.
  //
  // These calls sit at module top level, so they run on IMPORT — and then inspect the IMPORTING process's
  // argv. Measured 2026-08-27, an hour after the guards went in: `capture-real-pages --role=calibration`
  // imports `fleet-env.mjs`, whose guard woke up, saw `--role`, decided it did not know it, and killed a
  // 50-page capture with "unknown flag --role — did you mean --list?". The guard was right about its own
  // flags and asking the wrong process.
  //
  // `entry` is REQUIRED rather than defaulted, for the reason `createHostThrottle`'s `minGapMs` is: a
  // default here would silently restore exactly this behaviour for any caller who forgot it, and the
  // failure mode is a guard that fires on somebody else's command line.
  if (!entry) {
    throw new TypeError("refuseUnknownFlags needs { entry: import.meta.url } — without it the guard runs "
      + "on import and inspects the importing process's flags");
  }
  // REALPATH'D, and without it this guard silently does not fire through a symlink — #237.
  //
  // An entry guard in the realpath'd form reads
  // `import.meta.url === pathToFileURL(process.argv[1] ? realpathSync(process.argv[1]) : "").href`, and
  // this comparison had no `realpathSync`. So when `argv[1]` reaches such a script through a symlink — npm's
  // own `.bin` links are symlinks, which is why those call sites resolve — the OUTER condition is true and
  // this one is FALSE. `main()` runs; the flag guard returns early and inspects nothing.
  //
  // NOT EVERY CALL SITE HAS THAT FORM (#1248). Some still compare the plain, symlink-blind
  // `pathToFileURL(process.argv[1] ?? "")`, which fails the other way through a symlink: the OUTER condition is
  // false, `main()` never runs, and the tool exits 0. Which files still do is `KNOWN_PLAIN_ENTRY_GUARDS` in
  // `entry-points.test.ts` (#1086), a ratchet that may shrink and may not grow. It is the list of record, so no
  // count is repeated here.
  //
  // Measured on `piped-exit-status-guard.mjs`, same file, same flag:
  //
  //   node scripts/tmp-symlink-probe.mjs --bogus 'echo hi'   -> ran, exit 0, flag IGNORED
  //   node packages/guards/src/piped-exit-status-guard.mjs --bogus '...'  -> refused, exit 2
  //
  // Through the symlink the mistyped flag is ignored and the command reports success — which is the
  // sentence this refusal itself prints as the reason it exists.
  //
  // It is a remedy whose TRIGGER is narrower than the thing it guards, the `refreshBrowseBuffer` shape:
  // reachable from the right path, with a condition that could not be true there. And the census
  // (`cli-flags.test.ts`) cannot see it, because it asserts a file CONTAINS `refuseUnknownFlags(` — it
  // cannot ask whether that call can FIRE, so every guarded CLI reads GUARDED either way.
  //
  // `realpathSync` THROWS on a path that does not exist, and `process.argv[1]` is absent for `node -e`
  // and `node --eval`. Absent stays absent rather than becoming a throw: the guard must be inert when
  // there is no script, never fatal.
  /** The invoking script's REAL path as a URL, so a symlinked `argv[1]` still matches `entry`. */
  let invoked;
  try {
    invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
  } catch {
    invoked = pathToFileURL(process.argv[1] ?? "").href; // unresolvable: compare what we were given
  }
  if (entry !== invoked) return;
  const unknown = unknownFlags(argv, known);
  if (unknown.length === 0) return;
  const name = command ?? basename(process.argv[1] ?? "this command");
  for (const flag of unknown) {
    const near = didYouMean(flag, known);
    console.error(`  ${name}: unknown flag ${flag}${near ? ` — did you mean ${near}?` : ""}`);
  }
  // "It takes: " with nothing after it is what a command taking NO flags printed, and that reads like the
  // guard failed to find its own list rather than like an answer. First hit by `release:provenance`, the
  // first zero-flag CLI here -- the branch existed for months with no caller to exercise it.
  const accepted = [...known].map(nameOf).sort();
  console.error(accepted.length === 0
    ? "  It takes no flags at all."
    : `  It takes: ${accepted.join(" ")}`);
  console.error("  Refusing rather than ignoring it: an ignored flag runs the default and reports success.");
  process.exit(2);
}

// ======================================================================================================================
// worker-health
// carried from packages/worker-fleet/src/worker-health.ts
// ======================================================================================================================

/**
 * Is a worker healthy, degraded, or unusable — from the vitals it reports.
 *
 * This exists because a guest whose NVDA was broken on **every single capture** sat in the pool at four
 * times the cost of its neighbours and nothing noticed. Measured, same page, same code, same moment:
 *
 *   worker 1   4 captures, 4 recoveries, 0 failures   nvdaStart 19.1s/capture   WALL 122.9s
 *   worker 2   9 captures, 0 recoveries, 0 failures   nvdaStart  0.0s/capture   WALL  40.6s
 *
 * Two things conspired to hide it. The worker's own retry absorbed every fault, so `failures` stayed 0
 * and the run's eviction rule — three consecutive FAILURES — could never fire. And wall-clock time only
 * said "slower", which I twice misattributed to Edge.
 *
 * So degradation is defined on the recovery RATE, not on failures. `recoveries` counts faults the worker
 * papered over for the caller, which makes it the one number that rises while everything still appears
 * to work.
 *
 * **Degraded workers keep taking work.** They are slow, not broken, and pulling one from a three-VM pool
 * costs more throughput than it saves. This mirrors the standard health-check split — a degraded service
 * returns 200 and is *surfaced* rather than restarted, because declaring degraded things unhealthy is how
 * you end up with nothing left to serve (Distributed Systems with Node.js, ch. 4).
 */

/**
 * Can this worker take a capture right now? ONE definition, because there were four that disagreed.
 *
 * `ready` is about the ENVIRONMENT — Edge resolvable, ForegroundLockTimeout 0, the worker free — and a
 * worker reports `ready: false` while NVDA warms up after a boot, which is normal and self-correcting.
 *
 * The subtlety, and the reason this is `!== false` rather than `=== true`: **a worker predating the
 * field reports neither.** Treating absent as ready keeps an un-redeployed guest working instead of
 * stalling a run against it forever; staleness has its own detector in `npm run worker:code`. The
 * dataset runner got this right and said so. `repeat-capture.mjs` tested `health.ready` for truthiness
 * and `capture-real-pages.mjs` tested `=== true`, so both would have waited out their whole readiness
 * budget against a perfectly good older worker and then blamed the page.
 *
 * @param {{ busy?: boolean, ready?: boolean } | null | undefined} health
 * @returns {boolean}
 */
export function workerIsUsable(health: { busy?: boolean; ready?: boolean; } | null | undefined): boolean {
  if (!health) return false;
  return !health.busy && health.ready !== false;
}

/** Below this many captures the rate is noise: one recovery out of one capture is not a pattern. */
const MIN_CAPTURES_TO_JUDGE = 4;

/** Above this share of captures needing a recovery, the guest is not merely unlucky. */
const DEGRADED_RECOVERY_SHARE = 0.5;

/**
 * @param {{ captures?: number, recoveries?: number, failures?: number } | null | undefined} vitals
 * @returns {{ degraded: boolean, reason: string | null, recoveryShare: number | null }}
 */
export function assessWorker(vitals: { captures?: number; recoveries?: number; failures?: number; } | null | undefined): { degraded: boolean; reason: string | null; recoveryShare: number | null; } {
  const captures = vitals?.captures ?? 0;
  const recoveries = vitals?.recoveries ?? 0;
  // Recoveries are counted per capture served, so the share can exceed nothing sensible above 1.
  const attempted = captures + (vitals?.failures ?? 0);
  if (attempted < MIN_CAPTURES_TO_JUDGE) {
    return { degraded: false, reason: null, recoveryShare: null };
  }
  const recoveryShare = recoveries / attempted;
  if (recoveryShare <= DEGRADED_RECOVERY_SHARE) {
    return { degraded: false, reason: null, recoveryShare };
  }
  return {
    degraded: true,
    recoveryShare,
    reason: `${recoveries} of ${attempted} captures needed a screen-reader recovery ` +
      `(${Math.round(recoveryShare * 100)}%) — this guest's NVDA is failing and every capture pays for it. ` +
      "Reinstall NVDA or re-provision it (docs/nvda-worker-runbook.md); it is still serving, just slowly.",
  };
}

// ======================================================================================================================
// fleet-consistency
// carried from packages/worker-fleet/src/fleet-consistency.ts
// ======================================================================================================================

/**
 * Are the guests actually interchangeable?
 *
 * The pool assumes they are. `captureAcrossPool` dispatches a case to whichever worker is free, the
 * cache lets any guest reuse another's evidence, and a good/bad pair is only comparable because both
 * halves came from equivalent machines. Every one of those assumptions is silently false the moment
 * two guests differ.
 *
 * They did differ, twice in one day, and neither was caught by tooling:
 *
 *   - Edge auto-updated to 151 on one guest while the others stayed on 150, despite the updater being
 *     policy-disabled. The cache key covers `browserVersion`, so evidence was not corrupted — but hit
 *     rates halved and the corpus became heterogeneous.
 *   - `StartupBoostEnabled` read 1 on two guests and 0 on a third. Nothing keys on that at all.
 *
 * The first was noticed by reading a boot log by eye; the second by a human looking at a screenshot of
 * a guest console. Neither is a detection mechanism. This is.
 *
 * Deliberately NOT fatal. A run on slightly mismatched guests is worse than one on matched guests and
 * far better than no run, and this project's rule is that a diagnostic must never be the thing that
 * takes the pool offline. It reports; the operator decides.
 */

/**
 * Fields that must match across the fleet, and why each one matters.
 *
 * `workerCode` is absent on purpose: it changes when a comment changes, and the deploy tooling already
 * verifies it against the checkout. Flagging it here would cry wolf on every reworded line.
 */
export const MUST_MATCH = [
  { path: "browserVersion", why: "Edge renders and announces differently across releases; it is in the cache key" },
  { path: "screenReaderVersion", why: "NVDA's wording changes between releases; it is in the cache key" },
  { path: "guidepupVersion", why: "guidepup parses NVDA's speech before we see it — 0.29.2 emitted an " +
      "intermittent U+FFFC where 0.31.0 emits a consistent empty segment, for the same page" },
  { path: "windowsVersion", why: "a second OS image would blend two corpora into one" },
  { path: "architecture", why: "ARM64 and x64 guests are not interchangeable evidence" },
  { path: "captureProtocol", why: "a guest on an older protocol produces evidence that means something else" },
  { path: "browserProfile", why: "a COLD browser profile is not the same evidence as a warm one: a fresh " +
      "`--user-data-dir` shows Edge's first-run surface, which NVDA's quick-nav escapes into and records " +
      "as phantom page content, and a learning profile is what drove the U+FFFC artefact from 3% to 31% " +
      "of affected captures. Two guests on different profiles are not interchangeable, and it is in the " +
      "cache key for the same reason. `adopted` on both sides means both predate the stamp, which is a " +
      "match rather than an unknown" },
  { path: "screenReaderSettings", why: "a guest capturing with `reportLanguage` off is blind to 3.1.2 and " +
      "one with it on is not — the same page yields different transcripts, so the two are not " +
      "interchangeable evidence. It is in the cache key for the same reason" },
  // A CACHE KEY that was not a consistency field, which is the worst combination.
  //
  // `provisionRevision` records what the guest actually has -- NVDA's config, Edge's policies,
  // ForegroundLockTimeout -- all of which change the evidence. It is already in the cache key
  // (`capture-cache.mjs`), so a fleet where one guest has been re-provisioned and the others report
  // `"unstamped"` produces two evidence populations. Nothing warned: the cache merely stopped hitting,
  // which reads as ordinary churn rather than as a split fleet. Re-provision the pool together.
  { path: "provisionRevision", why: "a re-provisioned guest has different NVDA/Edge configuration, and " +
      "it is already a cache key -- a split fleet shows up only as unexplained cache misses" },
  // A UNIFORMITY CLAIM PRINTED OVER A PROPERTY NOTHING CHECKED, which is the worst failure this file
  // can have -- worse than missing a field, because the operator was told the opposite.
  //
  // `fleet:status` printed "fleet CONSISTENT across 10 of 10 -- these workers are interchangeable for
  // capture" at 2026-09-22T18:21Z over a fleet running 1024x768 on five guests and 640x480 on the other
  // five (#1953; measured read-only on the live fleet, #1567/#1955). The nine fields above were all
  // matched and all true; the sentence they produced was not.
  //
  // `provisionRevision` does not already cover it, and this is the point. That stamp is written by the
  // provisioning script itself, so it records WHICH PROVISIONING RAN rather than what it achieved: a
  // guest whose display-driver install failed still gets the new stamp. All ten guests can report an
  // identical revision while five of them sit at 640x480 on a fallback adapter. A stamp cannot fail
  // closed on a thing it does not read.
  { path: "displayMode", why: "a guest capturing on a 640x480 desktop and one on 1024x768 are not " +
      "interchangeable evidence: the window is what a real display holds (#1561), and a page's CSS can " +
      "hide content below a width -- metoffice hides its h1 under 1280px. NOT a cache key: adding one " +
      "invalidates every cached capture, which is a separate and far more expensive decision than making " +
      "this sentence honest" },
  // The PIN, which is not the same field as the DESKTOP above (#1561). `displayMode` is what the screen
  // holds; this is what the worker asks Edge for, and a guest still running the pre-pin code asks for
  // nothing at all and gets `--start-maximized`. Both guests report the same `captureProtocol`, so the
  // protocol cannot separate them and a rolling deploy would otherwise split the corpus in silence --
  // which is the shape `provisionRevision` two entries up is here for, one deploy later.
  //
  // UNLIKE `displayMode`, this one IS a cache key (`environmentKey`), and that is a deliberate asymmetry
  // rather than an oversight: pinning the window is what makes the width a property of the capture rather
  // than of the box it ran on, so it is the value a stored capture can honestly be keyed by.
  { path: "windowSize", why: "a capture taken in a pinned 1024x768 window and one taken maximized on " +
      "whatever the desktop gave are not interchangeable evidence -- a page's CSS can hide content below " +
      "a width, and metoffice hides its h1 under 1280px. It is in the cache key (#1561), so a split " +
      "fleet also writes two evidence populations" },
  // THE RUNTIME THE EVIDENCE WAS PRODUCED BY -- and it is here as the THIRD STEP of `ceo`'s ruling on
  // #2063 rather than as a field arriving fresh: report it, pin provisioning so the fleet converges, and
  // only then may it gate (#2170). The first two are done. The pin is `worker_node_version` in the worker
  // role's `defaults/main.yml`, and the fleet converged on v24.20.0 at 2026-09-23T18:02Z -- read off all
  // ten guests' own `/health`, 10 of 10 reporting one value, against the 5/5 split measured at 06:55Z
  // that morning (`orchestrator`, #2170).
  //
  // WHY THE PRECONDITION WAS A `/health` READING AND NOT `provisionRevision`, which is the part worth
  // keeping: at 17:57Z, immediately after a CLEAN provision, three of the five upgraded guests still
  // reported v24.19.0. `/health` reports the runtime of the RUNNING worker process, not the installed
  // one, and only the deploy's restart moved them. That makes the reading stricter than "the pin
  // landed" -- which is the property this field needs, because the value it compares is written into
  // every corpus record BY that running process.
  { path: "nodeVersion", why: "the guest's Node runtime is recorded into every corpus record " +
      "(`export-screenreader-dataset.mjs`), so two guests on different runtimes write two populations " +
      "into one corpus and a good/bad pair can straddle them -- the comparison that pair exists to make " +
      "then carries a runtime difference nobody asked for. NOT a cache key: adding one invalidates every " +
      "capture stamped before it, which is the same separate and far more expensive decision " +
      "`displayMode` two entries up records" },
];

/**
 * THE THIRD CHANNEL: fields that are COMPARED AND NAMED, and that gate nothing — #2063.
 *
 * `MUST_MATCH` above is a capture gate in both its channels. A disagreement there sets `consistent:
 * false` and `capture-fleet-guard` exits 3; a field any compared guest fails to report lands in
 * `fields.coverage` and, since #2047, exits 3 as well. So a field that belongs in the REPORT but must not
 * refuse a run has nowhere to go in either — and adding it to one of them anyway is not a small
 * mis-filing: `displayAdapter` reads one value on nine guests and another on the tenth, one letter apart,
 * so a gate on it would refuse every capture on this fleet for ever.
 *
 * THIS CHANNEL IS A WAITING ROOM FOR SOME FIELDS AND A PERMANENT HOME FOR OTHERS, and the two must not be
 * confused. `nodeVersion` was the first kind: `ceo` ruled the order on #2063, 2026-09-23 — **report it,
 * then pin provisioning so the fleet converges, and only then may it join `MUST_MATCH`** — and #2170 is
 * that last step, taken once the fleet read one runtime on all ten guests. `displayAdapter` is the
 * second kind: the difference it reports is HARDWARE (`Intel(R) UHD Graphics 630` against
 * `Intel(R) HD Graphics 630` on one box), so no provisioning run converges it and it can never graduate
 * the way `nodeVersion` did. A field arriving here needs its exit named, or "not yet a gate" decays into
 * "never looked at again".
 *
 * So these fields are compared exactly as the gating ones are, and their drift is named on the verdict
 * line with each guest's value — but they contribute to NEITHER `mismatches` NOR `fields.coverage`, which
 * are the only two things any gate reads. A fleet differing on one of them is `consistent: true`.
 *
 * A field NOBODY reports is `unreported` here rather than silent, which is the same distinction #1997
 * drew for the gating fields: a field compared on nobody draws no values to disagree about and would
 * otherwise read exactly like a field every guest agrees on. It is the state `displayAdapter` sat in
 * until the worker carrying it was deployed on 2026-09-23, and the state any field added here starts in,
 * and it must be readable as such without refusing anything.
 */
export const REPORTED_ONLY = [
  // `ceo`'s fold-in on the same row: "nothing in this repo reports the display ADAPTER either ... whatever
  // shape this row lands for 'reported, visible, not yet a gate', the adapter belongs in it rather than in
  // a fourth row." It is the seam `displayMode` sat on -- on 2026-09-22, workers 2-6 on the Intel adapter,
  // 7-11 on Microsoft's Basic Display Adapter after a driver install failed rc 1014 -- and it is a DIFFERENT field
  // from the driver VERSION, which `ceo` ruled on #1567 does not split the fleet.
  { path: "displayAdapter", why: "the adapter is what decides whether a pinned display mode can be held " +
      "at all -- on 2026-09-22 workers 7-11 were on Microsoft's Basic Display Adapter and captured at " +
      "640x480 under a `provisionRevision` identical to their peers' (#1955); the pinned Intel driver " +
      "install resolved that, and all ten read an Intel adapter at CM_PROB_NONE on 2026-09-23. NOT a " +
      "gate, and no longer because nobody reports it: 10 of 10 guests report it since " +
      "2026-09-23T18:02Z, reading `Intel(R) UHD Graphics 630` on nine and `Intel(R) HD Graphics 630` " +
      "on one as of 2026-09-23. That single letter is a real hardware difference rather than a driver " +
      "fallback, so no provisioning run can converge it and a gate would refuse that guest for ever " +
      "(#2063, reading on #2170)" },
  // `windowsVersion` (`Win32_OperatingSystem.Version`, `10.0.<build>`) is in `MUST_MATCH` and does not move when
  // a monthly cumulative update lands, so two boxes one update apart read as the SAME value and the fleet read
  // as consistent. The revision does move, and it is a SEPARATE field because `windowsVersion` is a capture-cache-key
  // input: appending the UBR to it would invalidate every cached capture. THE EXIT: this is a waiting room, and it
  // graduates to `MUST_MATCH` once the fleet reads ONE value (the Done-when of #4405) -- report, then converge,
  // then gate, the order `nodeVersion` took (#2063/#2170). Until the worker carrying the field is released and
  // deployed it reads `unreported` on every box, which is why it is not a gate yet.
  { path: "windowsBuild", why: "two boxes one cumulative update apart share a `windowsVersion` and are not the " +
      "same Windows; the revision (`CurrentBuild.UBR`) is what tells them apart. NOT a gate yet: it graduates " +
      "to MUST_MATCH once the fleet reads one value (#4433, #4405)" },
  { path: "edgeUpdaterGuard.state", why: "a box whose Edge updater came back is one auto-update away from a " +
      "different browser than its peers: the guard task re-disables it every 15 minutes and records what it had " +
      "to change, and `stale` or `absent` is a guard that is not running or not yet provisioned. NOT a gate yet: " +
      "reported until the fleet's workers carry the field and the guard (#5021, #4405)" },
];

/**
 * One field the guests disagree about, and the guests' values for it.
 *
 * Named once because it is produced by `fleetConsistency` and consumed by `describeMismatches`, and the
 * two had already drifted apart the moment either was annotated — `object` on one side against
 * `Record<string, unknown>` on the other, which typecheck caught in the test that calls them in sequence.
 * Two spellings of one shape is the duplication this repo names as its most expensive recurring defect,
 * and a typedef is the cheapest form of "delete a copy".
 */
export type Mismatch = {field: string, why: string, values: Record<string, unknown>};

/** Edge policy values every guest must agree on, checked separately because they come from /diagnostics. */
export const POLICY_MUST_MATCH = ["StartupBoostEnabled", "BackgroundModeEnabled"];

/**
 * Which fields the verdict is actually ABOUT -- #1997.
 *
 * `compared` NAMES the fields at least one guest reported a value for; `unchecked` names the ones that
 * drew a value from NOBODY. The second list exists because `check()` below skips an absent value, which
 * is right (a rolling deploy must not flag the guest it has not reached yet) and has a cost: a field no
 * guest reports contributes no values, `new Set([]).size > 1` is false, and it reads as agreement.
 * A field compared on nobody and a field equal on everybody produced the IDENTICAL verdict.
 *
 * Measured 2026-09-22T20:09Z on the live fleet, at the merge of #1953: nine fields at 10/10 guests and
 * `displayMode` at 0/10, and `fleet:status` printed `fleet CONSISTENT across 10 of 10 -- these workers
 * are interchangeable for capture`. The display was still not compared. Naming the two lists is what
 * lets a reader tell "they agree" from "nobody was asked".
 *
 * `coverage` IS THE SAME QUESTION WITHOUT THE THRESHOLD -- #2019. The two lists above are a PARTITION on
 * "did anybody report it", which answers 0-of-10 and says nothing about 1-of-10; `fleet:status` read the
 * second as agreement about ten guests on the strength of one. So every asked field also carries how many
 * of the asked guests actually reported it, and the verdict draws its own line. `compared`/`unchecked`
 * stay because they are what a caller greps for the REMEDY -- a field at 0 sends a reader to the field,
 * a field at k sends them to the boxes -- and `coverage` is the measurement both are derived from.
 */
export type FieldReporters = {field: string, reported: number, asked: number};
export type FieldCoverage = {compared: string[], unchecked: string[], coverage: FieldReporters[]};

/**
 * One reported-only field that has something to say, and WHICH thing it is saying — #2063.
 *
 * `drifted` is the guests giving more than one value; `unreported` is some or all of them giving none.
 * Two states rather than a boolean because the REMEDY differs and the report has to name it: drift sends
 * a reader to the provisioning pin, silence sends them to the worker deploy. Neither is a refusal.
 *
 * It carries `reported`/`asked` for the same reason `FieldReporters` does — a count is what lets a reader
 * tell 0 of 10 from 9 of 10 — and the values map for the reason `Mismatch` does: drift detected and not
 * located is not actionable.
 */
export type ReportedDrift = {field: string, why: string, values: Record<string, unknown>, reported: number, asked: number, state: "drifted" | "unreported"};

/**
 * ONE FIELD READ ACROSS THE FLEET, before anybody decides what it means.
 *
 * Split out from `fleetConsistency` when the third channel arrived (#2063), because the READING and the
 * CONSEQUENCE are two things and only the second differs between the channels: `MUST_MATCH` turns a
 * reading into a mismatch and a coverage row, `REPORTED_ONLY` turns the same reading into a named drift
 * that gates nothing. One reader means the two channels cannot drift apart in how they compare — a
 * second copy of this loop is how a "reported-only" field would end up counted differently from a gating
 * one and nobody would know which was right.
 *
 * @param {Guest[]} present
 * @param {{field: string, why: string, source: (guest: Guest) => Record<string, unknown> | undefined,
 *   key: string}} ask `source` is the BLOCK this field lives in, not the value: coverage has to tell
 *   "the guest did not report this field" from "this caller never collected that block at all", and only
 *   the block answers the second
 * @returns {Reading}
 */
export type Guest = {worker: string, environment?: Record<string, unknown>, policy?: Record<string, unknown>};
export type Reading = {field: string, why: string, values: Record<string, unknown>, reported: number, asked: number};
function readField(present: Guest[], { field, why, source, key }: {
        field: string; why: string; source: (guest: Guest) => Record<string, unknown> | undefined;
        key: string;
    }): Reading {
  /** @type {Record<string, unknown>} */
  const values: Record<string, unknown> = {};
  // THE REPORTER COUNT IS COUNTED, NEVER READ OFF `values` -- #2019, and #2018 is why. The map is keyed
  // by worker name, and a caller that supplies guests without one collapses every guest onto a single
  // `undefined` key -- which `capture-real-pages.mjs` does -- so `Object.keys(values).length` reads 1
  // for any number of reporting guests, understating coverage in exactly the cases a coverage number
  // exists for. `asked` counts the guests that carried the BLOCK; `reported` counts the ones that
  // carried a VALUE in it; both are incremented on the guest, so neither can be collapsed by a key.
  let asked = 0;
  let reported = 0;
  for (const guest of present) {
    const block = source(guest);
    // A BLOCK THIS CALLER DID NOT COLLECT IS A FACT ABOUT THE PROBE, NOT THE FLEET. `/health` carries
    // no policy, so every production caller passes `policy: undefined`; calling those fields
    // "compared on nobody" would report a permanent gap on an axis nobody asked about, and drown the
    // one this list exists to surface.
    if (block === undefined || block === null) continue;
    asked += 1;
    const value = valueAt(block, key);
    // Absent is not a mismatch: an older worker that does not report a field must not be flagged
    // against newer ones. Only DIFFERING known values are evidence of drift.
    if (value !== undefined && value !== null) {
      reported += 1;
      values[guest.worker] = value;
    }
  }
  return { field, why, values, reported, asked };
}

/** A dotted path (`edgeUpdaterGuard.state`) read through the block; a missing or non-object segment reads as absent. */
function valueAt(block: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((value, segment) => (value as Record<string, unknown> | undefined)?.[segment], block);
}

/** How many distinct values the guests actually gave for one field. @param {Reading} reading */
function distinctValues({ values }: Reading) {
  return new Set(Object.values(values)).size;
}

/**
 * THE GATING CONSEQUENCE of a set of readings: what disagrees, and what nobody was asked.
 *
 * @param {Reading[]} readings
 * @returns {{mismatches: Mismatch[], fields: FieldCoverage}}
 */
function gateOn(readings: Reading[]): { mismatches: Mismatch[]; fields: FieldCoverage; } {
  /** @type {Mismatch[]} */
  const mismatches: Mismatch[] = [];
  /** @type {FieldCoverage} */
  const fields: FieldCoverage = { compared: [], unchecked: [], coverage: [] };
  for (const reading of readings) {
    const { field, why, values, reported, asked } = reading;
    // A FIELD NO GUEST REPORTED IS CANNOT ASK, NOT ALL AGREE. One value from one guest still counts as
    // compared -- that is the rolling-deploy case the skip above is for, and it is a different claim
    // from nobody having been asked at all. How MANY reported it is a third claim again, and it goes on
    // `coverage` rather than into this partition: the lists answer the remedy, the count answers the
    // verdict (#2019).
    if (asked > 0) {
      (reported > 0 ? fields.compared : fields.unchecked).push(field);
      fields.coverage.push({ field, reported, asked });
    }
    if (distinctValues(reading) > 1) mismatches.push({ field, why, values });
  }
  return { mismatches, fields };
}

/**
 * THE REPORTED-ONLY CONSEQUENCE: the same readings, as something to SAY rather than something to refuse.
 *
 * A field the guests agree on yields NOTHING, and that is the half of this that a test can most easily
 * lose. `drifted` and `unreported` are both findings; agreement is not, and an implementation that
 * returned every reported-only field regardless would satisfy "the drift is named" while naming a fleet
 * that has none.
 *
 * `asked === 0` yields nothing either, for the reason `gateOn` skips it: a block this caller never
 * collected is a fact about the probe.
 *
 * @param {Reading[]} readings
 * @returns {ReportedDrift[]}
 */
function driftOf(readings: Reading[]): ReportedDrift[] {
  return readings.flatMap((reading) => {
    const state = driftState(reading);
    return state === null ? [] : [{ ...reading, state }];
  });
}

/**
 * @param {Reading} reading
 * @returns {"drifted" | "unreported" | null}
 */
function driftState(reading: Reading): "drifted" | "unreported" | null {
  if (distinctValues(reading) > 1) return "drifted";
  // NOT REPORTED BY EVERYBODY WHO WAS ASKED, which covers #1997's nobody and #2019's some in one line --
  // for a GATING field those are two refusals with different remedies, and here they are one sentence
  // with the counts in it, because nothing is being refused.
  if (reading.asked > 0 && reading.reported < reading.asked) return "unreported";
  return null;
}

/**
 * Compare guests field by field.
 *
 * @param {Guest[]} guests
 * @returns {{consistent: boolean, mismatches: Mismatch[], compared: number, fields: FieldCoverage,
 *   reportedOnly: ReportedDrift[]}}
 *   `compared` is how many guests the verdict is actually ABOUT -- #920. A guest with no `environment`
 *   and no `policy` is dropped below before comparing, so it is not the length of what was passed in,
 *   and a caller that reports `consistent` without it is stating agreement over a set it cannot name.
 *   `fields` is that same question one axis over: WHICH fields the verdict is about -- #1997.
 *   `reportedOnly` is the third channel (#2063): compared, named, and part of NEITHER of the two above,
 *   which is what makes it something to report rather than something to refuse.
 */
export function fleetConsistency(guests: Guest[]): {
    consistent: boolean; mismatches: Mismatch[]; compared: number; fields: FieldCoverage;
    reportedOnly: ReportedDrift[];
} {
  const present = (guests ?? []).filter((g) => g && (g.environment || g.policy));
  // One guest is trivially consistent with itself, and zero is not a fleet. Neither is a finding, and
  // neither is a field nothing compared: with nobody to compare against, coverage is not a question yet.
  if (present.length < 2) {
    // A FRESH object rather than a shared constant: this is returned to a caller, and one shared literal
    // is one `push` away from a coverage list that grows across unrelated readings.
    return { consistent: true, mismatches: [], compared: present.length,
      fields: { compared: [], unchecked: [], coverage: [] }, reportedOnly: [] };
  }
  /** @param {Guest} guest */
  const environmentOf = (guest: Guest) => guest.environment;
  const gated = [
    ...MUST_MATCH.map(({ path, why }) =>
      readField(present, { field: path, why, source: environmentOf, key: path })),
    ...POLICY_MUST_MATCH.map((name) => readField(present, { field: `edgePolicy.${name}`,
      why: "guests with different browser behaviour are not interchangeable",
      source: (guest) => guest.policy, key: name })),
  ];
  const { mismatches, fields } = gateOn(gated);
  const reportedOnly = driftOf(REPORTED_ONLY.map(({ path, why }) =>
    readField(present, { field: path, why, source: environmentOf, key: path })));
  return { consistent: mismatches.length === 0, mismatches, compared: present.length, fields,
    reportedOnly };
}

/**
 * One line per reported-only field that has something to say, in `describeMismatches`'s own shape.
 *
 * SEPARATE FROM `describeMismatches` rather than a flag on it, because the two lines make different
 * claims and a reader has to be able to tell them apart at a glance: that one says the fleet is not
 * usable for a capture run, this one says the fleet is not identical and the run may proceed anyway.
 * Folding them would put the ruling's own distinction behind a boolean argument.
 *
 * @param {ReportedDrift[]} drifts
 * @returns {string[]}
 */
export function describeReportedOnly(drifts: ReportedDrift[]): string[] {
  return (drifts ?? []).map((drift) => `${drift.field}: ${reportedDetail(drift)} — ${drift.why}`);
}

/**
 * NAMED WITH EACH GUEST'S VALUE where there is one, and with the count where there is not.
 *
 * `not reported by any of 10 guests` is a different finding from `.2=v24.19.0 .7=v24.20.0` and from
 * `.2=v24.19.0 (1 of 10 guests reported it)`, and a reader acts differently on each: the first sends
 * them to the worker code, the second to the boxes, the third to the deploy that has not finished.
 *
 * @param {ReportedDrift} drift
 */
function reportedDetail({ values, reported, asked, state }: ReportedDrift) {
  const label = labelWorkers(Object.keys(values));
  const detail = Object.entries(values).map(([worker, value]) => `${label.get(worker)}=${value}`).join(" ");
  if (state === "drifted") return detail;
  if (reported === 0) return `not reported by any of ${asked} guests`;
  return `${detail} (${reported} of ${asked} guests reported it)`;
}

/**
 * One line per mismatch, naming the guests, so the report is actionable rather than just alarming.
 *
 * @param {Mismatch[]} mismatches
 * @returns {string[]}
 */
export function describeMismatches(mismatches: Mismatch[]): string[] {
  return (mismatches ?? []).map(({ field, values, why }) => {
    const label = labelWorkers(Object.keys(values));
    const detail = Object.entries(values).map(([worker, value]) => `${label.get(worker)}=${value}`).join(" ");
    return `${field}: ${detail} — ${why}`;
  });
}

/**
 * A short, UNAMBIGUOUS name per worker.
 *
 * `.4` is the right label for a guest's full `http://<address>:8765` in a table, and it is the wrong one the moment
 * two workers share a last octet — two boxes on one host with different ports, or two subnets that
 * happen to meet. The report then says which FIELD drifted and gives two identically-named values, which
 * is drift detected and not located: `browserVersion: .1=151.0.1 .1=150.0.9`.
 *
 * So the short form is used only while it distinguishes, and the full host:port otherwise. Shortening is
 * a readability optimisation, and it must never cost the thing the line exists to convey.
 */
/**
 * @param {string[]} workers
 * @returns {Map<string, string>}
 */
function labelWorkers(workers: string[]): Map<string, string> {
  const short = new Map(workers.map((w) => [w, shortWorker(w)]));
  const counts = new Map();
  for (const name of short.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(workers.map((w) => {
    // `short.get(w)` cannot miss — every worker was put in the map on the line above — but TypeScript
    // cannot know that, and `?? w` is the honest fallback rather than a non-null assertion: an unlabelled
    // worker printed as its own URL is still a located mismatch, which is what this function is for.
    const name = short.get(w) ?? w;
    return [w, (counts.get(name) ?? 0) > 1 ? hostAndPort(w) : name];
  }));
}

/** a guest's full `http://<address>:8765` is noise in a table; `.4` is not. @param {string} worker */
function shortWorker(worker: string) {
  const host = /\/\/([^:/]+)/.exec(worker)?.[1] ?? worker;
  return host.includes(".") ? `.${host.split(".").pop()}` : host;
}

/** @param {string} worker */
function hostAndPort(worker: string) {
  return /\/\/(.+?)\/?$/.exec(worker)?.[1] ?? worker;
}
