// @ts-check
/**
 * WHAT PROVES A MOVED WORKER'S IDENTITY BEFORE A WRITE LANDS (#2832, follow-up to #2803; `orchestrator`'s
 * ruling on the row, 2026-10-01).
 *
 * `fleet:deploy` and `fleet:provision` WRITE to a machine, and the worker has no authentication
 * (SECURITY.md), so "something serving /health is at that address" -- all that #2790/#2803's two MAC reads
 * plus `/health` establish -- is enough to AIM a capture and not enough to push a deploy. The one thing a
 * box answers with that only it holds is its SSH host key, already in `known_hosts` on the control plane.
 *
 * THE RULE, AS BUILT:
 *  - every worker connection looks its key up BY NAME (`HostKeyAlias=<inventory name>`,
 *    `group_vars/a11y_workers.yml`), so the key follows the box to whatever address it moves to;
 *  - a worker aimed at a RESOLVED (non-pin) address is checked with `StrictHostKeyChecking=yes`, never
 *    `accept-new`, never trust-on-first-use;
 *  - that address enters per run as a per-host `ansible_host` override in an inventory source of its own
 *    (`overrideInventory`), NEVER written to the inventory file (that is #2752's DHCP reservation). The
 *    override entry carries the strict flag in the SAME host block, so there is no way to ship an address
 *    without the check -- the override alone would be LESS safe than today, because `accept-new` would
 *    trust whatever answers at a new address;
 *  - a moved worker whose name has no recorded key, or whose key does not match what answers, refuses the
 *    WHOLE run by name (`identityGate`), and `--allow-offline=<name>` is how a human proceeds without it.
 *
 * RULED OUT, so nobody re-proposes them: the MAC/neighbour read (discovery, not identity), `/health`,
 * `provisionRevision` (identical on every box by design) and the shared fleet SSH key (every worker accepts
 * it, so a swap between two workers authenticates fine). And nothing here seeds from `ssh-keyscan`: a scan
 * proves nothing about who answered.
 *
 * A RELATIVE-IMPORT-ONLY, NODE-BUILTIN-ONLY MODULE: the control plane runs from a raw git checkout with no
 * `npm install` (ADR 0012, `control-has-no-dependencies.test.ts`).
 */

/** An inventory worker, by name. Contains the name's shape so it is safe in a remote shell and in YAML. */
export const WORKER_NAME = /^a11y-worker-[0-9]{1,3}$/;
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
/** A bare dotted-quad IPv4 address, each octet 0-255 with no leading zero, and nothing else. */
export const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

/** The host-key algorithms a worker's `known_hosts` entry can carry; anything else is not copied. */
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const KEY_BLOB = /^[A-Za-z0-9+/]+={0,2}$/;

/** The handshake budget for one probe; a worker that cannot complete one in this long is not identified. */
const PROBE_CONNECT_TIMEOUT_S = 10;

/**
 * @typedef {{ type: string, blob: string }} HostKey
 * @typedef {{ name: string, address: string }} Placed a worker and the address it is (or will be) aimed at
 */

/**
 * @param {string} text
 * @param {RegExp} shape
 * @param {string} what
 */
function mustMatch(text, shape, what) {
  if (!shape.test(text)) throw new Error(`refusing to build a command from ${what} ${JSON.stringify(text)}`);
}

// --- the override: an address, and the check that goes with it, in ONE host block --------------------------

/**
 * THE PER-RUN ADDRESS OVERRIDE, as an inventory source of its own -- the only way an address other than the
 * pin reaches Ansible, and never the inventory file.
 *
 * Every key is an inventory worker and every value a bare IPv4 address, or this THROWS before anything is
 * written (`lab-job.yml` asserts the same shape for `resolved_addresses`, and for the same reason: nothing
 * here may be settable from a command line). Each entry ALSO sets `a11y_strict_host_key: "yes"`, which
 * `group_vars/a11y_workers.yml` turns into `StrictHostKeyChecking=yes`: the address and its check are one
 * object, so a caller cannot take the one without the other.
 *
 * @param {{ addresses: Record<string, string>, workers: string[] }} input `workers` = the inventory's names
 * @returns {string | null} the YAML, or `null` when nothing moved (a healthy fleet adds no source at all)
 */
export function overrideInventory({ addresses, workers }) {
  const entries = Object.entries(addresses);
  if (!entries.length) return null;
  for (const [name, address] of entries) {
    if (!workers.includes(name)) throw new Error(`refusing an address override for ${JSON.stringify(name)}: not an inventory worker`);
    mustMatch(name, WORKER_NAME, "a worker name");
    mustMatch(address, IPV4, "an address");
  }
  return ["# Per-run address override from fleet-playbook.mjs (#2832). Not the inventory: a moved worker is aimed",
    "# here for THIS run only, with the strict host-key check that goes with it. #2752 is the durable fix.",
    "all:", "  hosts:",
    ...entries.flatMap(([name, address]) => [`    ${name}:`, `      ansible_host: ${address}`,
      "      a11y_strict_host_key: \"yes\""]),
    ""].join("\n");
}

