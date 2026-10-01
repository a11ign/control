/**
 * #2832: what proves a moved worker's identity before a write lands. Every case is driven without a fleet:
 * the decision functions are pure, and the one shell script that does real work (`identityProbeScript`) is
 * run against stub `ssh`/`ssh-keygen` binaries that record their argv, so the flags it builds are asserted
 * on the command that would actually run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { overrideInventory, overridePath, installOverrideCommand, inventoryEnvironment, recordedKeys,
  knownHostsReadScript, parseKnownHostsRead, seedPlan, seedCommand, seedReport, identityProbeScript,
  parseIdentityProbe, identityGate, WORKER_NAME, IPV4 } from "./fleet-host-identity.mjs";

const KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const FLEET = [2, 3, 4].map((n) => ({ name: `a11y-worker-${n}`, address: `192.0.2.1${n}` }));

// --- the override: an address and its check are one object ------------------------------------------------

test("the override gives every moved worker its address AND the strict flag, in the same host block", () => {
  const yaml = String(overrideInventory({
    addresses: { "a11y-worker-3": "192.0.2.99", "a11y-worker-6": "192.0.2.96" },
    workers: ["a11y-worker-3", "a11y-worker-6", "a11y-worker-4"] }));
  const blocks = yaml.split(/^ {4}(?=a11y-worker-)/m).slice(1);
  assert.equal(blocks.length, 2, "positive control: both moved workers are present, so the loop below checks something");
  for (const block of blocks) {
    assert.match(block, /ansible_host: \d+\.\d+\.\d+\.\d+/, block);
    assert.match(block, /a11y_strict_host_key: "yes"/, `an address without its strict check is the unsafe state: ${block}`);
  }
  assert.doesNotMatch(yaml, /a11y-worker-4/, "a worker that did not move is not in the override");
});

test("nothing moved adds NO source: a healthy fleet's invocation is what it was", () => {
  assert.equal(overrideInventory({ addresses: {}, workers: ["a11y-worker-3"] }), null);
  assert.equal(installOverrideCommand({ path: overridePath("a11y-fleet-deploy"), yaml: null }),
    "rm -f /run/a11y-fleet-deploy.addresses.yml", "and a stale file from an earlier run is removed, not left to aim this one");
});

test("an override cannot name a non-worker or carry anything but a bare IPv4 address", () => {
  const workers = ["a11y-worker-3"];
  for (const address of ["192.0.2.99:9999", "evil.example", "", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "...", "192.0.2.1\nx: 1",
    "192.0.2.1 # c", "192.0.2.1'; rm -rf /"]) {
    assert.throws(() => overrideInventory({ addresses: { "a11y-worker-3": address }, workers }), /refusing to build/, JSON.stringify(address));
  }
  for (const name of ["not-a-worker", "a11y-worker-3\n  evil", "a11y-worker-9"]) {
    assert.throws(() => overrideInventory({ addresses: { [name]: "192.0.2.99" }, workers }), /refusing/, JSON.stringify(name));
  }
  assert.ok(IPV4.test("192.0.2.99") && IPV4.test("0.0.0.0") && IPV4.test("255.255.255.255"), "positive control: the shape accepts real addresses");
  assert.ok(WORKER_NAME.test("a11y-worker-10"));
});

test("the override file is written without the shell ever seeing its text, and read LAST so it wins", () => {
  const yaml = String(overrideInventory({ addresses: { "a11y-worker-3": "192.0.2.99" }, workers: ["a11y-worker-3"] }));
  const command = installOverrideCommand({ path: "/run/a11y-fleet-deploy.addresses.yml", yaml });
  const encoded = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)?.[1] ?? "";
  assert.equal(Buffer.from(encoded, "base64").toString(), yaml);
  assert.throws(() => installOverrideCommand({ path: "/etc/passwd", yaml }), /refusing/);
  assert.throws(() => overridePath("a11y-fleet-x; reboot"), /refusing/);
  assert.equal(inventoryEnvironment({ sources: ["/etc/a11ign/inventory.yml", "/opt/x/inventory.yml"], path: "/run/a11y-fleet-deploy.addresses.yml" }),
    "/etc/a11ign/inventory.yml,/opt/x/inventory.yml,/run/a11y-fleet-deploy.addresses.yml");
  assert.throws(() => inventoryEnvironment({ sources: ["/etc/x;reboot"], path: "/run/a11y-fleet-d.addresses.yml" }), /refusing/);
});

// --- seeding ----------------------------------------------------------------------------------------------

test("recordedKeys reads ssh-keygen -F output, hashed or plain, and never copies a marker or a malformed key", () => {
  const output = [
    "# Host 192.0.2.13 found: line 4", `192.0.2.13 ssh-ed25519 ${KEY_A}`,
    `|1|c2FsdA==|aGFzaA== ecdsa-sha2-nistp256 ${KEY_B} a comment`,
    `@revoked 192.0.2.13 ssh-ed25519 ${KEY_B}`, `@cert-authority 192.0.2.13 ssh-ed25519 ${KEY_B}`,
    `192.0.2.13 ssh-evil ${KEY_A}`, "192.0.2.13 ssh-ed25519 not*base64!", `192.0.2.13 ssh-ed25519 ${KEY_A}`, "", "192.0.2.13",
  ].join("\n");
  assert.deepEqual(recordedKeys(output), [{ type: "ssh-ed25519", blob: KEY_A }, { type: "ecdsa-sha2-nistp256", blob: KEY_B }]);
  assert.deepEqual(recordedKeys(""), []);
});

test("the known_hosts read names each worker's alias and pin, and parses back per worker", () => {
  const script = knownHostsReadScript(FLEET);
  assert.match(script, /ssh-keygen -F a11y-worker-2 2>\/dev\/null;/);
  assert.match(script, /ssh-keygen -F 192\.0\.2\.12 2>\/dev\/null;/);
  assert.doesNotMatch(script, /ssh-keyscan/, "seeding never reads from a scan");
  const stdout = ["=== a11y-worker-2 alias", "=== a11y-worker-2 pin", `# Host x found`, `192.0.2.12 ssh-ed25519 ${KEY_A}`,
    "=== a11y-worker-3 alias", `a11y-worker-3 ssh-ed25519 ${KEY_B}`, "=== a11y-worker-3 pin"].join("\n");
  const records = parseKnownHostsRead(stdout);
  assert.deepEqual(records.get("a11y-worker-2"), { alias: [], pin: [{ type: "ssh-ed25519", blob: KEY_A }] });
  assert.deepEqual(records.get("a11y-worker-3"), { alias: [{ type: "ssh-ed25519", blob: KEY_B }], pin: [] });
  assert.throws(() => knownHostsReadScript([{ name: "a11y-worker-2; reboot", address: "192.0.2.12" }]), /refusing/);
});

const key = (blob: string) => ({ type: "ssh-ed25519", blob });

test("seeding records a name ONLY from a key already recorded for its pin, while the pin answers", () => {
  const records = new Map([
    ["a11y-worker-2", { alias: [key(KEY_A)], pin: [key(KEY_A)] }],   // already seeded
    ["a11y-worker-3", { alias: [], pin: [key(KEY_A)] }],             // answers, has a pin key: SEED
    ["a11y-worker-4", { alias: [], pin: [key(KEY_B)] }],             // has a pin key but is SILENT: not seeded
  ]);
  const plan = seedPlan({ workers: [...FLEET, { name: "a11y-worker-5", address: "192.0.2.15" }],
    answering: new Set(["a11y-worker-2", "a11y-worker-3", "a11y-worker-5"]), records });
  assert.deepEqual(plan.lines, [`a11y-worker-3 ssh-ed25519 ${KEY_A}`], "the line is the pin's recorded key under the NAME, nothing else");
  assert.deepEqual(plan.seeded, ["a11y-worker-3"]);
  assert.deepEqual(plan.already, ["a11y-worker-2"]);
  assert.deepEqual(plan.notSeeded.map(({ name }) => name), ["a11y-worker-4", "a11y-worker-5"], "each worker it could not seed is reported");
  assert.match(plan.notSeeded[0].why, /does not answer/);
  assert.match(plan.notSeeded[1].why, /no host key is recorded for its pin/);
  assert.equal(seedReport(plan).length, 3, "one line per worker seeded or not; the already-seeded one is silent");
});

test("the seeding command only ever APPENDS shape-checked lines, and nothing to record is no command", () => {
  assert.equal(seedCommand([]), null);
  const command = String(seedCommand([`a11y-worker-3 ssh-ed25519 ${KEY_A}`]));
  assert.match(command, /printf '%s\\n' 'a11y-worker-3 ssh-ed25519 [A-Za-z0-9+/]+' >> "\$\{HOME:\?\}\/\.ssh\/known_hosts"$/);
  assert.doesNotMatch(command.replace(/>>/g, ""), />/, "the only redirect is an append, so an existing record is never overwritten");
  for (const line of [`a11y-worker-3 ssh-ed25519 ${KEY_A}'; reboot; '`, `a11y-worker-3 ssh-ed25519 ${KEY_A}\nevil ssh-rsa ${KEY_B}`,
    `evil ssh-ed25519 ${KEY_A}`]) {
    assert.throws(() => seedCommand([line]), /refusing/, JSON.stringify(line));
  }
});

// --- the identity probe, as the shell that really runs ----------------------------------------------------

/** Stub `ssh` and `ssh-keygen`: each logs its argv; answers are keyed by the address (ssh) or name (ssh-keygen). */
function runProbe(moved: { name: string, address: string }[], { said, recorded }: { said: Record<string, string>, recorded: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "a11y-identity-"));
  try {
    const log = join(dir, "ssh-argv.log");
    const cases = Object.entries(said).map(([address, text]) => `  *" ${address}") printf '%s\\n' '${text}' >&2; exit 255;;`).join("\n");
    writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase " $*" in\n${cases}\n  *) exit 255;;\nesac\n`);
    writeFileSync(join(dir, "ssh-keygen"), `#!/bin/sh\ncase "$2" in ${recorded.join("|") || "__none__"}) exit 0;; esac\nexit 1\n`);
    chmodSync(join(dir, "ssh"), 0o755);
    chmodSync(join(dir, "ssh-keygen"), 0o755);
    const run = spawnSync("sh", ["-c", identityProbeScript(moved)], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } });
    const argv = (() => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } })();
    return { stdout: run.stdout, argv, status: run.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DENIED = "witness@192.0.2.99: Permission denied (publickey,keyboard-interactive).";
const MOVED = [{ name: "a11y-worker-3", address: "192.0.2.99" }, { name: "a11y-worker-4", address: "192.0.2.98" },
  { name: "a11y-worker-5", address: "192.0.2.97" }, { name: "a11y-worker-6", address: "192.0.2.96" }];

test("the probe is ONE strict, unauthenticated, un-multiplexed handshake per worker, by NAME, and each verdict is its own", () => {
  const { stdout, argv, status } = runProbe(MOVED, {
    recorded: ["a11y-worker-3", "a11y-worker-4", "a11y-worker-6"],
    said: { "192.0.2.99": DENIED, "192.0.2.98": "Host key verification failed.",
      "192.0.2.96": "ssh: connect to host 192.0.2.96 port 22: Connection timed out" } });
  assert.equal(status, 0);
  assert.equal(argv.length, 4, "positive control: every worker was probed, so the flag checks below look at real commands");
  for (const [index, { name, address }] of MOVED.entries()) {
    const line = argv[index];
    for (const flag of [`HostKeyAlias=${name}`, "StrictHostKeyChecking=yes", "ControlPath=none", "ControlMaster=no",
      "PreferredAuthentications=none", "BatchMode=yes", "UpdateHostKeys=no"]) {
      assert.ok(line.includes(`-o ${flag}`), `${name}: missing -o ${flag} in: ${line}`);
    }
    assert.ok(line.endsWith(` ${address}`), `${name}: aimed at ${address}: ${line}`);
  }
  const verdicts = parseIdentityProbe(stdout);
  assert.equal(verdicts.get("a11y-worker-3")?.verdict, "verified");
  assert.equal(verdicts.get("a11y-worker-4")?.verdict, "mismatch");
  assert.equal(verdicts.get("a11y-worker-5")?.verdict, "unseeded", "no record under the name: unseeded, whatever ssh then says");
  assert.equal(verdicts.get("a11y-worker-6")?.verdict, "unreachable", "a timeout is NOT a pass");
});

test("a silent handshake is not a verification: only a positive 'Permission denied' verifies", () => {
  const verdicts = parseIdentityProbe(["a11y-worker-3\t1\t", "a11y-worker-4\t1\tsomething unforeseen",
    "a11y-worker-5\t1\tREMOTE HOST IDENTIFICATION HAS CHANGED!", "a11y-worker-6\t1\tPermission denied (publickey)."].join("\n"));
  assert.deepEqual([...verdicts].map(([name, { verdict }]) => `${name}:${verdict}`),
    ["a11y-worker-3:unreachable", "a11y-worker-4:unreachable", "a11y-worker-5:mismatch", "a11y-worker-6:verified"]);
});

// --- the decision -----------------------------------------------------------------------------------------

const verdict = (v: string) => ({ verdict: v as "verified", detail: v });
const MOVED_TWO = [{ name: "a11y-worker-3", movedTo: "192.0.2.99", pin: "192.0.2.13" }, { name: "a11y-worker-6", movedTo: "192.0.2.96", pin: "192.0.2.16" }];

test("every moved worker identified: each is aimed at its resolved address, and the notice says so", () => {
  const result = identityGate({ moved: MOVED_TWO, allowOffline: [],
    verdicts: new Map([["a11y-worker-3", verdict("verified")], ["a11y-worker-6", verdict("verified")]]) });
  assert.equal(result.refusal, null);
  assert.deepEqual(result.addresses, { "a11y-worker-3": "192.0.2.99", "a11y-worker-6": "192.0.2.96" });
  assert.match(String(result.notice), /aiming a11y-worker-3 at 192\.0\.2\.99.*StrictHostKeyChecking=yes.*inventory\.yml is not rewritten/);
});

test("ONE unidentified worker refuses the WHOLE run by name and aims NOBODY, even a worker that verified", () => {
  for (const bad of ["unseeded", "mismatch", "unreachable"]) {
    const result = identityGate({ moved: MOVED_TWO, allowOffline: [],
      verdicts: new Map([["a11y-worker-3", verdict(bad)], ["a11y-worker-6", verdict("verified")]]) });
    assert.match(String(result.refusal), /a11y-worker-3: found at 192\.0\.2\.99, pinned 192\.0\.2\.13, NOT IDENTIFIED/, bad);
    assert.doesNotMatch(String(result.refusal), /a11y-worker-6: found/, "the verified one is not named as a failure");
    assert.deepEqual(result.addresses, {}, `${bad}: a smaller-than-asked pool without saying so is the failure; the run is refused`);
    assert.match(String(result.refusal), /Nothing was written/);
    assert.match(String(result.refusal), /--allow-offline=<name>/);
  }
  assert.match(String(identityGate({ moved: MOVED_TWO, allowOffline: [], verdicts: new Map([["a11y-worker-3", verdict("mismatch")]]) }).refusal),
    /ssh-keygen -R a11y-worker-3/, "re-trust is a named human act, never automatic");
  assert.match(String(identityGate({ moved: MOVED_TWO, allowOffline: [], verdicts: new Map() }).refusal), /no verdict was read|could not be completed/,
    "a worker with no verdict at all is not identified");
});

test("--allow-offline=<name> proceeds WITHOUT that worker: it is not aimed anywhere, the rest are", () => {
  const result = identityGate({ moved: MOVED_TWO, allowOffline: ["a11y-worker-3"],
    verdicts: new Map([["a11y-worker-6", verdict("verified")]]) });
  assert.equal(result.refusal, null);
  assert.deepEqual(result.addresses, { "a11y-worker-6": "192.0.2.96" });
  assert.match(String(result.notice), /leaving out a11y-worker-3 \(named with --allow-offline: not aimed at 192\.0\.2\.99\)/);
});