/** Where a unit's override lives: tmpfs, per unit, so two playbooks never share one and a reboot clears it. */
export const overridePath = (/** @type {string} */ unit) => {
  mustMatch(unit, /^a11y-fleet-[a-z0-9-]+$/, "a unit name");
  return `/run/${unit}.addresses.yml`;
};

/**
 * The shell that makes `path` hold exactly `yaml` -- or nothing, when `yaml` is null -- BEFORE the unit
 * starts, so a stale override from an earlier run can never aim this one. base64 keeps the text out of the
 * shell's grammar entirely; the alphabet cannot carry a metacharacter.
 *
 * @param {{ path: string, yaml: string | null }} input
 * @returns {string}
 */
export function installOverrideCommand({ path, yaml }) {
  mustMatch(path, /^\/run\/a11y-fleet-[a-z0-9-]+\.addresses\.yml$/, "an override path");
  if (yaml === null) return `rm -f ${path}`;
  return `rm -f ${path} && printf %s ${Buffer.from(yaml).toString("base64")} | base64 -d > ${path}`;
}

/**
 * `ANSIBLE_INVENTORY` for a run with an override: the sources `ansible.cfg` already lists, in its order, then
 * the override LAST (a later source's host vars win). An explicit `-i` would REPLACE the config's list, which
 * is the trap `startPlaybookUnit`'s own comment records; the environment variable carries the same risk, so
 * the whole list is restated from the config's own parse, never a hand-copied one.
 *
 * @param {{ sources: string[], path: string }} input
 * @returns {string}
 */
export function inventoryEnvironment({ sources, path }) {
  for (const source of [...sources, path]) mustMatch(source, /^[A-Za-z0-9_./-]+$/, "an inventory path");
  return [...sources, path].join(",");
}

// --- seeding: record an alias entry from a key already recorded for the CURRENT pin -----------------------

/**
 * `ssh-keygen -F`'s output, read for the keys it found. `#` lines are its own commentary, and a line that
 * starts with `@` (`@revoked`, `@cert-authority`) is a MARKER, never a plain trusted key: skipped, so a
 * revoked key can never be copied under a name. A key whose algorithm or body is not the shape of one is
 * dropped for the same reason `overrideInventory` refuses a malformed address.
 *
 * @param {string} output
 * @returns {HostKey[]}
 */
export function recordedKeys(output) {
  /** @type {HostKey[]} */
  const keys = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith("#") || line.startsWith("@")) continue;
    const [, type, blob] = line.trim().split(/\s+/);
    if (KEY_TYPE.test(type ?? "") && KEY_BLOB.test(blob ?? "") && !keys.some((k) => k.type === type && k.blob === blob)) {
      keys.push({ type, blob });
    }
  }
  return keys;
}

/**
 * One read of the control plane's `known_hosts`: what is recorded under each worker's NAME and under its
 * current PIN. `ssh-keygen -F` is the reader, so hashed entries (`HashKnownHosts`) work too, and it writes
 * nothing.
 *
 * @param {Placed[]} workers each worker with its PIN address
 * @returns {string}
 */
export function knownHostsReadScript(workers) {
  return workers.map(({ name, address }) => {
    mustMatch(name, WORKER_NAME, "a worker name");
    mustMatch(address, IPV4, "a pin address");
    return `echo '=== ${name} alias'; ssh-keygen -F ${name} 2>/dev/null; echo '=== ${name} pin'; ssh-keygen -F ${address} 2>/dev/null`;
  }).join("; ") + "; true";
}

/**
 * @param {string} stdout what `knownHostsReadScript` printed
 * @returns {Map<string, { alias: HostKey[], pin: HostKey[] }>}
 */
export function parseKnownHostsRead(stdout) {
  /** @type {Map<string, { alias: string, pin: string }>} */
  const raw = new Map();
  /** @type {{ name: string, part: "alias" | "pin" } | null} */
  let at = null;
  for (const line of stdout.split("\n")) {
    const header = /^=== (a11y-worker-[0-9]{1,3}) (alias|pin)$/.exec(line);
    if (header) {
      at = { name: header[1], part: /** @type {"alias" | "pin"} */ (header[2]) };
      if (!raw.has(at.name)) raw.set(at.name, { alias: "", pin: "" });
    } else if (at) {
      /** @type {{ alias: string, pin: string }} */ (raw.get(at.name))[at.part] += `${line}\n`;
    }
  }
  return new Map([...raw].map(([name, { alias, pin }]) => [name, { alias: recordedKeys(alias), pin: recordedKeys(pin) }]));
}

/**
 * WHICH WORKERS GET AN ALIAS ENTRY, and why each other one does not. PURE.
 *
 * A name is seeded ONLY from a key `known_hosts` already records for that worker's CURRENT pin, and only
 * while that pin answers -- "the key at this address is the key I saw at this address" is the one identity
 * claim the control plane has today, and the alias carries it from the address to the name. A worker that
 * is silent at its pin is NOT seeded (it may have moved, and an entry for the old address says nothing
 * about whoever answers there now), and one with no recorded key has nothing to seed from. Both are
 * REPORTED, never filled in from a scan.
 *
 * @param {{ workers: Placed[], answering: Set<string>,
 *           records: Map<string, { alias: HostKey[], pin: HostKey[] }> }} input
 * @returns {{ lines: string[], seeded: string[], already: string[], notSeeded: { name: string, why: string }[] }}
 */
export function seedPlan({ workers, answering, records }) {
  /** @type {string[]} */ const lines = [];
  /** @type {string[]} */ const seeded = [];
  /** @type {string[]} */ const already = [];
  /** @type {{ name: string, why: string }[]} */ const notSeeded = [];
  for (const { name, address } of workers) {
    const { alias, pin } = records.get(name) ?? { alias: [], pin: [] };
    if (alias.length) already.push(name);
    else if (!answering.has(name)) {
      notSeeded.push({ name, why: `its pin ${address} does not answer, so a key recorded for that address is not known to be this box's` });
    } else if (!pin.length) {
      notSeeded.push({ name, why: `no host key is recorded for its pin ${address} yet (its first connection records one)` });
    } else {
      lines.push(...pin.map(({ type, blob }) => `${name} ${type} ${blob}`));
      seeded.push(name);
    }
  }
  return { lines, seeded, already, notSeeded };
}

/**
 * The shell that appends the planned lines. Each is shape-checked (a worker name, an algorithm, a base64
 * body), so no quote or newline can be in one, and the file is only ever APPENDED to.
 *
 * @param {string[]} lines `seedPlan(...).lines`
 * @returns {string | null} `null` when there is nothing to record
 */
export function seedCommand(lines) {
  if (!lines.length) return null;
  for (const line of lines) mustMatch(line, /^a11y-worker-[0-9]{1,3} [A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,2}$/, "a known_hosts line");
  return `umask 077; mkdir -p "\${HOME:?}/.ssh" && printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")} >> "\${HOME:?}/.ssh/known_hosts"`;
}

/**
 * @param {ReturnType<typeof seedPlan>} plan
 * @returns {string[]} what to print, one line per worker seeded or not
 */
export function seedReport({ seeded, notSeeded }) {
  return [
    ...seeded.map((name) => `  host key: recorded ${name} by NAME, from the key already recorded for its pin`),
    ...notSeeded.map(({ name, why }) => `  host key: ${name} NOT seeded by name -- ${why}`),
  ];
}

// --- the identity check: a strict handshake, by name, at the address a worker would be aimed at ------------

/**
 * ONE STRICT HANDSHAKE PER MOVED WORKER, run on the control plane, as the connection Ansible will make:
 * the same `known_hosts`, the same alias, `StrictHostKeyChecking=yes`. It offers NO authentication
 * (`PreferredAuthentications=none`, `BatchMode`), so the verdict is the host-key check and nothing else:
 * a box whose key matches the name's record ends in `Permission denied` (it verified, then refused us), a
 * box whose key does not ends in `Host key verification failed`. `ControlPath=none` matters: a probe that
 * rode a live master would be shown the OLD box's verification (see `group_vars/a11y_workers.yml`).
 *
 * Output, one line per worker: `name<TAB>1|0<TAB>what ssh said`, where the 1/0 is whether ANY key is
 * recorded under the name -- the difference between "unseeded" and "mismatch".
 *
 * @param {Placed[]} moved each moved worker with the address it was found at
 * @returns {string}
 */
export function identityProbeScript(moved) {
  const probes = moved.map(({ name, address }) => {
    mustMatch(name, WORKER_NAME, "a worker name");
    mustMatch(address, IPV4, "an address");
    return `probe ${name} ${address}`;
  });
  const flags = ["-o BatchMode=yes", "-o PreferredAuthentications=none", "-o StrictHostKeyChecking=yes",
    "-o UpdateHostKeys=no", "-o ControlMaster=no", "-o ControlPath=none", `-o ConnectTimeout=${PROBE_CONNECT_TIMEOUT_S}`,
    "-p 22", "-N"].join(" ");
  return ["export LC_ALL=C",
    `probe() { rec=0; ssh-keygen -F "$1" >/dev/null 2>&1 && rec=1; `
      + `out=$(ssh -o HostKeyAlias="$1" ${flags} "$2" </dev/null 2>&1 | tr '\\n' ' '); `
      + `printf '%s\\t%s\\t%s\\n' "$1" "$rec" "$out"; }`,
    ...probes, "true"].join("; ");
}

/**
 * @typedef {"verified" | "unseeded" | "mismatch" | "unreachable"} IdentityVerdict
 */

/**
 * @param {string} stdout what `identityProbeScript` printed
 * @returns {Map<string, { verdict: IdentityVerdict, detail: string }>}
 */
export function parseIdentityProbe(stdout) {
  /** @type {Map<string, { verdict: IdentityVerdict, detail: string }>} */
  const verdicts = new Map();
  for (const line of stdout.split("\n")) {
    const [name, recorded, ...said] = line.split("\t");
    if (!WORKER_NAME.test(name ?? "")) continue;
    const detail = said.join("\t").trim();
    verdicts.set(name, { verdict: verdictOf({ recorded: recorded === "1", said: detail }), detail });
  }
  return verdicts;
}

/**
 * ANYTHING THAT IS NOT A POSITIVE "PERMISSION DENIED" IS NOT IDENTIFIED. A handshake that timed out, was
 * refused or printed something unforeseen is `unreachable`, never `verified`: absence of a complaint is not
 * a pass (an unseeded box can print the same quiet text on some failures).
 *
 * @param {{ recorded: boolean, said: string }} input
 * @returns {IdentityVerdict}
 */
function verdictOf({ recorded, said }) {
  if (!recorded) return "unseeded";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(said)) return "mismatch";
  return /Permission denied/i.test(said) ? "verified" : "unreachable";
}

const WHY = {
  unseeded: (/** @type {string} */ name) => `no host key is recorded under the name ${name} on the control plane, so nothing can say who answers`,
  mismatch: (/** @type {string} */ name) => `the key that answers is NOT the one recorded under the name ${name}`
    + ` (a different machine, or a reinstall: re-trust is a deliberate human act, \`ssh-keygen -R ${name}\`)`,
  unreachable: () => "the strict handshake could not be completed there",
};

/**
 * THE DECISION, pure: which moved workers are aimed at their resolved address, and whether the whole run is
 * refused. WRITE SEMANTICS (the header of `fleet-playbook.mjs`): a deploy that quietly lands on eleven of
 * twelve leaves the fleet INCONSISTENT, so one worker that cannot be identified refuses the WHOLE run, by
 * name and by reason -- and `--allow-offline=<name>`, `linkGate`'s own shape, is how a human proceeds
 * without it (that worker is then not aimed anywhere: Ansible reports it UNREACHABLE at its pin).
 *
 * @param {{ moved: { name: string, movedTo: string, pin?: string }[], allowOffline: string[],
 *           verdicts: Map<string, { verdict: IdentityVerdict, detail: string }> }} input
 * @returns {{ refusal: string | null, notice: string | null, addresses: Record<string, string> }}
 */
export function identityGate({ moved, allowOffline, verdicts }) {
  /** @type {Record<string, string>} */ const addresses = {};
  /** @type {string[]} */ const left = [];
  /** @type {string[]} */ const unidentified = [];
  for (const { name, movedTo, pin } of moved) {
    const found = verdicts.get(name) ?? { verdict: /** @type {IdentityVerdict} */ ("unreachable"), detail: "no verdict was read" };
    if (allowOffline.includes(name)) left.push(`${name} (named with --allow-offline: not aimed at ${movedTo})`);
    else if (found.verdict === "verified") addresses[name] = movedTo;
    else unidentified.push(`  ${name}: found at ${movedTo}${pin ? `, pinned ${pin}` : ""}, NOT IDENTIFIED -- ${WHY[found.verdict](name)}.`);
  }
  if (unidentified.length) {
    return { refusal: ["REFUSING: a write must not land on a box whose identity was not verified (#2832). Nothing was written.",
      ...unidentified,
      "  A refusal of ONE worker is a refusal of the WHOLE run: a deploy that lands on some of the fleet leaves it INCONSISTENT.",
      "  To proceed without one deliberately, name it: --allow-offline=<name> (repeatable). It is then not aimed anywhere."].join("\n"),
    notice: null, addresses: {} };
  }
  const aimed = Object.entries(addresses).map(([name, address]) =>
    `  aiming ${name} at ${address} for this run: its host key, recorded under its name, was verified with `
    + "StrictHostKeyChecking=yes. inventory.yml is not rewritten (fix it, and ask for a DHCP reservation, #2752).");
  return { refusal: null, notice: [...aimed, ...left.map((entry) => `  leaving out ${entry}`)].join("\n") || null, addresses };
}
